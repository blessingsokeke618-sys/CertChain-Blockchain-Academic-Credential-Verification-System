import { getE2eState, updateE2eState, type E2eState } from './e2e';
import type { StellarSigner } from './stellarSigner';

/**
 * The single E2E seam for on-chain work (ACREDIA-STELLAR#3).
 *
 * `contracts.ts` used to carry six separate `getE2eState()` early returns —
 * one inside every exported function. Each re-implemented the business logic it
 * was bypassing (authorization checks, token-id sequencing), purely so the
 * browser suite never reached a wallet. That is two copies of the rules, and
 * only one of them was the real one.
 *
 * Everything E2E-specific now lives here, behind two seams:
 *
 *  - {@link createE2eSigner} — a signer for the four *writing* functions. The
 *    fake signs nothing and submits nothing; it records what it was asked to do
 *    and returns the hash the suite expects.
 *  - {@link e2eLedgerReads} — the two *read-only* functions
 *    (`getContractOwner`, `isAuthorizedIssuer`) never sign, so a signer is the
 *    wrong tool. They ask this instead.
 *
 * Authorization is decided in exactly one place ({@link isAuthorizedInE2eState})
 * rather than three, so the fake ledger can no longer disagree with itself.
 */

/** Marks a signer as the E2E fake, so `contracts.ts` can take the fake path. */
const E2E_SIGNER = Symbol.for('certchain.e2e.signer');

export interface E2eSigner extends StellarSigner {
    readonly [E2E_SIGNER]: true;
}

/** True when this signer is the E2E fake. */
export function isE2eSigner(signer: StellarSigner): signer is E2eSigner {
    return (signer as Partial<E2eSigner>)[E2E_SIGNER] === true;
}

/**
 * Whether an address may issue, according to the seeded E2E state.
 *
 * The contract owner is implicitly authorized, matching
 * `AcrediaCredential`'s own rule. Comparison is case-insensitive because
 * fixtures are hand-written and a casing mismatch here would look like an
 * authorization bug rather than a typo.
 *
 * This is the one definition. It previously existed three times — in
 * `isAuthorizedIssuer`, `issueCredentialOnStellar` and
 * `batchIssueCredentialOnStellar` — which is three chances to drift.
 */
export function isAuthorizedInE2eState(state: E2eState, issuerAddress: string): boolean {
    const target = issuerAddress.toLowerCase();

    if (state.contractOwner && state.contractOwner.toLowerCase() === target) {
        return true;
    }

    return Boolean(state.authorizedIssuers?.some((value) => value.toLowerCase() === target));
}

/**
 * A signer that stands in for a wallet under Playwright.
 *
 * `signTransaction` throws rather than returning a plausible XDR: nothing
 * should ever reach it. `contracts.ts` checks {@link isE2eSigner} before
 * building a transaction, so arriving here means a code path lost its fake and
 * would otherwise have silently talked to a real ledger with an unsigned
 * transaction.
 */
export function createE2eSigner(address: string): E2eSigner {
    return {
        [E2E_SIGNER]: true,
        address,
        async signTransaction(): Promise<string> {
            throw new Error(
                'The E2E signer was asked to sign a real transaction. A contract function ' +
                    'reached the ledger path while E2E state was enabled — check its isE2eSigner guard.',
            );
        },
        async signMessage(message: string): Promise<string> {
            return Buffer.from(`e2e-signature:${message}`).toString('base64');
        },
    };
}

/** Read-only answers from the seeded E2E state, for functions that never sign. */
export const e2eLedgerReads = {
    /** Returns the seeded contract owner, or null when E2E is not driving. */
    contractOwner(): string | null {
        const state = getE2eState();
        if (!state?.enabled) return null;
        return state.contractOwner ?? null;
    },

    /**
     * Returns the seeded authorization verdict, or null when E2E is not
     * driving.
     *
     * `null` rather than `false` for "not applicable": a boolean would make
     * "E2E says no" indistinguishable from "E2E is off", and the caller must
     * fall through to the real ledger in the second case.
     */
    isAuthorizedIssuer(issuerAddress: string): boolean | null {
        const state = getE2eState();
        if (!state?.enabled) return null;
        return isAuthorizedInE2eState(state, issuerAddress);
    },
};

/**
 * The fake ledger's write side: what each contract call does to E2E state.
 *
 * These return the same shapes the real functions do, so `contracts.ts` can
 * return them directly and the browser suite sees no difference.
 */
export const e2eLedgerWrites = {
    authorizeIssuer(adminAddress: string, issuerAddress: string): string {
        updateE2eState((state) => {
            state.contractOwner = state.contractOwner || adminAddress;
            state.authorizedIssuers ??= [];
            if (!state.authorizedIssuers.includes(issuerAddress)) {
                state.authorizedIssuers.push(issuerAddress);
            }
            if (state.stats) {
                state.stats.authorizedInstitutions = state.authorizedIssuers.length;
            }
        });
        return 'e2e-authorize-tx';
    },

    /**
     * Issues one credential, enforcing the same authorization rule the contract
     * does — the suite asserts on the unauthorized path, so the fake has to
     * refuse too.
     */
    issueCredential(issuerAddress: string): { tokenId: string; transactionHash: string } {
        const state = requireEnabledState();

        if (!isAuthorizedInE2eState(state, issuerAddress)) {
            throw new Error('Your wallet is not authorized to issue credentials.');
        }

        const tokenId = String(state.nextTokenId ?? 1);
        updateE2eState((draft) => {
            draft.nextTokenId = (draft.nextTokenId ?? 1) + 1;
        });

        return { tokenId, transactionHash: `e2e-tx-${tokenId}` };
    },

    /** Issues a batch, sequencing token ids exactly as the contract would. */
    batchIssueCredential(
        issuerAddress: string,
        itemCount: number,
    ): { transactionHash: string; startTokenId: number } {
        const state = requireEnabledState();

        if (!isAuthorizedInE2eState(state, issuerAddress)) {
            throw new Error('Your wallet is not authorized to issue credentials.');
        }

        const startTokenId = state.nextTokenId ?? 1;
        updateE2eState((draft) => {
            draft.nextTokenId = startTokenId + itemCount;
        });

        return { transactionHash: `e2e-batch-tx-${startTokenId}`, startTokenId };
    },

    revokeCredential(tokenId: string): string {
        return `e2e-revoke-${tokenId}`;
    },
};

/**
 * The enabled E2E state, or a thrown error.
 *
 * Callers only reach the write helpers after an {@link isE2eSigner} check, so a
 * missing state here means the fake signer outlived the state that created it —
 * a bug worth surfacing rather than absorbing.
 */
function requireEnabledState(): E2eState {
    const state = getE2eState();
    if (!state?.enabled) {
        throw new Error(
            'An E2E signer was used without enabled E2E state. The fake ledger has nothing to act on.',
        );
    }
    return state;
}
