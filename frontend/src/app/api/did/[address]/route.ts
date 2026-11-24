import { NextRequest, NextResponse } from 'next/server';
import { StrKey } from '@stellar/stellar-sdk';
import { isValidStellarAddress } from '@/lib/contracts';

export const dynamic = 'force-dynamic';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58btc encoding used by the `z` multibase prefix in DID documents. */
function base58btc(bytes: Uint8Array): string {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    let encoded = '';
    while (value > 0n) {
        encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = BASE58_ALPHABET[0] + encoded;
    }
    return encoded;
}

/**
 * Minimal per-address DID document resolver for `did:stellar:<G-address>` (#95).
 *
 * A Stellar G-address is an Ed25519 public key encoded with StrKey. Decoding it
 * gives the raw key, which is published as a multibase verification method so
 * third-party VC/OBv3 consumers can resolve the identifier without a globally
 * registered DID method. The document is intentionally capability-free: it
 * asserts key ownership only and grants no application role.
 */
export async function GET(
    _request: NextRequest,
    context: { params: Promise<{ address: string }> },
) {
    const { address } = await context.params;
    if (!address || !isValidStellarAddress(address)) {
        return NextResponse.json({ error: 'Invalid Stellar address' }, { status: 400 });
    }

    let publicKey: Uint8Array;
    try {
        publicKey = StrKey.decodeEd25519PublicKey(address);
    } catch {
        return NextResponse.json({ error: 'Invalid Stellar address' }, { status: 400 });
    }

    const did = `did:stellar:${address}`;
    const verificationMethodId = `${did}#key-1`;
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://acredia-stellar-tau.vercel.app';

    return NextResponse.json(
        {
            '@context': [
                'https://www.w3.org/ns/did/v1',
                'https://w3id.org/security/suites/ed25519-2020/v1',
            ],
            id: did,
            verificationMethod: [
                {
                    id: verificationMethodId,
                    type: 'Ed25519VerificationKey2020',
                    controller: did,
                    publicKeyMultibase: `z${base58btc(publicKey)}`,
                },
            ],
            authentication: [verificationMethodId],
            assertionMethod: [verificationMethodId],
            service: [
                {
                    id: `${did}#credentials`,
                    type: 'LinkedDomains',
                    serviceEndpoint: origin,
                },
            ],
        },
        { headers: { 'Cache-Control': 'public, max-age=300' } },
    );
}
