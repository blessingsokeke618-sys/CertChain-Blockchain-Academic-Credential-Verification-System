/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, OPTIONS } from '@/app/api/verify/[token]/route';
import { resetRateLimitStore } from '@/lib/rateLimit';

// The widget (issue #87) needs CORS headers on every response, including
// preflight OPTIONS, success, and the error paths a third-party caller is
// likeliest to hit (400 invalid token, 404 not found).

vi.mock('@/lib/serverAuth', () => ({
    getServiceRoleClient: () => ({
        from: () => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                }),
            }),
        }),
    }),
}));

vi.mock('@/lib/contractReads', () => ({
    getCredential: async () => null,
    isRevoked: async () => false,
    isAuthorizedIssuer: async () => false,
    ContractConfigurationError: class extends Error {},
    BlockchainUnavailableError: class extends Error {},
}));

vi.mock('@/lib/credentialHash', () => ({
    deriveCredentialHash: async () => 'derived-hash',
}));

vi.mock('@/lib/ipfsServer', () => ({
    fetchJsonFromIpfs: async () => ({ ok: false }),
}));

vi.mock('@/lib/verificationAudit', () => ({
    writeVerificationAuditLog: async () => undefined,
}));

vi.mock('@/lib/debug', () => ({
    captureException: () => undefined,
    recordMetric: () => undefined,
}));

vi.mock('@/lib/verificationCache', () => ({
    getCachedImmutableData: async () => null,
    setCachedImmutableData: async () => undefined,
    getCachedRevocationStatus: async () => null,
    setCachedRevocationStatus: async () => undefined,
    RESPONSE_CACHE_MAX_AGE_SECONDS: 60,
}));

function assertCors(res: Response) {
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/GET/);
    expect(res.headers.get('Vary')).toBe('Origin');
}

describe('verify route CORS (issue #87)', () => {
    beforeEach(() => {
        resetRateLimitStore();
    });

    it('OPTIONS preflight responds 204 with CORS headers', async () => {
        const res = await OPTIONS();
        expect(res.status).toBe(204);
        assertCors(res);
    });

    it('GET on an unknown token returns 404 with CORS headers', async () => {
        const req = new Request('http://localhost/api/verify/unknown', {
            method: 'GET',
            headers: { origin: 'https://partner.example' },
        });
        const res = await GET(req as any, { params: Promise.resolve({ token: 'unknown' }) });
        expect(res.status).toBe(404);
        assertCors(res);
    });

    it('GET on an empty token returns 400 with CORS headers', async () => {
        const req = new Request('http://localhost/api/verify/', {
            method: 'GET',
            headers: { origin: 'https://partner.example' },
        });
        const res = await GET(req as any, { params: Promise.resolve({ token: '' }) });
        expect(res.status).toBe(400);
        assertCors(res);
    });
});
