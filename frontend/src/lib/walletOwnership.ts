import { Keypair, StrKey } from '@stellar/stellar-sdk';

/**
 * Server-side proof of Stellar wallet ownership (Issue #243).
 *
 * The claim flow is an account-creation path gated only by a signature, so
 * every check that matters happens here on the server: a client can present a
 * signature, but it can never assert that the signature is valid.
 */

/** How long a challenge stays usable. Short, because it only has to survive one wallet prompt. */
export const CLAIM_NONCE_TTL_SECONDS = 5 * 60;

/**
 * Builds the human-readable message a student signs.
 *
 * The wallet address is embedded in the signed text, not merely checked
 * alongside it, so a signature captured for one wallet cannot be replayed as
 * proof for another. The purpose line is there so a student can read in their
 * wallet exactly what they are agreeing to.
 */
export function buildClaimMessage(walletAddress: string, nonce: string): string {
    return [
        'Acredia — prove wallet ownership',
        '',
        'Signing this message proves you control this wallet so you can claim',
        'the credentials issued to it. It authorises no payment and no transfer.',
        '',
        `Wallet: ${walletAddress}`,
        `Challenge: ${nonce}`,
    ].join('\n');
}

/**
 * Verifies a signature over {@link buildClaimMessage} against a Stellar
 * address.
 *
 * Accepts the signature as base64; {@link normalizeSignedMessage} is what
 * every wallet's response is funnelled through to get there. Any malformed input —
 * a bad address, undecodable base64, a wrong-length signature — is a failed
 * verification, never a thrown error, so a caller cannot distinguish "invalid
 * signature" from "malformed request" by watching for exceptions.
 */
export function verifyWalletSignature(
    walletAddress: string,
    message: string,
    signatureBase64: string,
): boolean {
    if (!walletAddress || !message || !signatureBase64) {
        return false;
    }

    if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
        return false;
    }

    let signature: Buffer;
    try {
        signature = Buffer.from(signatureBase64, 'base64');
    } catch {
        return false;
    }

    // Ed25519 signatures are exactly 64 bytes. Buffer.from silently ignores
    // invalid base64 characters, so this length check is what actually
    // rejects garbage input.
    if (signature.length !== 64) {
        return false;
    }

    try {
        const keypair = Keypair.fromPublicKey(walletAddress);
        return keypair.verify(Buffer.from(message, 'utf8'), signature);
    } catch {
        return false;
    }
}

/** An Ed25519 signature is 64 bytes — 128 characters of hex. */
const HEX_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/i;

/**
 * Normalises whatever a wallet returns from `signMessage` into base64.
 *
 * Wallets disagree about the encoding, and the disagreement is silent: every
 * shape below is a plausible-looking string, so getting it wrong produces a
 * failed *verification* rather than a parse error, which reads to the student
 * as "your wallet is wrong" (ACREDIA-STELLAR#272).
 *
 *  - base64 string — Freighter v4, xBull, Lobstr, Hana and most others
 *  - `Uint8Array`/Buffer — Freighter v3
 *  - lowercase hex — Bitget, whose module returns `signatureHex`
 *
 * Hex is detected by shape rather than by asking which wallet signed: the
 * caller should not have to care, and a 128-character hex string is not a
 * valid base64 encoding of a 64-byte signature, so the two cannot collide.
 */
export function normalizeSignedMessage(signed: string | Uint8Array | null): string | null {
    if (!signed) return null;

    if (typeof signed === 'string') {
        if (HEX_SIGNATURE_PATTERN.test(signed)) {
            return Buffer.from(signed, 'hex').toString('base64');
        }
        return signed;
    }

    return Buffer.from(signed).toString('base64');
}
