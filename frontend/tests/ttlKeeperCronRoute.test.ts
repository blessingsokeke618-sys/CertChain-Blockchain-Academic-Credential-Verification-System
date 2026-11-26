import { NextRequest } from 'next/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const contractCall = vi.fn((...args: unknown[]) => ({ operation: args }));
  const getLedgerEntries = vi.fn();
  const sign = vi.fn();

  class Contract {
    call(...args: unknown[]) {
      return contractCall(...args);
    }
    address() {
      return { toScAddress: () => ({}) };
    }
  }

  class TransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { sign };
    }
  }

  class Server {
    getLedgerEntries(...args: unknown[]) {
      return getLedgerEntries(...args);
    }
    getAccount = vi.fn().mockResolvedValue({});
    simulateTransaction = vi.fn().mockResolvedValue({ result: {} });
    sendTransaction = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-hash' });
    getTransaction = vi.fn().mockResolvedValue({ status: 'SUCCESS' });
  }

  return {
    contractCall,
    getLedgerEntries,
    sign,
    Contract,
    TransactionBuilder,
    Server,
    authorizeCronRequest: vi.fn(),
    getServiceRoleClient: vi.fn(),
    getRpcClient: vi.fn(() => ({ serverURL: new URL('http://localhost:8000') })),
    captureException: vi.fn(),
    structuredLog: vi.fn(),
    recordMetric: vi.fn(),
    fromSecret: vi.fn(() => ({ publicKey: () => 'GTESTKEEPER', sign })),
    nativeToScVal: vi.fn((value: unknown) => value),
  };
});

vi.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: mocks.Server,
    assembleTransaction: () => ({ build: () => ({ sign: mocks.sign }) }),
    Api: {
      isSimulationError: () => false,
      GetTransactionStatus: {
        SUCCESS: 'SUCCESS',
        NOT_FOUND: 'NOT_FOUND',
        FAILED: 'FAILED',
      },
    },
  },
  Contract: mocks.Contract,
  TransactionBuilder: mocks.TransactionBuilder,
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
  BASE_FEE: '100',
  Keypair: { fromSecret: mocks.fromSecret },
  nativeToScVal: mocks.nativeToScVal,
  xdr: {
    LedgerKey: {
      contractData: vi.fn((contractData: unknown) => ({ contractData })),
    },
    LedgerKeyContractData: class {
      constructor(public input: unknown) {}
    },
    ContractDataDurability: { persistent: { name: 'persistent', value: 1 } },
  },
}));

vi.mock('@/lib/serverAuth', () => ({
  getServiceRoleClient: mocks.getServiceRoleClient,
}));

vi.mock('@/lib/cronAuth', () => ({
  authorizeCronRequest: mocks.authorizeCronRequest,
}));

vi.mock('@/lib/debug', () => ({
  captureException: mocks.captureException,
  structuredLog: mocks.structuredLog,
  recordMetric: mocks.recordMetric,
}));

vi.mock('@/lib/contractReads', () => ({
  getRpcClient: mocks.getRpcClient,
}));

vi.mock('@/lib/runtimeConfig', () => ({
  getConfiguredContractId: () => 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}));

const ORIGINAL_ENV = { ...process.env };

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/ttl-keeper', {
    method: 'GET',
    headers,
  });
}

/**
 * Installs a Supabase client whose credentials page contains `rows`. The
 * cursor table starts empty, so the keeper reads the first page.
 */
function installSupabase(rows: Array<{ token_id: number; revoked: boolean }>) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const runLogUpsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === 'cron_run_log') {
      return { upsert: runLogUpsert };
    }
    if (table === 'ttl_keeper_cursor') {
      return {
        select: () => ({ eq: () => ({ maybeSingle }) }),
        upsert,
      };
    }
    return {
      select: () => ({
        order: () => ({
          limit: () =>
            Object.assign(Promise.resolve({ data: rows, error: null }), {
              gt: () => Promise.resolve({ data: rows, error: null }),
            }),
        }),
      }),
    };
  });
  mocks.getServiceRoleClient.mockReturnValue({ from });
  return { from, upsert, runLogUpsert };
}

