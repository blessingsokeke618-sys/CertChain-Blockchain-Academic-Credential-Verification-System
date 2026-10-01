/**
 * The wallet boundary (ACREDIA-STELLAR#3, consumed by #272).
 *
 * Everything in the app that needs a wallet talks to this interface. Exactly
 * one module — `src/lib/wallet/adapter.ts` — implements it against a concrete
 * wallet library, so swapping or adding wallet support is a change in one
 * file rather than a rewrite scattered across contexts, contract calls and
 * page components.
 *
 * That boundary is enforced by lint: `@creit.tech/stellar-wallets-kit` and
 * `@stellar/freighter-api` are both banned imports everywhere except the
 * adapter (see eslint.config.mjs).
 */

/** A wallet the user can pick, as presented in the selection modal. */
export interface WalletOption {
    /** Stable id from the underlying kit (e.g. `freighter`, `xbull`). */
    id: string;
    name: string;
    /** False when the extension is not installed / the bridge is unreachable. */
    isAvailable: boolean;
}

/**
 * What a given wallet can actually do.
 *
 * Not every Stellar wallet implements every operation — Albedo and Rabet both
 * reject `signMessage` outright — and the claim flow is built entirely on
 * message signing. Capability is therefore something callers must be able to
 * ask about *before* sending the user down a path that will dead-end.
 */
export interface WalletCapabilities {
    signTransaction: boolean;
    signMessage: boolean;
}

/** The currently connected wallet, or null when nothing is connected. */
export interface ConnectedWallet {
    address: string;
    walletId: string;
    walletName: string;
    capabilities: WalletCapabilities;
}

export interface SignTransactionOptions {
    networkPassphrase: string;
    /** The address expected to sign; wallets use it to pick the right account. */
    address: string;
}

export interface SignMessageOptions {
    networkPassphrase: string;
    address: string;
}

/**
 * Raised when a caller asks a wallet for something it cannot do.
 *
 * Distinct from a signing failure: nothing went wrong, this wallet simply
 * does not implement the operation, and the fix is to use a different wallet
 * rather than to retry.
 */
export class WalletCapabilityError extends Error {
    readonly walletName: string;
    readonly capability: keyof WalletCapabilities;

    constructor(walletName: string, capability: keyof WalletCapabilities) {
        super(`${walletName} does not support ${capability}.`);
        this.name = 'WalletCapabilityError';
        this.walletName = walletName;
        this.capability = capability;
    }
}

/** Raised when the user dismisses a wallet prompt. Not an error state to report loudly. */
export class WalletUserRejectedError extends Error {
    constructor(message = 'Request was canceled in the wallet.') {
        super(message);
        this.name = 'WalletUserRejectedError';
    }
}

/**
 * The operations Acredia needs from a wallet.
 *
 * Deliberately narrow: `signAuthEntry`, fee-bump helpers and the kit's
 * submit-on-your-behalf path are all omitted because nothing here uses them,
 * and an unused method is a surface that silently rots.
 */
export interface WalletAdapter {
    /**
     * Opens wallet selection and connects to the user's choice.
     * Always driven by an explicit user action — never called on page load.
     */
    connect(): Promise<ConnectedWallet>;

    /**
     * Restores a previously-chosen wallet without prompting.
     *
     * Returns null when there is nothing to restore. This must never open a
     * wallet popup: it runs on page load, and a popup with no user gesture
     * behind it is both hostile and commonly blocked.
     */
    restore(): Promise<ConnectedWallet | null>;

    disconnect(): Promise<void>;

    /** Signs a base64 transaction XDR, returning the signed XDR. */
    signTransaction(xdr: string, options: SignTransactionOptions): Promise<string>;

    /** Signs a UTF-8 message, returning a base64 signature. */
    signMessage(message: string, options: SignMessageOptions): Promise<string>;

    /** Wallets offered in the selection modal, with availability resolved. */
    listWallets(): Promise<WalletOption[]>;

    /** What the given wallet can do. Answerable without connecting to it. */
    capabilitiesOf(walletId: string): WalletCapabilities;
}
