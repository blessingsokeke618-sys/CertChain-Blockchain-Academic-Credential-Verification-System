/**
 * SEP-0007 — Stellar URI Scheme
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * SEP-0007 defines a standard URI format that any Stellar wallet can parse
 * to pre-fill a transaction or payment. CertChain uses it for two purposes:
 *
 *  1. `buildVerificationDeepLink` — a `web+stellar:` URI that opens a wallet
 *     on the credential verification page without requiring the verifier to
 *     type a token ID manually. Useful in QR codes and NFC tags.
 *
 *  2. `buildCredentialShareUri` — a URI that encodes the credential's token ID
 *     and IPFS CID so any SEP-0007-aware app can verify or import it.
 *
 * These URIs do NOT carry a transaction. They use the `web` operation type
 * (SEP-0007 §4), which points to a URL that the wallet should open in a
 * browser, passing the user's address as a query parameter so the target
 * page knows who is viewing.
 *
 * For the transaction-signing path (issue / revoke), the wallet adapter's
 * `signTransaction` is used directly — no SEP-0007 indirection needed there
 * because we already have the wallet connected.
 */

/**
 * Options for a SEP-0007 `web` operation URI.
 *
 * The `web` operation opens a URL in the user's default browser. If the wallet
 * supports it, it injects `?addr=<STELLAR_ADDRESS>` so the target page knows
 * who is viewing. This is a read-only intent — no transaction is built.
 */
export interface Sep0007WebOptions {
    /** The URL the wallet should open. Will be percent-encoded in the URI. */
    url: string;
    /**
     * Short human-readable description shown in the wallet before opening.
     * Max 300 characters per SEP-0007 spec. Truncated automatically if longer.
     */
    msg?: string;
    /**
     * Identifies the application to the wallet for display purposes.
     * Shown as "Origin: <origin>" in some wallet UIs.
     */
    originDomain?: string;
}

/**
 * Builds a SEP-0007 `web` operation URI.
 *
 * Format: `web+stellar:web?url=<encoded-url>[&msg=...][&origin_domain=...]`
 *
 * @example
 * buildSep0007WebUri({
 *   url: 'https://app.certchain.io/verify?token=42',
 *   msg: 'Verify credential #42 from Stellar University',
 *   originDomain: 'app.certchain.io',
 * })
 * // => "web+stellar:web?url=https%3A%2F%2F...&msg=...&origin_domain=..."
 */
export function buildSep0007WebUri(options: Sep0007WebOptions): string {
    const params = new URLSearchParams();
    params.set('url', options.url);

    if (options.msg) {
        // Truncate to 300 chars as required by SEP-0007 §4.3
        params.set('msg', options.msg.slice(0, 300));
    }

    if (options.originDomain) {
        params.set('origin_domain', options.originDomain);
    }

    return `web+stellar:web?${params.toString()}`;
}

/**
 * Builds a deep-link URI for verifying a specific credential.
 *
 * The resulting `web+stellar:` URI can be embedded in a QR code or NFC tag.
 * When a student shares their credential QR, the verifier's Stellar wallet
 * can scan it and open the verification page directly — no manual token ID
 * entry needed.
 *
 * @param tokenId   - The on-chain token ID (u64) of the credential.
 * @param appBaseUrl - The root URL of the CertChain app (e.g. https://app.certchain.io).
 * @param institutionName - Optional institution name for the wallet's display message.
 */
export function buildVerificationDeepLink(
    tokenId: string | number,
    appBaseUrl: string,
    institutionName?: string,
): string {
    const verifyUrl = `${appBaseUrl.replace(/\/$/, '')}/verify?token=${encodeURIComponent(String(tokenId))}`;
    const msg = institutionName
        ? `Verify academic credential #${tokenId} issued by ${institutionName}`
        : `Verify academic credential #${tokenId} on CertChain`;

    let originDomain: string | undefined;
    try {
        originDomain = new URL(appBaseUrl).hostname;
    } catch {
        // If appBaseUrl is not a valid URL, omit origin_domain
    }

    return buildSep0007WebUri({ url: verifyUrl, msg, originDomain });
}

/**
 * Builds a SEP-0007 URI that encodes a credential's key identifiers.
 *
 * This is suitable for inter-app communication: a wallet or credential
 * reader that understands CertChain's URI scheme can extract the token ID
 * and IPFS CID without hitting any server.
 *
 * The URL target is the public `/verify` page; the token ID and IPFS CID
 * are passed as query parameters so the page can load the credential
 * directly.
 *
 * @param tokenId    - The on-chain token ID.
 * @param ipfsCid    - The IPFS CID of the credential document.
 * @param appBaseUrl - The root URL of the CertChain app.
 */
export function buildCredentialShareUri(
    tokenId: string | number,
    ipfsCid: string,
    appBaseUrl: string,
): string {
    const base = appBaseUrl.replace(/\/$/, '');
    const verifyUrl = `${base}/verify?token=${encodeURIComponent(String(tokenId))}&cid=${encodeURIComponent(ipfsCid)}`;

    let originDomain: string | undefined;
    try {
        originDomain = new URL(appBaseUrl).hostname;
    } catch {
        // omit if invalid
    }

    return buildSep0007WebUri({
        url: verifyUrl,
        msg: `CertChain academic credential #${tokenId}`,
        originDomain,
    });
}

/**
 * Parses a SEP-0007 `web` operation URI and returns the decoded parameters.
 *
 * Returns `null` for any string that is not a valid SEP-0007 `web` URI.
 * Does not validate the `url` field beyond decoding — callers must validate
 * that the URL points to a trusted domain before opening it.
 */
export function parseSep0007WebUri(uri: string): { url: string; msg?: string; originDomain?: string } | null {
    if (!uri.startsWith('web+stellar:web?')) {
        return null;
    }

    try {
        const queryString = uri.slice('web+stellar:web?'.length);
        const params = new URLSearchParams(queryString);
        const url = params.get('url');
        if (!url) return null;

        return {
            url,
            msg: params.get('msg') ?? undefined,
            originDomain: params.get('origin_domain') ?? undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Returns true when the given string looks like a SEP-0007 URI of any type.
 * Use this to detect incoming URIs (e.g. from a QR scanner) before parsing.
 */
export function isSep0007Uri(value: string): boolean {
    return value.startsWith('web+stellar:');
}
