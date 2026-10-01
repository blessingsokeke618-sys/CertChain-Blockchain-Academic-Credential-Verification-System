import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/verify/[token]/route';
import { resetRateLimitStore } from '@/lib/rateLimit';

const state = vi.hoisted(() => ({
    credential: null as Record<string, unknown> | null,
    onChainRevoked: false,
}));

vi.mock('@/lib/serverAuth', () => ({
    getServiceRoleClient: () => ({
        from: () => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => ({ data: state.credential, error: null }),
                }),
            }),
        }),
    }),
}));

vi.mock('@/lib/contractReads', () => ({
    getCredential: async () => ({
        issuer: 'GIssuer',
        student: 'GStudent',
        hash: 'derived-hash',
        uri: 'ipfs://cid-123',
    }),
    isRevoked: async () => state.onChainRevoked,
    isAuthorizedIssuer: async () => true,
}));

vi.mock('@/lib/credentialHash', () => ({
    deriveCredentialHash: async () => 'derived-hash',
}));

vi.mock('@/lib/ipfsServer', () => ({
    fetchJsonFromIpfs: async () => ({ ok: true, content: {} }),
}));

function baseCredential(overrides: Record<string, unknown>) {
    return {
        id: 'cred-001',
        token_id: 'token-123',
        issued_at: '2026-01-01T00:00:00.000Z',
        revoked: false,
        revoked_at: null,
        revocation_source: null,
        metadata: {
            credentialData: {
                institutionName: 'ACREDIA',
                credentialType: 'Degree',
            },
        },
        metadata_schema_version: 1,
        hash_algorithm: 'sha256',
        ipfs_hash: 'cid-123',
        blockchain_hash: 'derived-hash',
        student_wallet_address: 'GStudent',
        issuer_wallet_address: 'GIssuer',
        institution: { name: 'ACREDIA' },
        ...overrides,
    };
}

async function verify() {
    const response = await GET(new Request('http://localhost/api/verify/token-123') as never, {
        params: Promise.resolve({ token: 'token-123' }),
    });
    return { response, payload: await response.json() };
}

describe('verify route revocation source', () => {
    beforeEach(() => {
        resetRateLimitStore();
        state.onChainRevoked = false;
    });

    it('reports an issuer revocation distinctly', async () => {
        state.credential = baseCredential({
            revoked: true,
            revoked_at: '2026-02-01T00:00:00.000Z',
            revocation_source: 'issuer',
        });

        const { response, payload } = await verify();

        expect(response.status).toBe(200);
        expect(payload.credential.revoked).toBe(true);
        expect(payload.credential.revocationSource).toBe('issuer');
        expect(payload.verification.revocationSource).toBe('issuer');
    });

    it('reports a platform (owner override) revocation distinctly', async () => {
        state.credential = baseCredential({
            revoked: true,
            revoked_at: '2026-02-01T00:00:00.000Z',
            revocation_source: 'platform',
        });

        const { payload } = await verify();

        expect(payload.credential.revoked).toBe(true);
        expect(payload.credential.revocationSource).toBe('platform');
        expect(payload.verification.revocationSource).toBe('platform');
    });

    it('leaves revocation source null for a live credential', async () => {
        state.credential = baseCredential({ revoked: false });

        const { payload } = await verify();

        expect(payload.credential.revoked).toBe(false);
        expect(payload.credential.revocationSource).toBeNull();
        expect(payload.verification.revocationSource).toBeNull();
    });

    it('falls back to null when a revoked credential has no recorded source', async () => {
        state.credential = baseCredential({
            revoked: true,
            revoked_at: '2026-02-01T00:00:00.000Z',
            revocation_source: null,
        });

        const { payload } = await verify();

        expect(payload.credential.revoked).toBe(true);
        expect(payload.credential.revocationSource).toBeNull();
    });
});
