import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, WALLET_IDS } from '../src/lib/wallet/capabilities';
import {
    advisePlatform,
    filterWalletsForPlatform,
    isDesktopExtensionOnly,
    isMobileBrowser,
    isMobileCapable,
} from '../src/lib/wallet/platform';
import type { WalletOption } from '../src/lib/wallet/types';

/**
 * Mobile wallet reachability (ACREDIA-STELLAR#4).
 *
 * A student opening Acredia on a phone had no path to the credential issued to
 * them — the likeliest device, and the one flow (`/claim`) they are most likely
 * to arrive through. These tests pin the two judgements that fix is built on,
 * both measured rather than assumed:
 *
 *  1. Which wallets a phone can actually reach. Two modules report
 *     `isAvailable: true` on mobile and still cannot be used there, so the
 *     kit's own answer is not trustworthy for this question.
 *  2. That "can connect" and "can claim" are different answers. Albedo is
 *     reachable on a phone but cannot sign messages, which is the only thing
 *     `/claim` needs.
 */

function wallet(id: string, isAvailable = true): WalletOption {
    return { id, name: id, isAvailable };
}

/** Stubs the browser globals `isMobileBrowser` reads. */
function stubBrowser({ ua, mobile, touchPoints = 0 }: {
    ua?: string;
    mobile?: boolean;
    touchPoints?: number;
}) {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
        userAgent: ua ?? '',
        maxTouchPoints: touchPoints,
        ...(mobile === undefined ? {} : { userAgentData: { mobile } }),
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isMobileBrowser', () => {
    it('trusts userAgentData.mobile where the browser provides it', () => {
        stubBrowser({ mobile: true, ua: 'anything' });
        expect(isMobileBrowser()).toBe(true);

        stubBrowser({ mobile: false, ua: 'Mozilla/5.0 (iPhone)' });
        // Explicit `false` wins over a UA that looks mobile — the structured
        // signal is the more reliable one where it exists.
        expect(isMobileBrowser()).toBe(false);
    });

    it('falls back to the user agent on Safari, which has no userAgentData', () => {
        stubBrowser({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
        expect(isMobileBrowser()).toBe(true);

        stubBrowser({ ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7)' });
        expect(isMobileBrowser()).toBe(true);
    });

    it('detects iPadOS, which reports a desktop user agent', () => {
        // iPads claim to be Macintosh; touch points are the only tell.
        stubBrowser({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', touchPoints: 5 });
        expect(isMobileBrowser()).toBe(true);

        // A real Mac: same UA, no touch.
        stubBrowser({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', touchPoints: 0 });
        expect(isMobileBrowser()).toBe(false);
    });

    it('treats a narrow desktop window as desktop', () => {
        // Deliberately not a viewport check: telling a user with a small window
        // that their installed extension is unavailable would be wrong.
        stubBrowser({ ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' });
        expect(isMobileBrowser()).toBe(false);
    });

    it('reports desktop when there is no browser at all', () => {
        // Server rendering. The desktop path shows every wallet, which is the
        // less restrictive failure.
        expect(isMobileBrowser()).toBe(false);
    });

    it('does not throw when the environment is unreadable', () => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', {
            get userAgent(): string {
                throw new Error('blocked by privacy setting');
            },
        });

        // This runs during connect; a detection failure must never be what
        // stops someone reaching their wallet.
        expect(() => isMobileBrowser()).not.toThrow();
        expect(isMobileBrowser()).toBe(false);
    });
});

describe('wallet reachability', () => {
    it('counts only WalletConnect and Albedo as reachable on a phone', () => {
        expect(isMobileCapable(WALLET_IDS.WALLET_CONNECT)).toBe(true);
        expect(isMobileCapable(WALLET_IDS.ALBEDO)).toBe(true);
    });

    it('excludes HOT Wallet despite it reporting available', () => {
        // Its module returns `isAvailable: true` unconditionally, hardcodes
        // `Networks.PUBLIC`, and needs `global`/`Buffer` polyfills this app does
        // not ship. Offering it on testnet would mean signing against mainnet.
        expect(isMobileCapable(WALLET_IDS.HOT_WALLET)).toBe(false);
        expect(isDesktopExtensionOnly(WALLET_IDS.HOT_WALLET)).toBe(true);
    });

    it('excludes every browser-extension wallet', () => {
        for (const id of [
            WALLET_IDS.FREIGHTER,
            WALLET_IDS.XBULL,
            WALLET_IDS.RABET,
            WALLET_IDS.LOBSTR,
            WALLET_IDS.HANA,
            WALLET_IDS.KLEVER,
            WALLET_IDS.ONEKEY,
            WALLET_IDS.BITGET,
        ]) {
            expect(isMobileCapable(id), id).toBe(false);
            expect(isDesktopExtensionOnly(id), id).toBe(true);
        }
    });

    it('does not treat Lobstr or Hana as mobile paths', () => {
        // The issue named both as mobile coverage, but their kit modules reach
        // for a browser *extension* (`@lobstrco/signer-extension-api`,
        // `window.hanaWallet`). Their phone apps are real; they are simply not
        // reachable from a mobile browser tab, which is where this code runs.
        expect(isMobileCapable(WALLET_IDS.LOBSTR)).toBe(false);
        expect(isMobileCapable(WALLET_IDS.HANA)).toBe(false);
    });
});

describe('filterWalletsForPlatform', () => {
    const all = [
        wallet(WALLET_IDS.FREIGHTER),
        wallet(WALLET_IDS.ALBEDO),
        wallet(WALLET_IDS.HOT_WALLET),
        wallet(WALLET_IDS.WALLET_CONNECT),
    ];

    it('leaves the list untouched on desktop', () => {
        expect(filterWalletsForPlatform(all, false)).toEqual(all);
    });

    it('drops what a phone cannot reach', () => {
        expect(filterWalletsForPlatform(all, true).map((w) => w.id)).toEqual([
            WALLET_IDS.ALBEDO,
            WALLET_IDS.WALLET_CONNECT,
        ]);
    });
});

describe('advisePlatform', () => {
    const canSignMessage = (id: string) => capabilitiesFor(id).signMessage;

    it('reports no block on desktop', () => {
        const advice = advisePlatform([wallet(WALLET_IDS.FREIGHTER)], { mobile: false });
        expect(advice).toMatchObject({ isMobile: false, reason: 'none' });
    });

    it('reports no reachable wallet on a phone with only extensions', () => {
        // The state before WalletConnect is configured.
        const advice = advisePlatform([wallet(WALLET_IDS.FREIGHTER), wallet(WALLET_IDS.LOBSTR)], {
            mobile: true,
        });
        expect(advice.reason).toBe('no-mobile-wallet');
        expect(advice.usable).toEqual([]);
    });

    it('separates "can connect" from "can claim"', () => {
        // Albedo is reachable on a phone, so connecting works — but it cannot
        // sign messages, so `/claim` cannot complete. Reporting this as
        // "no wallet" would be wrong; reporting it as fine would strand the
        // student at the last step.
        const albedoOnly = [wallet(WALLET_IDS.ALBEDO)];

        expect(advisePlatform(albedoOnly, { mobile: true }).reason).toBe('none');
        expect(
            advisePlatform(albedoOnly, {
                mobile: true,
                requireMessageSigning: true,
                canSignMessage,
            }).reason,
        ).toBe('no-message-signing');
    });

    it('clears the block once WalletConnect is configured', () => {
        // The real fix: WalletConnect can sign messages, so `/claim` works.
        const advice = advisePlatform(
            [wallet(WALLET_IDS.ALBEDO), wallet(WALLET_IDS.WALLET_CONNECT)],
            { mobile: true, requireMessageSigning: true, canSignMessage },
        );

        expect(advice.reason).toBe('none');
        expect(advice.usable.map((w) => w.id)).toEqual([WALLET_IDS.WALLET_CONNECT]);
    });
});

describe('WalletConnect capabilities', () => {
    it('is treated as able to sign messages, so a phone can reach /claim', () => {
        // It requests `stellar_signMessage` as an optional namespace; whether it
        // works depends on the wallet app the student scans with, and a wallet
        // that declines surfaces as the kit's -3 rejection which the adapter
        // already maps to a named capability error.
        expect(capabilitiesFor(WALLET_IDS.WALLET_CONNECT)).toEqual({
            signTransaction: true,
            signMessage: true,
        });
    });
});
