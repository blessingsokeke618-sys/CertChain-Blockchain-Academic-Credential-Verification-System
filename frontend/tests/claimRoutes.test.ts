/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as requestNonce } from '@/app/api/claim/nonce/route';
import { POST as verifyClaim } from '@/app/api/claim/verify/route';

const state = vi.hoisted(() => ({
    nonces: [] as Array<{
        id: string;
        wallet_address: string;
        nonce: string;
        expires_at: string;
        consumed_at: string | null;
    }>,
    audits: [] as any[],
    createdUsers: [] as any[],
    signatureValid: true as boolean,
}));

vi.mock('@/lib/serverAuth', () => {
    const table = (name: string) => {
        const filters: Record<string, any> = {};
        let patch: Record<string, any> | null = null;
        const builder: any = {
            select: () => builder,
            eq: (key: string, value: any) => {
                filters[key] = value;
                return builder;
            },
            is: (key: string, value: any) => {
                filters[key] = value;
                return builder;
            },
            limit: () => builder,
            update: (value: Record<string, any>) => {
                patch = value;
                return builder;
            },
            insert: async (row: any) => {
                if (name === 'wallet_claim_nonces') {
                    state.nonces.push({
                        id: `nonce-${state.nonces.length + 1}`,
                        wallet_address: row.wallet_address,
                        nonce: row.nonce,
                        expires_at: row.expires_at,
                        consumed_at: null,
                    });
                }
                if (name === 'admin_audit_logs') state.audits.push(row);
                return { error: null };
            },
            upsert: async () => ({ error: null }),
            maybeSingle: async () => {
                if (name === 'wallet_claim_nonces') {
                    const row = state.nonces.find(
                        (candidate) =>
                            candidate.nonce === filters.nonce &&
                            candidate.wallet_address === filters.wallet_address,
                    );
                    if (!row) return { data: null, error: null };
                    if (patch) {
                        if (filters.consumed_at === null && row.consumed_at !== null) {
                            return { data: null, error: null };
                        }
                        Object.assign(row, patch);
                        return { data: { id: row.id }, error: null };
                    }
                    return { data: { ...row }, error: null };
                }
                if (name === 'credentials') {
                    return { data: { id: 'cred-1', student_id: null }, error: null };
                }
                if (name === 'students') {
                    return patch ? { data: { id: 'student-1' }, error: null } : { data: null, error: null };
                }
                return { data: null, error: null };
            },
            single: async () => ({ data: { id: 'student-1' }, error: null }),
        };
        return builder;
    };

    return {
        getServiceRoleClient: () => ({
            from: table,
            auth: {
                admin: {
                    createUser: async ({ email, password }: any) => {
                        state.createdUsers.push({ email, password });
                        return { data: { user: { id: 'auth-user-1' } }, error: null };
                    },
                },
            },
        }),
    };
});

vi.mock('@/lib/rateLimit', () => ({
    enforceRateLimit: async () => null,
    getClientIp: () => '203.0.113.10',
    resetRateLimitStore: () => undefined,
}));

vi.mock('@/lib/contracts', () => ({ isValidStellarAddress: () => true }));
vi.mock('@/lib/verificationAudit', () => ({ hashAuditValue: () => 'hashed-ip' }));
vi.mock('@/lib/debug', () => ({ structuredLog: () => undefined, captureException: () => undefined }));
vi.mock('@/lib/walletOwnership', () => ({
    CLAIM_NONCE_TTL_SECONDS: 300,
    buildClaimMessage: (wallet: string, nonce: string) => `claim:${wallet}:${nonce}`,
    verifyWalletSignature: () => state.signatureValid,
}));

const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function nonceRequest() {
    return new NextRequest('http://localhost/api/claim/nonce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddress: WALLET }),
    });
}

function verifyRequest(nonce: string, overrides: Record<string, unknown> = {}) {
    return new NextRequest('http://localhost/api/claim/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            walletAddress: WALLET,
            nonce,
            signature: 'valid-signature',
            email: 'student@example.com',
            password: 'strong-password-1',
            ...overrides,
        }),
    });
}

async function issueNonce(): Promise<string> {
    const response = await requestNonce(nonceRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.nonce).toHaveLength(64);
    expect(body.message).toContain(WALLET);
    expect(body.expiresAt).toBeTruthy();
    return body.nonce as string;
}

describe('claim nonce and verify routes (#126)', () => {
    beforeEach(() => {
        state.nonces.length = 0;
        state.audits.length = 0;
        state.createdUsers.length = 0;
        state.signatureValid = true;
    });

    it('issues a fresh single-use nonce bound to the wallet', async () => {
        const nonce = await issueNonce();
        expect(state.nonces).toHaveLength(1);
        expect(state.nonces[0]).toMatchObject({ nonce, wallet_address: WALLET, consumed_at: null });
    });

    it('accepts a valid signature exactly once', async () => {
        const nonce = await issueNonce();
        const first = await verifyClaim(verifyRequest(nonce));
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({ success: true, email: 'student@example.com' });
        expect(state.createdUsers).toHaveLength(1);
        expect(state.nonces[0]?.consumed_at).toBeTruthy();

        const replay = await verifyClaim(verifyRequest(nonce));
        expect(replay.status).toBe(400);
        expect(state.createdUsers).toHaveLength(1);
    });

    it('rejects an expired nonce', async () => {
        const nonce = await issueNonce();
        state.nonces[0]!.expires_at = new Date(Date.now() - 1000).toISOString();

        const response = await verifyClaim(verifyRequest(nonce));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain('expired');
        expect(state.createdUsers).toHaveLength(0);
    });

    it('rejects an invalid signature', async () => {
        const nonce = await issueNonce();
        state.signatureValid = false;

        const response = await verifyClaim(verifyRequest(nonce));
        expect(response.status).toBe(401);
        expect(state.nonces[0]?.consumed_at).toBeNull();
        expect(state.createdUsers).toHaveLength(0);
    });
});
