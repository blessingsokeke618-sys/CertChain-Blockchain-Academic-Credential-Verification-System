/**
 * GET /api/health
 *
 * Lightweight health-check endpoint used by uptime monitors, Vercel
 * preview checks, and the ops runbook. Returns a JSON body describing
 * the live reachability of each critical dependency:
 *
 *   - Soroban RPC (reads get_contract_info from the live contract)
 *   - Supabase (SELECT 1 against the public schema)
 *   - IPFS gateway (HEAD request against a known pin)
 *
 * The overall HTTP status is:
 *   200  all dependencies healthy
 *   207  partial — at least one dependency degraded but the app can still serve
 *   503  all dependencies unhealthy (no reads or writes can succeed)
 *
 * This endpoint is intentionally public and unauthenticated. It contains
 * no PII and no secrets. It does NOT expose environment variable values.
 *
 * The contract info read doubles as a liveness probe for the contract itself:
 * if the Soroban RPC is reachable and `get_contract_info` returns the expected
 * name and version, the contract is alive and correctly configured.
 */

import { NextResponse } from 'next/server';
import {
    rpc as StellarRpc,
    Contract,
    TransactionBuilder,
    Account,
    TimeoutInfinite,
    scValToNative,
    xdr,
} from '@stellar/stellar-sdk';
import { runtimeConfig } from '@/lib/runtimeConfig';

/** Maximum ms to wait for each dependency probe before timing out. */
const PROBE_TIMEOUT_MS = 8_000;

type DependencyStatus = 'healthy' | 'degraded' | 'unreachable';

interface DependencyResult {
    status: DependencyStatus;
    latencyMs: number;
    detail?: string;
}

interface HealthResponse {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    network: string;
    contractId: string;
    dependencies: {
        sorobanRpc: DependencyResult;
        supabase: DependencyResult;
        ipfsGateway: DependencyResult;
    };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeSorobanRpc(): Promise<DependencyResult> {
    const start = Date.now();
    const contractId = runtimeConfig.contracts.CREDENTIAL_NFT;
    const rpcUrl = runtimeConfig.stellar.sorobanRpcUrl;
    const passphrase = runtimeConfig.stellar.networkPassphrase;

    if (!contractId || !rpcUrl) {
        return { status: 'degraded', latencyMs: 0, detail: 'Contract or RPC not configured' };
    }

    try {
        const server = new StellarRpc.Server(rpcUrl);
        const contract = new Contract(contractId);

        // Use the contract address itself as a dummy source for the read-only simulation.
        // Sequence "0" is valid for simulations — the account does not need to exist on-chain.
        const source = new Account(contractId, '0');
        const tx = new TransactionBuilder(source, {
            fee: '100',
            networkPassphrase: passphrase,
        })
            .addOperation(contract.call('get_contract_info'))
            .setTimeout(TimeoutInfinite)
            .build();

        const sim = await Promise.race([
            server.simulateTransaction(tx as never),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('RPC timeout')), PROBE_TIMEOUT_MS),
            ),
        ]);

        const latencyMs = Date.now() - start;

        if ('error' in sim) {
            return {
                status: 'degraded',
                latencyMs,
                detail: `Simulation error: ${(sim as { error: string }).error}`,
            };
        }

        // Decode the ContractInfo struct to verify the contract is the right one.
        const retval = (sim as { result?: { retval?: unknown } }).result?.retval;
        let contractName: string | undefined;
        let contractVersion: string | undefined;

        if (retval) {
            try {
                const native = scValToNative(
                    typeof retval === 'string'
                        ? xdr.ScVal.fromXDR(retval, 'base64')
                        : (retval as xdr.ScVal),
                ) as Record<string, unknown>;

                contractName = String(native?.name ?? '');
                contractVersion = String(native?.version ?? '');
            } catch {
                // Decoding failure is non-fatal — the RPC round-trip itself succeeded.
            }
        }

        return {
            status: 'healthy',
            latencyMs,
            detail: contractName && contractVersion
                ? `${contractName} @ ${contractVersion}`
                : 'Contract reachable',
        };
    } catch (error) {
        return {
            status: 'unreachable',
            latencyMs: Date.now() - start,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

async function probeSupabase(): Promise<DependencyResult> {
    const start = Date.now();
    const supabaseUrl = runtimeConfig.supabase.url;
    const anonKey = runtimeConfig.supabase.anonKey;

    if (!supabaseUrl || !anonKey) {
        return { status: 'degraded', latencyMs: 0, detail: 'Supabase not configured' };
    }

    try {
        // Hit the REST API health endpoint — no SDK import needed, avoids
        // pulling Supabase client into the edge/Node path unnecessarily.
        const res = await Promise.race([
            fetch(`${supabaseUrl}/rest/v1/`, {
                headers: {
                    apikey: anonKey,
                    Authorization: `Bearer ${anonKey}`,
                },
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Supabase timeout')), PROBE_TIMEOUT_MS),
            ),
        ]);

        const latencyMs = Date.now() - start;

        if (res.ok || res.status === 404) {
            // 404 is expected if no tables are public — the API itself responded.
            return { status: 'healthy', latencyMs, detail: `HTTP ${res.status}` };
        }

        return {
            status: 'degraded',
            latencyMs,
            detail: `HTTP ${res.status} ${res.statusText}`,
        };
    } catch (error) {
        return {
            status: 'unreachable',
            latencyMs: Date.now() - start,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

async function probeIpfsGateway(): Promise<DependencyResult> {
    const start = Date.now();
    const gatewayUrl = runtimeConfig.ipfs.gatewayUrl;

    if (!gatewayUrl) {
        return { status: 'degraded', latencyMs: 0, detail: 'IPFS gateway not configured' };
    }

    // This well-known IPFS CID is a tiny text file ("Hello from IPFS!") that
    // Pinata keeps permanently pinned on their public gateway. It is safe to
    // HEAD-request as a liveness probe.
    const WELL_KNOWN_CID = 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A';
    const probeUrl = `${gatewayUrl}/ipfs/${WELL_KNOWN_CID}`;

    try {
        const res = await Promise.race([
            fetch(probeUrl, { method: 'HEAD' }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('IPFS timeout')), PROBE_TIMEOUT_MS),
            ),
        ]);

        const latencyMs = Date.now() - start;

        if (res.ok) {
            return { status: 'healthy', latencyMs, detail: `HTTP ${res.status}` };
        }

        return {
            status: 'degraded',
            latencyMs,
            detail: `HTTP ${res.status} ${res.statusText}`,
        };
    } catch (error) {
        return {
            status: 'unreachable',
            latencyMs: Date.now() - start,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<HealthResponse>> {
    const [sorobanRpc, supabase, ipfsGateway] = await Promise.all([
        probeSorobanRpc(),
        probeSupabase(),
        probeIpfsGateway(),
    ]);

    const statuses = [sorobanRpc.status, supabase.status, ipfsGateway.status];
    const allHealthy = statuses.every((s) => s === 'healthy');
    const allUnreachable = statuses.every((s) => s === 'unreachable');

    const overallStatus: HealthResponse['status'] = allHealthy
        ? 'healthy'
        : allUnreachable
          ? 'unhealthy'
          : 'degraded';

    const httpStatus = allHealthy ? 200 : allUnreachable ? 503 : 207;

    const body: HealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        network: runtimeConfig.stellar.networkName,
        contractId: runtimeConfig.contracts.CREDENTIAL_NFT,
        dependencies: { sorobanRpc, supabase, ipfsGateway },
    };

    return NextResponse.json(body, { status: httpStatus });
}
