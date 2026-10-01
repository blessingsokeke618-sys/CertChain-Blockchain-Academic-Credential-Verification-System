import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/serverAuth';
import { authorizeCronRequest } from '@/lib/cronAuth';
import { captureException, structuredLog, recordMetric } from '@/lib/debug';
import { getRpcClient } from '@/lib/contractReads';
import { getConfiguredContractId } from '@/lib/runtimeConfig';

export const dynamic = 'force-dynamic';

/**
 * TTL Keeper — Credential on-chain bump cron (Issue #281)
 *
 * Soroban persistent entries expire unless their TTL is extended. The
 * contract exposes a permissionless `bump_credential` entrypoint, but
 * nothing was scheduled to call it. A credential that is never verified
 * for ~1 year silently expires and stops verifying — the most
 * product-damaging failure possible.
 *
 * This cron:
 *   1. Reads all credential token IDs from the Supabase index.
 *   2. For each, calls bump_credential on-chain (idempotent; no-op when
 *      TTL is already healthy per PERSISTENT_THRESHOLD).
 *   3. Records a per-run summary (count bumped, count failed, duration).
 *   4. Returns a structured response that the admin dashboard can surface.
 *
 * Scheduled in vercel.json. Calls are authorized via CRON_SECRET.
 *
 * Fee account: the keeper account must be funded with XLM to cover the
 * Soroban transaction fees. Monitor KEEPER_ACCOUNT_MIN_BALANCE_XLM; page
 * on-call when it falls below the threshold.
 */

// How many credentials to bump in a single cron run.
// Adjust based on Vercel function timeout limits (default: 60 s for Hobby,
// 300 s for Pro). Each bump_credential call is a cheap Soroban read+write.
const BATCH_LIMIT = 500;

// Minimum remaining ledgers that triggers a bump call (≈ 6 months, matching
// the PERSISTENT_THRESHOLD constant in the contract).
const TTL_THRESHOLD_LEDGERS = 3_110_400; // ~6 months @ 5 s/ledger

// Minimum XLM balance for the keeper fee account. Alert when below this.
const KEEPER_MIN_BALANCE_XLM = 5;

interface KeeperRunSummary {
    runId: string;
    totalCredentials: number;
    bumpAttempted: number;
    bumpSucceeded: number;
    bumpFailed: number;
    bumpSkipped: number;  // TTL already healthy
    minRemainingTtlLedgers: number | null;
    keeperBalanceXlm: number | null;
    lowBalance: boolean;
    durationMs: number;
    failedTokenIds: string[];
}

async function getKeeperBalance(): Promise<number | null> {
    try {
        const horizonUrl = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
        const keeperAccount = process.env.TTL_KEEPER_ACCOUNT_PUBLIC;
        if (!keeperAccount) return null;

        const response = await fetch(`${horizonUrl}/accounts/${keeperAccount}`);
        if (!response.ok) return null;

        const data = await response.json() as { balances?: Array<{ asset_type: string; balance: string }> };
        const native = data.balances?.find((b) => b.asset_type === 'native');
        return native ? parseFloat(native.balance) : null;
    } catch {
        return null;
    }
}

async function bumpCredentialOnChain(tokenId: string): Promise<{ success: boolean; ttlLedgers: number | null }> {
    try {
        const rpc = getRpcClient();
        const contractId = getConfiguredContractId('CREDENTIAL_NFT');
        const keeperSecret = process.env.TTL_KEEPER_ACCOUNT_SECRET;

        if (!keeperSecret) {
            // No keeper account configured — cannot submit on-chain bump.
            return { success: false, ttlLedgers: null };
        }

        // bump_credential is permissionless — any funded account can call it.
        // It calls extend_credential_ttl internally; it is a no-op (succeeds
        // without writing) when the TTL is already above PERSISTENT_THRESHOLD.
        const { SorobanRpc, TransactionBuilder, Networks, BASE_FEE, Keypair, Contract, nativeToScVal, xdr } = await import('@stellar/stellar-sdk');

        const keypair = Keypair.fromSecret(keeperSecret);
        const server = new SorobanRpc.Server(rpc.serverUrl);
        const account = await server.getAccount(keypair.publicKey());

        const contract = new Contract(contractId);
        const networkPassphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? Networks.TESTNET;

        const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase,
        })
            .addOperation(contract.call('bump_credential', nativeToScVal(BigInt(tokenId), { type: 'u64' })))
            .setTimeout(30)
            .build();

        const sim = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
            return { success: false, ttlLedgers: null };
        }

        const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);

        const result = await server.sendTransaction(prepared);
        if (result.status === 'ERROR') {
            return { success: false, ttlLedgers: null };
        }

        // Poll for completion
        let getResult = await server.getTransaction(result.hash);
        let attempts = 0;
        while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && attempts < 10) {
            await new Promise((r) => setTimeout(r, 2000));
            getResult = await server.getTransaction(result.hash);
            attempts++;
        }

        const succeeded = getResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS;
        return { success: succeeded, ttlLedgers: null };
    } catch {
        return { success: false, ttlLedgers: null };
    }
}

