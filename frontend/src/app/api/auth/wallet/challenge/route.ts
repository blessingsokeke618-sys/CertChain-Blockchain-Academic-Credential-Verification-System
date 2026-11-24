import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getServiceRoleClient } from '@/lib/serverAuth';
import { enforceRateLimit, getClientIp } from '@/lib/rateLimit';
import { captureException, structuredLog } from '@/lib/debug';
import { hashAuditValue } from '@/lib/verificationAudit';
import { isValidStellarAddress } from '@/lib/contracts';
import { buildWalletLoginMessage, CLAIM_NONCE_TTL_SECONDS } from '@/lib/walletOwnership';

export const dynamic = 'force-dynamic';

const LIMIT = { windowSeconds: 60, maxRequests: 10, prefix: 'wallet-login-challenge' } as const;
const schema = z.object({
    walletAddress: z.string().trim().refine(isValidStellarAddress, 'Not a valid Stellar address'),
});

/** Step 1 of SEP-0010-style login (#94): issue a single-use login challenge. */
export async function POST(request: NextRequest) {
    try {
        const limited = await enforceRateLimit(request, LIMIT);
        if (limited) return limited;

        const parsed = schema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'A valid Stellar address is required' }, { status: 400 });
        }

        const { walletAddress } = parsed.data;
        const nonce = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + CLAIM_NONCE_TTL_SECONDS * 1000);
        const supabase = getServiceRoleClient();
        const { error } = await supabase.from('wallet_claim_nonces').insert({
            wallet_address: walletAddress,
            nonce,
            expires_at: expiresAt.toISOString(),
            ip_hash: hashAuditValue(getClientIp(request)),
            purpose: 'login',
        });

        if (error) {
            structuredLog('ERROR', 'Failed to store wallet login challenge', 'walletLogin', { error });
            return NextResponse.json({ success: false, error: 'Failed to start sign-in' }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            nonce,
            message: buildWalletLoginMessage(walletAddress, nonce),
            expiresAt: expiresAt.toISOString(),
        });
    } catch (error) {
        captureException(error, { context: 'walletLoginChallenge' });
        return NextResponse.json({ success: false, error: 'Failed to start sign-in' }, { status: 500 });
    }
}
