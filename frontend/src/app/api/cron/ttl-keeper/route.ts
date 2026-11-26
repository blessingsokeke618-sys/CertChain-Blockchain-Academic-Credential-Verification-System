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
 *   1. Reads a page of credential token IDs from the Supabase index,
 *      continuing from a persisted cursor so successive runs cover the
 *      whole set (Issue #137).
 *   2. For each, calls bump_credential on-chain (idempotent; no-op when
 *      TTL is already healthy per PERSISTENT_THRESHOLD).
 *   3. Records a per-run summary (count bumped, count failed, duration,
 *      coverage: processed + remaining).
 *   4. Returns a structured response that the admin dashboard can surface.
 *
 * Scheduled in vercel.json. Calls are authorized via CRON_SECRET.
 *
 * Fee account: the keeper account must be funded with XLM to cover the
 * Soroban transaction fees. Monitor KEEPER_ACCOUNT_MIN_BALANCE_XLM; page
 * on-call when it falls below the threshold.
 */

// How many credentials to bump in a single cron run (page size).
// Adjust based on Vercel function timeout limits (default: 60 s for Hobby,
// 300 s for Pro). Each bump_credential call is a cheap Soroban read+write.
const BATCH_LIMIT = 500;

// Minimum remaining ledgers that triggers a bump call (≈ 6 months, matching
// the PERSISTENT_THRESHOLD constant in the contract).
const TTL_THRESHOLD_LEDGERS = 3_110_400; // ~6 months @ 5 s/ledger

// Minimum XLM balance for the keeper fee account. Alert when below this.
const KEEPER_MIN_BALANCE_XLM = 5;

// Supabase table + key used to persist the keyset cursor across invocations.
const CURSOR_TABLE = 'ttl_keeper_cursor';
const CURSOR_ROW_ID = 'default';

interface KeeperRunSummary {
    runId: string;
    status: 'succeeded' | 'partial' | 'failed';
    totalCredentials: number;
    bumpAttempted: number;
    bumpSucceeded: number;
    bumpFailed: number;
    ttlReadFailed: number;
    bumpSkipped: number;  // TTL already healthy
    // Revoked credentials stay in the bump set (Issue #138): their on-chain
    // entries must outlive the TTL window so verification reports "revoked"
    // rather than "not found". Counted here so the coverage is observable.
    revokedTotal: number;
    minRemainingTtlLedgers: number | null;
    keeperBalanceXlm: number | null;
    lowBalance: boolean;
    durationMs: number;
    failedTokenIds: string[];
    // Transaction hashes for every successful bump, so a scheduled run leaves
    // an auditable on-chain trail (acceptance: "logs the transaction hash").
    bumpedTransactions: Array<{ tokenId: string; txHash: string }>;
    // Coverage (Issue #137): keyset pagination across invocations.
    cursorStart: string | null;
    cursorEnd: string | null;
    processedThisRun: number;
    remainingAfterRun: number;
    wrapped: boolean;
}

type TtlReadResult =
    | { ok: true; remainingTtlLedgers: number | null }
    | { ok: false; error: unknown };

async function recordKeeperRun(
    supabase: ReturnType<typeof getServiceRoleClient>,
    requestId: string,
    runId: string,
    status: KeeperRunSummary['status'],
    summary: KeeperRunSummary | { error: string },
): Promise<string | null> {
    if (status === 'failed') {
        recordMetric('ttl_keeper.failed', 1, { requestId, runId });
    } else if (status === 'partial') {
        recordMetric('ttl_keeper.partial', 1, { requestId, runId });
    }

    const { error } = await supabase.from('cron_run_log').upsert(
        {
            job_name: 'ttl-keeper',
            run_id: runId,
            status,
            summary,
            completed_at: new Date().toISOString(),
        },
        { onConflict: 'job_name,run_id' },
    );

    if (!error) return null;

    structuredLog('ERROR', 'Failed to record TTL keeper run', requestId, {
        runId,
        error: error.message,
    });
    captureException(error, { requestId, runId, context: 'record TTL keeper run' });
    return error.message;
}

function runLogFailureResponse(runId: string, error: string) {
    return NextResponse.json(
        {
            success: false,
            error: 'Failed to record TTL keeper run',
            details: error,
            runId,
        },
        { status: 500 },
    );
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

/**
 * Read the live-until ledger of a credential's persistent entry via
 * getLedgerEntries and return the remaining TTL in ledgers. A missing entry
 * is a bump candidate; RPC failures are reported separately.
 */
async function getRemainingTtlLedgers(tokenId: string): Promise<TtlReadResult> {
    try {
        const rpc = getRpcClient();
        const contractId = getConfiguredContractId('CREDENTIAL_NFT');
        const { rpc: StellarRpc, Contract, nativeToScVal, xdr } = await import('@stellar/stellar-sdk');

        const server = new StellarRpc.Server(rpc.serverURL.toString());
        const contract = new Contract(contractId);
        const key = xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
                contract: contract.address().toScAddress(),
                key: nativeToScVal(BigInt(tokenId), { type: 'u64' }),
                durability: xdr.ContractDataDurability.persistent,
            }),
        );

        const response = await server.getLedgerEntries(key);
        const entry = response.entries?.[0];
        if (!entry) return { ok: true, remainingTtlLedgers: null };

        const latestLedger = response.latestLedger;
        const liveUntil = entry.liveUntilLedgerSeq;
        if (latestLedger == null || liveUntil == null) {
            return { ok: true, remainingTtlLedgers: null };
        }

        return { ok: true, remainingTtlLedgers: Math.max(0, liveUntil - latestLedger) };
    } catch (error) {
        return { ok: false, error };
    }
}

