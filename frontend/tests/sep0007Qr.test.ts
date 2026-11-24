import { describe, expect, it } from 'vitest';
import {
    buildVerificationDeepLink,
    parseSep0007WebUri,
} from '@/lib/wallet/sep0007';

describe('SEP-0007 credential QR payload (#90)', () => {
    it('encodes a wallet-openable verification deep link', () => {
        const uri = buildVerificationDeepLink('42', 'https://acredia.example/', 'Stellar University');
        expect(uri.startsWith('web+stellar:web?')).toBe(true);
        const parsed = parseSep0007WebUri(uri);
        expect(parsed?.url).toBe('https://acredia.example/verify?token=42');
        expect(parsed?.msg).toContain('Stellar University');
    });

    it('round-trips the verification token', () => {
        const uri = buildVerificationDeepLink(123, 'https://acredia.example');
        expect(parseSep0007WebUri(uri)?.url).toContain('token=123');
    });
});
