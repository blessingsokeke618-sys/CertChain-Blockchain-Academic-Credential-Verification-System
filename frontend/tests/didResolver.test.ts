import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/did/[address]/route';

const ADDRESS = 'GAMI3XDDII72W23RADNPPAZ2GYEZ2MTYXLETOU36R4ISXMQ7IURFEKFP';

const context = (address: string) => ({ params: Promise.resolve({ address }) });

describe('did:stellar resolver (#95)', () => {
    it('resolves a valid address to a DID document with the decoded key', async () => {
        const response = await GET(new Request('http://localhost/api/did/' + ADDRESS) as any, context(ADDRESS));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.id).toBe(`did:stellar:${ADDRESS}`);
        const method = body.verificationMethod[0];
        expect(method.type).toBe('Ed25519VerificationKey2020');
        expect(method.controller).toBe(body.id);
        expect(method.publicKeyMultibase).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);
        expect(body.authentication).toContain(method.id);
        expect(body.assertionMethod).toContain(method.id);
        expect(response.headers.get('Cache-Control')).toContain('max-age=300');
    });

    it('rejects malformed addresses', async () => {
        const response = await GET(new Request('http://localhost/api/did/nope') as any, context('nope'));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('Invalid Stellar address');
    });
});