async function bumpCredentialOnChain(tokenId: string): Promise<{ success: boolean; txHash: string | null }> {
    try {
        const rpc = getRpcClient();
        const contractId = getConfiguredContractId('CREDENTIAL_NFT');
        const keeperSecret = process.env.TTL_KEEPER_ACCOUNT_SECRET;

        if (!keeperSecret) {
            // No keeper account configured — cannot submit on-chain bump.
            return { success: false, txHash: null };
        }

        // bump_credential is permissionless — any funded account can call it.
        // It calls extend_credential_ttl internally; it is a no-op (succeeds
        // without writing) when the TTL is already above PERSISTENT_THRESHOLD.
        const { rpc: StellarRpc, TransactionBuilder, Networks, BASE_FEE, Keypair, Contract, nativeToScVal } = await import('@stellar/stellar-sdk');

        const keypair = Keypair.fromSecret(keeperSecret);
        const server = new StellarRpc.Server(rpc.serverURL.toString());
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
        if (StellarRpc.Api.isSimulationError(sim)) {
            return { success: false, txHash: null };
        }

        const prepared = StellarRpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);

        const result = await server.sendTransaction(prepared);
        if (result.status === 'ERROR') {
            return { success: false, txHash: null };
        }

        // Poll for completion
        let getResult = await server.getTransaction(result.hash);
        let attempts = 0;
        while (getResult.status === StellarRpc.Api.GetTransactionStatus.NOT_FOUND && attempts < 10) {
            await new Promise((r) => setTimeout(r, 2000));
            getResult = await server.getTransaction(result.hash);
            attempts++;
        }

        const succeeded = getResult.status === StellarRpc.Api.GetTransactionStatus.SUCCESS;
        return { success: succeeded, txHash: succeeded ? result.hash : null };
    } catch {
        return { success: false, txHash: null };
    }
}

/**
 * Read the persisted keyset cursor (last token_id processed). Returns null
 * when no cursor has been recorded yet (start from the beginning).
 */
async function readCursor(supabase: ReturnType<typeof getServiceRoleClient>): Promise<string | null> {
    try {
        const { data, error } = await supabase
            .from(CURSOR_TABLE)
            .select('last_token_id')
            .eq('id', CURSOR_ROW_ID)
            .maybeSingle();
        if (error || !data) return null;
        const value = (data as { last_token_id?: string | null }).last_token_id;
        return value != null ? String(value) : null;
    } catch {
        return null;
    }
}

/**
 * Persist the keyset cursor so the next invocation continues where this one
 * left off. Best-effort: a failure here only means the next run restarts
 * from the beginning, which is safe (bumps are idempotent).
 */
