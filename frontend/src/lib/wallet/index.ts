/**
 * The wallet entry point for the rest of the app.
 *
 * Wraps the real adapter with the E2E short-circuit so that neither the
 * adapter nor its callers have to know about test state. Import
 * `walletAdapter` from here; import the concrete kit adapter from nowhere.
 */

import { getE2eState, updateE2eState } from '@/lib/e2e';
import { stellarKitAdapter, walletNameFor } from './adapter';
import { capabilitiesFor } from './capabilities';
import type { ConnectedWallet, WalletAdapter } from './types';

export * from './types';
export { capabilitiesFor, supportsMessageSigning, WALLET_IDS } from './capabilities';
export { walletNameFor } from './adapter';
export {
    advisePlatform,
    isDesktopExtensionOnly,
    isMobileBrowser,
    isMobileCapable,
    type MobileBlockReason,
    type PlatformAdvice,
} from './platform';

/**
 * The wallet the browser suite pretends to be.
 *
 * Freighter, because the E2E fixtures predate multi-wallet support and the
 * point of those tests is the credential flow, not wallet selection. What
 * matters is that it is a *named* wallet with full capabilities, so the
 * capability-gated UI renders its normal path.
 */
const E2E_WALLET_ID = 'freighter';
const E2E_FALLBACK_ADDRESS = 'GE2ECONNECTEDWALLET000000000000000000000000000000000';

function e2eWallet(address: string): ConnectedWallet {
    return {
        address,
        walletId: E2E_WALLET_ID,
        walletName: walletNameFor(E2E_WALLET_ID),
        capabilities: capabilitiesFor(E2E_WALLET_ID),
    };
}

/**
 * The adapter the app uses.
 *
 * Every method checks for E2E state first. That check has to live here rather
 * than in the kit adapter: under Playwright there is no extension to talk to,
 * and the kit would block on a modal nobody can click.
 */
export const walletAdapter: WalletAdapter = {
    async connect() {
        const state = getE2eState();
        if (state?.enabled) {
            const address = state.walletAddress || E2E_FALLBACK_ADDRESS;
            updateE2eState((draft) => {
                draft.walletAddress = address;
            });
            return e2eWallet(address);
        }
        return stellarKitAdapter.connect();
    },

    async restore() {
        const state = getE2eState();
        if (state?.enabled) {
            return state.walletAddress ? e2eWallet(state.walletAddress) : null;
        }
        return stellarKitAdapter.restore();
    },

    async disconnect() {
        const state = getE2eState();
        if (state?.enabled) {
            updateE2eState((draft) => {
                draft.walletAddress = null;
            });
            return;
        }
        return stellarKitAdapter.disconnect();
    },

    async signTransaction(xdr, options) {
        if (getE2eState()?.enabled) {
            // The browser suite never submits to a real ledger; contracts.ts
            // has its own E2E path that returns before reaching a signer.
            return xdr;
        }
        return stellarKitAdapter.signTransaction(xdr, options);
    },

    async signMessage(message, options) {
        if (getE2eState()?.enabled) {
            return Buffer.from(`e2e-signature:${message}`).toString('base64');
        }
        return stellarKitAdapter.signMessage(message, options);
    },

    async listWallets() {
        if (getE2eState()?.enabled) {
            return [{ id: E2E_WALLET_ID, name: walletNameFor(E2E_WALLET_ID), isAvailable: true }];
        }
        return stellarKitAdapter.listWallets();
    },

    capabilitiesOf(walletId) {
        return capabilitiesFor(walletId);
    },
};
