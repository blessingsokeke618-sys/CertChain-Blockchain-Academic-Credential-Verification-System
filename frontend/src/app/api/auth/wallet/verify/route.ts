import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceRoleClient } from '@/lib/serverAuth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { captureException, structuredLog } from '@/lib/debug';
import { isValidStellarAddress } from '@/lib/contracts';
import { buildWalletLoginMessage, verifyWalletSignature } from '@/lib/walletOwnership';

export const dynamic = 'force-dynamic';

const LIMIT = { windowSeconds: 60, maxRequests: 10, prefix: 'wallet-login-verify' } as const;
const schema = z.object({
    walletAddress: z.string().trim().refine(isValidStellarAddress, 'Not a valid Stellar address'),
    nonce: z.string().trim().min(32).max(128),
    signature: z.string().trim().min(1).max(512),
});
const GENERIC_FAILURE = 'We could not sign you in with that wallet.';

/**
 * Step 2 of SEP-0010-style login (#94). A valid signature authenticates ONLY
 * a wallet already attached to a provisioned account; it never creates an
 * account or grants a role. The nonce is consumed before the session link is
 * produced so a replay cannot be exchanged for a second login.
 */
export async function POST(request: NextRequest) {
    try {
        const limited = await enforceRateLimit(request, LIMIT);
        if (limited) return limited;

        const parsed = schema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid sign-in request' }, { status: 400 });
        }
        const { walletAddress, nonce, signature } = parsed.data;
        const supabase = getServiceRoleClient();

        // Purpose filter prevents a claim challenge being used for login.
        const { data: row, error: lookupError } = await supabase
            .from('wallet_claim_nonces')
            .select('id, wallet_address, expires_at, consumed_at, purpose')
            .eq('nonce', nonce)
            .eq('wallet_address', walletAddress)
            .eq('purpose', 'login')
            .maybeSingle();

        if (lookupError) {
            structuredLog('ERROR', 'Failed to load wallet login challenge', 'walletLogin', { error: lookupError });
            return NextResponse.json({ success: false, error: 'Failed to sign in' }, { status: 500 });
        }
        if (!row || row.consumed_at || new Date(row.expires_at) < new Date()) {
            return NextResponse.json(
                { success: false, error: 'This challenge has expired. Start sign-in again.' },
                { status: 400 },
            );
        }

        if (!verifyWalletSignature(walletAddress, buildWalletLoginMessage(walletAddress, nonce), signature)) {
            return NextResponse.json({ success: false, error: GENERIC_FAILURE }, { status: 401 });
        }

        const { data: consumed, error: consumeError } = await supabase
            .from('wallet_claim_nonces')
            .update({ consumed_at: new Date().toISOString() })
            .eq('id', row.id)
            .is('consumed_at', null)
            .select('id')
            .maybeSingle();
        if (consumeError || !consumed) {
            return NextResponse.json(
                { success: false, error: 'This challenge has already been used.' },
                { status: 409 },
            );
        }

        // Only an already-provisioned account can sign in. Wallet connection
        // alone never establishes identity or role.
        const { data: student } = await supabase
            .from('students')
            .select('id, email, auth_user_id, status')
            .eq('wallet_address', walletAddress)
            .maybeSingle();
        if (!student?.auth_user_id || !student.email) {
            return NextResponse.json({ success: false, error: GENERIC_FAILURE }, { status: 404 });
        }

        const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: student.email,
        });
        if (linkError || !link?.properties?.action_link) {
            structuredLog('ERROR', 'Failed to create wallet login session', 'walletLogin', { error: linkError });
            return NextResponse.json({ success: false, error: 'Failed to sign in' }, { status: 500 });
        }

        return NextResponse.json({ success: true, loginUrl: link.properties.action_link });
    } catch (error) {
        captureException(error, { context: 'walletLoginVerify' });
        return NextResponse.json({ success: false, error: 'Failed to sign in' }, { status: 500 });
    }
}