describe('TTL keeper cron route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    process.env.CRON_SECRET = 'test-secret';
    process.env.TTL_KEEPER_ACCOUNT_SECRET = 'STESTKEEPERSECRET';
    delete process.env.TTL_KEEPER_ACCOUNT_PUBLIC;
    mocks.authorizeCronRequest.mockReturnValue({ ok: true });
    mocks.getLedgerEntries.mockResolvedValue({
      entries: [{ liveUntilLedgerSeq: 100 }],
      latestLedger: 1000,
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('keeps revoked credentials in the bump set and reports them in the summary', async () => {
    const { runLogUpsert } = installSupabase([
      { token_id: 1001, revoked: true },
      { token_id: 1002, revoked: false },
    ]);

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.summary).toMatchObject({
      status: 'succeeded',
      totalCredentials: 2,
      revokedTotal: 1,
      bumpAttempted: 2,
      bumpSucceeded: 2,
      bumpFailed: 0,
    });

    // Both rows, including the revoked one, reached bump_credential.
    expect(mocks.contractCall.mock.calls.map((call) => call[0])).toEqual([
      'bump_credential',
      'bump_credential',
    ]);
    expect(mocks.contractCall.mock.calls.map((call) => call[1])).toEqual([
      BigInt(1001),
      BigInt(1002),
    ]);

    // Each successful bump records its transaction hash in the summary and
    // in the structured run log.
    expect(body.summary.bumpedTransactions).toEqual([
      { tokenId: '1001', txHash: 'tx-hash' },
      { tokenId: '1002', txHash: 'tx-hash' },
    ]);
    expect(mocks.structuredLog).toHaveBeenCalledWith(
      'INFO',
      'TTL keeper run complete',
      expect.any(String),
      expect.objectContaining({
        bumpedTransactions: [
          { tokenId: '1001', txHash: 'tx-hash' },
          { tokenId: '1002', txHash: 'tx-hash' },
        ],
      }),
    );
    expect(runLogUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_name: 'ttl-keeper', status: 'succeeded' }),
      { onConflict: 'job_name,run_id' },
    );
  });

  it('is a no-op for credentials whose TTL is already above the threshold', async () => {
    const { runLogUpsert } = installSupabase([{ token_id: 1001, revoked: false }]);
    // Remaining TTL (~46 days of ledgers) is far above the ~6-month
    // PERSISTENT_THRESHOLD, so a second run after a successful bump skips
    // the on-chain call entirely.
    mocks.getLedgerEntries.mockResolvedValue({
      entries: [{ liveUntilLedgerSeq: 4_000_000 }],
      latestLedger: 1000,
    });

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.summary).toMatchObject({
      status: 'succeeded',
      totalCredentials: 1,
      bumpAttempted: 0,
      bumpSucceeded: 0,
      bumpSkipped: 1,
      bumpedTransactions: [],
    });
    expect(mocks.contractCall).not.toHaveBeenCalled();
    expect(runLogUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_name: 'ttl-keeper', status: 'succeeded' }),
      { onConflict: 'job_name,run_id' },
    );
  });

  it('records a missing keeper secret as a failed run', async () => {
    const { runLogUpsert } = installSupabase([]);
    delete process.env.TTL_KEEPER_ACCOUNT_SECRET;

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject({ success: false, status: 'failed' });
    expect(runLogUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        job_name: 'ttl-keeper',
        status: 'failed',
        summary: { error: 'TTL_KEEPER_ACCOUNT_SECRET not configured' },
      }),
      { onConflict: 'job_name,run_id' },
    );
  });

  it('surfaces a missing run-log table instead of returning a successful response', async () => {
    const { runLogUpsert } = installSupabase([]);
    runLogUpsert.mockResolvedValue({
      error: { message: 'relation "cron_run_log" does not exist' },
    });

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: 'Failed to record TTL keeper run',
      details: 'relation "cron_run_log" does not exist',
    });
  });

  it('marks a run failed when TTL reads fail for every credential', async () => {
    installSupabase([{ token_id: 1001, revoked: false }]);
    mocks.getLedgerEntries.mockRejectedValue(new Error('RPC unavailable'));

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      summary: { ttlReadFailed: 1, bumpFailed: 0 },
      alert: true,
    });
  });

  it('returns the auth failure from the cron guard', async () => {
    mocks.authorizeCronRequest.mockReturnValue({
      ok: false,
      status: 401,
      error: 'Unauthorized',
    });

    const { GET } = await import('@/app/api/cron/ttl-keeper/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});