async function writeCursor(
    supabase: ReturnType<typeof getServiceRoleClient>,
    lastTokenId: string | null,
): Promise<void> {
    try {
        await supabase
            .from(CURSOR_TABLE)
            .upsert(
                { id: CURSOR_ROW_ID, last_token_id: lastTokenId, updated_at: new Date().toISOString() },
                { onConflict: 'id' },
            );
    } catch {
        // Best-effort; see doc comment.
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

    const supabase = getServiceRoleClient();

    if (!process.env.TTL_KEEPER_ACCOUNT_SECRET) {
        const error = 'TTL_KEEPER_ACCOUNT_SECRET not configured';
        structuredLog('WARN', 'TTL keeper skipped: no keeper account configured', requestId);
        const logError = await recordKeeperRun(supabase, requestId, runId, 'failed', { error });
        if (logError) return runLogFailureResponse(runId, logError);
        return NextResponse.json({
            success: false,
            status: 'failed',
            error,
            runId,
        }, { status: 503 });
    }

    const cursorStart = await readCursor(supabase);

    // Fetch a page of credential token IDs, continuing from the cursor.
    // Revoked credentials are deliberately included (Issue #138): excluding
    // them lets their entries archive, and verify_credential would then return
    // "not found" instead of "revoked". bump_credential works on them too.
    let query = supabase
        .from('credentials')
        .select('token_id, revoked')
        .order('token_id', { ascending: true })
        .limit(BATCH_LIMIT);
    if (cursorStart != null) {
        query = query.gt('token_id', cursorStart);
    }

    const { data: rows, error: fetchError } = await query;
    if (fetchError) {
        captureException(fetchError, { runId, phase: 'fetch-credentials' });
        const error = `Failed to read credentials: ${fetchError.message}`;
        const logError = await recordKeeperRun(supabase, requestId, runId, 'failed', { error });
        if (logError) return runLogFailureResponse(runId, logError);
        return NextResponse.json({ success: false, status: 'failed', error, runId }, { status: 500 });
    }

    const revokedTokenIds = new Set<string>();
    const tokenIds = (rows ?? []).flatMap((row) => {
        const r = row as { token_id?: string | number | null; revoked?: boolean | null };
        if (r.token_id == null) return [];
        const tokenId = String(r.token_id);
        if (r.revoked === true) revokedTokenIds.add(tokenId);
        return [tokenId];
    });

    let bumpAttempted = 0;
    let bumpSucceeded = 0;
    let bumpFailed = 0;
    let ttlReadFailed = 0;
    let bumpSkipped = 0;
    let minRemainingTtlLedgers: number | null = null;
    const failedTokenIds: string[] = [];
    const bumpedTransactions: Array<{ tokenId: string; txHash: string }> = [];

    for (const tokenId of tokenIds) {
        // Read the current remaining TTL so the summary can report how close
        // credentials are to archival (Issue #139).
        const ttlRead = await getRemainingTtlLedgers(tokenId);
        if (!ttlRead.ok) {
            captureException(ttlRead.error, { runId, phase: 'read-ttl', tokenId });
            ttlReadFailed++;
            failedTokenIds.push(tokenId);
            continue;
        }

        const remaining = ttlRead.remainingTtlLedgers;
        if (remaining != null) {
            minRemainingTtlLedgers = minRemainingTtlLedgers == null
                ? remaining
                : Math.min(minRemainingTtlLedgers, remaining);
        }

        // Skip the on-chain call when TTL is already healthy.
        if (remaining != null && remaining >= TTL_THRESHOLD_LEDGERS) {
            bumpSkipped++;
            continue;
        }

        bumpAttempted++;
        const { success, txHash } = await bumpCredentialOnChain(tokenId);
        if (success) {
            bumpSucceeded++;
            if (txHash) {
                bumpedTransactions.push({ tokenId, txHash });
            }
        } else {
            bumpFailed++;
            failedTokenIds.push(tokenId);
        }
    }

    const cursorEnd = tokenIds.length > 0 ? tokenIds[tokenIds.length - 1] : cursorStart;
    const wrapped = tokenIds.length < BATCH_LIMIT;
    await writeCursor(supabase, wrapped ? null : cursorEnd);

    const keeperBalanceXlm = await getKeeperBalance();
    const lowBalance = keeperBalanceXlm != null && keeperBalanceXlm < KEEPER_MIN_BALANCE_XLM;

    // Alert when the minimum remaining TTL is below the documented threshold.
    const lowTtl = minRemainingTtlLedgers != null && minRemainingTtlLedgers < TTL_THRESHOLD_LEDGERS;
    if (lowTtl) {
        structuredLog('WARN', 'TTL keeper: credentials below archival threshold', requestId, {
            runId,
            minRemainingTtlLedgers,
            thresholdLedgers: TTL_THRESHOLD_LEDGERS,
        });
        recordMetric('ttl_keeper.low_ttl', 1, { runId });
    }
    if (lowBalance) {
        structuredLog('WARN', 'TTL keeper: fee account balance below threshold', requestId, {
            runId,
            keeperBalanceXlm,
            thresholdXlm: KEEPER_MIN_BALANCE_XLM,
        });
    }

    const failureCount = bumpFailed + ttlReadFailed;
    const status: KeeperRunSummary['status'] = failureCount === 0
        ? 'succeeded'
        : bumpSucceeded > 0 || bumpSkipped > 0
            ? 'partial'
            : 'failed';

    const summary: KeeperRunSummary = {
        runId,
        status,
        totalCredentials: tokenIds.length,
        bumpAttempted,
        bumpSucceeded,
        bumpFailed,
        ttlReadFailed,
        bumpSkipped,
        revokedTotal: revokedTokenIds.size,
        minRemainingTtlLedgers,
        keeperBalanceXlm,
        lowBalance,
        durationMs: Date.now() - startMs,
        failedTokenIds,
        bumpedTransactions,
        cursorStart,
        cursorEnd,
        processedThisRun: tokenIds.length,
        remainingAfterRun: wrapped ? 0 : -1,
        wrapped,
    };

    structuredLog(
        status === 'succeeded' ? 'INFO' : status === 'partial' ? 'WARN' : 'ERROR',
        'TTL keeper run complete',
        requestId,
        {
            runId,
            bumpAttempted,
            bumpSucceeded,
            bumpFailed,
            ttlReadFailed,
            bumpSkipped,
            status,
            bumpedTransactions,
            revokedTotal: summary.revokedTotal,
            minRemainingTtlLedgers,
            lowTtl,
            lowBalance,
            durationMs: summary.durationMs,
        },
    );

    const logError = await recordKeeperRun(supabase, requestId, runId, status, summary);
    if (logError) return runLogFailureResponse(runId, logError);

    return NextResponse.json(
        {
            success: status !== 'failed',
            status,
            summary,
            alert: lowTtl || lowBalance || failureCount > 0,
        },
        { status: status === 'failed' ? 500 : 200 },
    );
}
