import { WALLET_IDS } from './capabilities';
import type { WalletOption } from './types';

/**
 * What a wallet can actually do on the device in front of the user
 * (ACREDIA-STELLAR#4).
 *
 * Nine of Acredia's ten wallets ship as desktop browser extensions. On a phone
 * they cannot be reached at all, and two of them make that worse by reporting
 * `isAvailable: true` regardless — measured in emulated mobile Chromium:
 *
 *     MOBILE iPhone 12 / Pixel 5 / 360px Android
 *       reported available: xBull, Albedo, HOT Wallet
 *       actually usable:    Albedo  (web-based, no install)
 *
 * And Albedo cannot sign messages, which is the one thing `/claim` needs — so
 * a student on a phone had no path to the credential issued to them, on the
 * device they were most likely to be holding.
 *
 * This module is the honest answer to "will this work here?", so the UI can
 * say so before the user taps through to a dead end.
 */

/**
 * Wallets reachable from a mobile browser.
 *
 * WalletConnect is the real one: the student scans a QR (or deep-links) into a
 * wallet app and signs there. Albedo is web-based so it loads, but it is
 * listed separately below because it cannot complete `/claim`.
 */
const MOBILE_CAPABLE: ReadonlySet<string> = new Set([
    WALLET_IDS.WALLET_CONNECT,
    WALLET_IDS.ALBEDO,
]);

/**
 * HOT Wallet is deliberately excluded despite reporting `isAvailable: true`.
 *
 * Its module returns `true` unconditionally — it never checks for anything — so
 * on a phone it looks like a working option and is not. Two blockers, read from
 * the kit's `hotwallet.module.js`:
 *
 *  - `getNetwork()` returns a hardcoded `Networks.PUBLIC`. On a testnet
 *    deployment that is a signature bound to the wrong ledger, which is worse
 *    than no option at all.
 *  - The module's own docblock: "requires that you have a `global` and a
 *    `Buffer` polyfill in your app, if not provided then this module will
 *    break your app." Acredia ships neither.
 *
 * Revisit if the app gains those polyfills *and* the module stops hardcoding
 * the network.
 */


/** Wallets distributed only as desktop browser extensions. */
const DESKTOP_EXTENSION_ONLY: ReadonlySet<string> = new Set([
    WALLET_IDS.HOT_WALLET,
    WALLET_IDS.FREIGHTER,
    WALLET_IDS.XBULL,
    WALLET_IDS.RABET,
    WALLET_IDS.LOBSTR,
    WALLET_IDS.HANA,
    WALLET_IDS.KLEVER,
    WALLET_IDS.ONEKEY,
    WALLET_IDS.BITGET,
]);

/**
 * Whether the current browser is a phone or small tablet.
 *
 * Deliberately not a viewport check: a narrow desktop window is still a
 * desktop, and telling that user their extensions are unavailable would be
 * wrong. Coarse pointer plus a touch-capable UA is what actually distinguishes
 * the device, and both are read defensively because this runs during connect —
 * a detection failure must never be what stops someone reaching their wallet.
 */
export function isMobileBrowser(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
        return false;
    }

    try {
        // `userAgentData` is the modern signal; Safari does not implement it,
        // hence the UA fallback.
        const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
            .userAgentData;
        if (typeof uaData?.mobile === 'boolean') {
            return uaData.mobile;
        }

        const ua = navigator.userAgent ?? '';
        if (/Android|iPhone|iPod|Windows Phone/i.test(ua)) return true;

        // iPadOS reports a desktop UA; touch points are what give it away.
        if (/iPad|Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;

        return false;
    } catch {
        // Treat an unreadable environment as desktop: the desktop path shows
        // every wallet, which is the less restrictive failure.
        return false;
    }
}

/** Whether a wallet can be reached from a mobile browser at all. */
export function isMobileCapable(walletId: string): boolean {
    return MOBILE_CAPABLE.has(walletId);
}

/** Whether a wallet is a desktop-only browser extension. */
export function isDesktopExtensionOnly(walletId: string): boolean {
    return DESKTOP_EXTENSION_ONLY.has(walletId);
}

/**
 * Narrows a wallet list to what the current device can actually use.
 *
 * On desktop this is a no-op. On mobile it removes the extensions, because
 * offering a wallet that cannot work — with an "install" link to a desktop
 * extension, on a phone — is the dead end this issue is about.
 */
export function filterWalletsForPlatform(
    wallets: WalletOption[],
    mobile = isMobileBrowser(),
): WalletOption[] {
    if (!mobile) return wallets;
    return wallets.filter((wallet) => isMobileCapable(wallet.id));
}

/** Why a device cannot connect, when it cannot. */
export type MobileBlockReason =
    | 'none'
    /** On mobile with no WalletConnect configured and nothing else usable. */
    | 'no-mobile-wallet'
    /** Mobile wallets exist, but none can sign messages, so `/claim` is impossible. */
    | 'no-message-signing';

export interface PlatformAdvice {
    isMobile: boolean;
    /** Wallets worth offering on this device. */
    usable: WalletOption[];
    reason: MobileBlockReason;
}

/**
 * What to tell the user before opening the wallet modal.
 *
 * `requireMessageSigning` is set by `/claim`: that flow proves wallet ownership
 * with a signature over a message, and a wallet that cannot do it will fail at
 * the last step. Better to say so on arrival than after the form is filled.
 */
export function advisePlatform(
    wallets: WalletOption[],
    options: { requireMessageSigning?: boolean; mobile?: boolean; canSignMessage?: (id: string) => boolean } = {},
): PlatformAdvice {
    const mobile = options.mobile ?? isMobileBrowser();
    const usable = filterWalletsForPlatform(wallets, mobile);

    if (!mobile) {
        return { isMobile: false, usable, reason: 'none' };
    }

    if (usable.length === 0) {
        return { isMobile: true, usable, reason: 'no-mobile-wallet' };
    }

    if (options.requireMessageSigning && options.canSignMessage) {
        const signers = usable.filter((wallet) => options.canSignMessage!(wallet.id));
        if (signers.length === 0) {
            return { isMobile: true, usable, reason: 'no-message-signing' };
        }
        return { isMobile: true, usable: signers, reason: 'none' };
    }

    return { isMobile: true, usable, reason: 'none' };
}
