# TTL Keeper Runbook

Soroban persistent storage entries expire unless their TTL is extended. The
credential contract exposes a permissionless `bump_credential` entrypoint, and
the TTL keeper is the scheduled job that calls it before entries archive.

---

## What it does

`GET /api/cron/ttl-keeper` (`frontend/src/app/api/cron/ttl-keeper/route.ts`),
scheduled daily at 02:00 UTC via `frontend/vercel.json`:

1. Reads a page of credential `token_id`s from Supabase, continuing from a
   persisted keyset cursor (`ttl_keeper_cursor` table) so successive runs cover
   the whole set.
2. For each token ID, reads the on-chain entry's `liveUntilLedgerSeq` via
   `getLedgerEntries` and computes the remaining TTL in ledgers.
3. When remaining TTL is below `TTL_THRESHOLD_LEDGERS` (~6 months, matching the
   contract's `PERSISTENT_THRESHOLD`), submits a `bump_credential`
   transaction signed by the keeper account.
4. When remaining TTL is already healthy, skips the on-chain call — a second
   run after a successful bump is a no-op for that credential.
5. Records a per-run summary including `bumpedTransactions`
   (`{ tokenId, txHash }` pairs) so every bump leaves an auditable on-chain
   trail, plus `minRemainingTtlLedgers`, keeper balance, and coverage counts.
   The run is stored in `cron_run_log` with `succeeded`, `partial`, or
   `failed` status for the admin dashboard.

Revoked credentials are deliberately included: their entries must outlive the
TTL window so verification reports "revoked" rather than "not found".

---

## Configuration

```bash
# Required — secret key of the dedicated, funded keeper account.
# Without it the route returns 503 rather than silently skipping bumps.
TTL_KEEPER_ACCOUNT_SECRET=S...keeper_secret_key

# Optional — public key, used for the fee-account balance check and the
# lowBalance alert. Omitting it disables the balance check (non-fatal).
TTL_KEEPER_ACCOUNT_PUBLIC=G...keeper_public_key
```

Generate a dedicated keypair (do not reuse an institution or owner key):

```bash
stellar keys generate keeper --network testnet   # or --network public
```

Fund the account with enough XLM to cover Soroban fees. The run alerts
(`lowBalance: true`, `alert: true` in the response) when the balance drops
below `KEEPER_MIN_BALANCE_XLM` (5 XLM).

`CRON_SECRET` must be set for Vercel Cron authorization (see
`SECRETS_ROTATION.md`).

---

## Verifying a run

The JSON response contains `summary`:

```json
{
  "success": true,
  "summary": {
    "bumpAttempted": 3,
    "bumpSucceeded": 3,
    "bumpSkipped": 497,
    "bumpedTransactions": [
      { "tokenId": "1042", "txHash": "<stellar tx hash>" }
    ],
    "minRemainingTtlLedgers": 120000,
    "lowBalance": false,
    "wrapped": false
  }
}
```

- Look up each `txHash` on the Stellar Expert explorer for the configured
  network to confirm the `bump_credential` invocation succeeded.
- `bumpSkipped` counts credentials whose TTL is already above the threshold —
  expected to be the large majority on a healthy second run.
- `minRemainingTtlLedgers` below `TTL_THRESHOLD_LEDGERS` sets `alert: true`;
  investigate credentials that repeatedly fail to bump (`failedTokenIds`).

The admin dashboard surfaces the latest run via `GET /api/admin/stats`
(`ttlKeeper` field, backed by `cron_run_log`).
Missing keeper configuration and RPC read failures are recorded as failed run
outcomes; a failure to write or read the run log is returned as an explicit
server error rather than being treated as an empty result.

---

## Manual invocation

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<deployment>/api/cron/ttl-keeper
```

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `503 TTL_KEEPER_ACCOUNT_SECRET not configured` | Env var missing on the host | Set the secret in the deployment environment and redeploy |
| `bumpFailed` > 0 with `failedTokenIds` populated | RPC errors, simulation failures, or insufficient fee balance | Check `lowBalance`; check Soroban RPC health; failed IDs are retried on the next run because the cursor only advances past successfully processed pages |
| `lowBalance: true` | Keeper account XLM below 5 | Fund the keeper account before the next scheduled run |
| `minRemainingTtlLedgers` keeps dropping | Bumps failing or credentials issued with short TTL | Check contract `PERSISTENT_THRESHOLD`; investigate `failedTokenIds` |
| Run covers only part of the credential set | Keyset cursor mid-sweep | Expected — successive daily runs continue from `ttl_keeper_cursor.last_token_id`; the cursor resets to `null` (wraps) at the end of the set |

---

## Idempotency

- `bump_credential` is permissionless and internally a no-op when the entry's
  TTL is already above `PERSISTENT_THRESHOLD`, so duplicate submissions are
  safe.
- The keeper additionally skips the transaction entirely when the measured
  remaining TTL is above `TTL_THRESHOLD_LEDGERS`, so a second run over
  already-bumped credentials submits nothing.
- Cursor writes are best-effort; a lost cursor only restarts the sweep from
  the beginning, which is safe for the same reason.