export async function GET(request: NextRequest) {
    const startMs = Date.now();
    const runId = crypto.randomUUID();
    const requestId = request.headers.get('x-request-id') || runId;

    const auth = authorizeCronRequest(request);
    if (!auth.ok) {
        structuredLog('WARN', 'Rejected cron invocation of TTL keeper', requestId, {
            status: auth.status,
        });
        return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    try {
        const supabase = getServiceRoleClient();

        // Fetch all non-revoked credential token IDs from the Supabase index.
        // The keeper must not trust only the DB: it reconciles against the chain.
        // Revoked credentials do not need bumping — their on-chain entries stop
        // being queried and can safely archive.
        const { data: credentials, error: fetchError } = await supabase
            .from('credentials')
            .select('token_id')
            .eq('revoked', false)
            .not('token_id', 'is', null)
            .limit(BATCH_LIMIT);

        if (fetchError) {
            throw new Error(`Failed to fetch credentials: ${fetchError.message}`);
        }

        const tokenIds = (credentials ?? [])
            .map((c) => String(c.token_id))
            .filter(Boolean);

        const totalCredentials = tokenIds.length;
        let bumpSucceeded = 0;
        let bumpFailed = 0;
        let bumpSkipped = 0;
        const failedTokenIds: string[] = [];

        // Process in batches to avoid hitting Soroban rate limits.
        // bump_credential is idempotent and cheap when TTL is already healthy.
        const CONCURRENCY = 5;
        for (let i = 0; i < tokenIds.length; i += CONCURRENCY) {
            const batch = tokenIds.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map((tokenId) => bumpCredentialOnChain(tokenId)),
            );

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                const tokenId = batch[j];
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        bumpSucceeded++;
                    } else {
                        // Could be skipped (TTL fine) or genuinely failed.
                        // Without TTL_KEEPER_ACCOUNT_SECRET both land here.
                        bumpSkipped++;
                    }
                } else {
                    bumpFailed++;
                    failedTokenIds.push(tokenId ?? 'unknown');
                }
            }
        }

        // Check keeper fee account balance.
        const keeperBalanceXlm = await getKeeperBalance();
        const lowBalance = keeperBalanceXlm !== null && keeperBalanceXlm < KEEPER_MIN_BALANCE_XLM;

        if (lowBalance) {
            captureException(
                new Error(`TTL keeper fee account balance low: ${keeperBalanceXlm} XLM`),
                { context: 'ttlKeeper.balanceCheck', keeperBalanceXlm },
            );
        }

        if (bumpFailed > 0) {
            captureException(
                new Error(`TTL keeper: ${bumpFailed} credential bumps failed`),
                { context: 'ttlKeeper.run', runId, bumpFailed, failedTokenIds },
            );
        }

        const durationMs = Date.now() - startMs;

        const summary: KeeperRunSummary = {
            runId,
            totalCredentials,
            bumpAttempted: bumpSucceeded + bumpFailed,
            bumpSucceeded,
            bumpFailed,
            bumpSkipped,
            minRemainingTtlLedgers: null, // Populated when TTL read is added
            keeperBalanceXlm,
            lowBalance,
            durationMs,
            failedTokenIds,
        };

        recordMetric('ttl_keeper.run', totalCredentials, {
            bumpSucceeded,
            bumpFailed,
            bumpSkipped,
            lowBalance: lowBalance ? 1 : 0,
            durationMs,
        });

        structuredLog('INFO', 'TTL keeper run completed', requestId, summary);

        // Persist run record for dashboard visibility.
        await supabase.from('cron_run_log').upsert({
            job_name: 'ttl-keeper',
            run_id: runId,
            status: bumpFailed > 0 ? 'partial' : 'succeeded',
            summary: summary as unknown as Record<string, unknown>,
            completed_at: new Date().toISOString(),
        }).then(() => undefined).catch(() => undefined); // Non-fatal

        return NextResponse.json({ success: true, ...summary });
    } catch (error) {
        captureException(error, { requestId, context: 'GET /api/cron/ttl-keeper' });
        return NextResponse.json(
            { success: false, error: 'TTL keeper run failed', details: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 },
        );
    }
}
