import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit } from '@/lib/rateLimit';
import { runtimeConfig } from '@/lib/runtimeConfig';

export const dynamic = 'force-dynamic';

/**
 * GET /api/issuers
 *
 * Public issuer trust registry — Issue #171.
 * Returns verified institutions with public, non-PII fields only.
 * No authentication required; rate-limited by IP.
 *
 * Response shape:
 * {
 *   success: true,
 *   issuers: Array<{
 *     id: string;
 *     name: string;
 *     wallet_address: string | null;
 *     authorization_tx_hash: string | null;
 *     verified_at: string;          // ISO timestamp (created_at of institution row)
 *   }>
 * }
 */
export async function GET(request: NextRequest) {
    const rateLimitResponse = await enforceRateLimit(request, {
        windowSeconds: 60,
        maxRequests: 60,
        prefix: 'issuers-public',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const { url: supabaseUrl, anonKey } = runtimeConfig.supabase;

    if (!supabaseUrl || !anonKey) {
        return NextResponse.json(
            { success: false, error: 'Service temporarily unavailable.' },
            { status: 503 },
        );
    }

    const client = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    // Only expose public, non-PII columns of verified institutions.
    // email is excluded (PII); name and wallet are public business identifiers.
    const { data, error } = await client
        .from('institutions')
        .select('id, name, wallet_address, authorization_tx_hash, created_at')
        .eq('verified', true)
        .order('created_at', { ascending: false });

    if (error) {
        return NextResponse.json(
            { success: false, error: 'Failed to fetch issuer registry.' },
            { status: 500 },
        );
    }

    const issuers = (data ?? []).map(
        (row: {
            id: string;
            name: string;
            wallet_address: string | null;
            authorization_tx_hash: string | null;
            created_at: string;
        }) => ({
            id: row.id,
            name: row.name,
            wallet_address: row.wallet_address,
            authorization_tx_hash: row.authorization_tx_hash,
            verified_at: row.created_at,
        }),
    );

    return NextResponse.json(
        { success: true, issuers },
        {
            headers: {
                // Allow CDN / browser caching for up to 5 minutes — the list
                // changes infrequently (only when admin verifies an institution).
                'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
            },
        },
    );
}
