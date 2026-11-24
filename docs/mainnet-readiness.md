# Mainnet Readiness

CertChain is production-ready on Stellar **testnet** today. Mainnet deployment is deliberately
deferred. This document tracks exactly what remains, why each item matters, and the cutover
procedure.

---

## Current Status

**5 of 11 areas complete.**

| Area | Status | Notes |
|---|---|---|
| Smart contract functional correctness | ✅ Complete | Full test suite passing, property-based tests |
| Smart contract security audit (internal) | ✅ Complete | See `contracts/SECURITY_AUDIT.md` |
| Frontend deployed and functional (testnet) | ✅ Complete | Live at acredia-stellar-tau.vercel.app |
| Database schema stable with RLS | ✅ Complete | 14 migrations, all idempotent |
| IPFS pin redundancy design | ✅ Complete | `worker/pinKeeper.ts`, secondary provider hook |
| Independent smart-contract audit | ❌ Not started | Required before mainnet |
| Contract owner key custody (multisig / HSM) | ❌ Not decided | Single key is unacceptable for production |
| Credential TTL keeper (funded + monitored) | ⚠️ Partial | Keeper exists; funding and alerting not in place |
| Distributed rate limiting provisioned | ⚠️ Pending deployment | Upstash Redis instance to be created; env vars to be set in production; verify via `/api/admin/rate-limit-health` |
| CRON_SECRET set in production environment | ⚠️ Partial | Route exists; secret not configured on host |
| Custom SMTP configured | ⚠️ Partial | Guide exists; not wired up for production volume |

---

## SEP-0001 discovery document

`frontend/public/stellar.toml` is served at `/.well-known/stellar.toml` through a Next.js
rewrite (Next.js does not serve dot-directories from `public/`). Before announcing a domain —
and after every deployment that changes it — verify the live document:

```bash
cd frontend
DEPLOY_URL=https://acredia-stellar-tau.vercel.app npm run check:stellar-toml
```

The smoke check fails on a 404, a missing/invalid `VERSION`, `SIGNING_KEY`, principal or contract
section, or an `ORG_URL` that does not match `DEPLOY_URL`. Then run the public validator at
<https://stellar.expert/validator> against `https://acredia-stellar-tau.vercel.app/` and confirm
it reports success. `ORG_URL` must stay identical to the domain that serves the file; update it
and re-run both checks if the deployment URL changes.

---

## Blockers in Detail

### 1. Independent Smart-Contract Audit

**Why it's a blocker:** The contract handles real academic credentials with real economic
value (employment decisions, admissions). A bug in `issue_credential` or `revoke_credential`
could allow unauthorised minting or permanent data loss. The internal audit (`SECURITY_AUDIT.md`)
found and fixed five findings; an independent audit may surface more.

**What's needed:** Engage a Soroban-experienced audit firm. Target scope: `contracts/src/lib.rs`.
Estimated duration: 2–4 weeks for a firm familiar with Soroban.

**Known firms with Soroban experience:** OtterSec, Kudelski Security, Trail of Bits (Rust/WASM).

---

### 2. Contract Owner Key Custody

**Why it's a blocker:** The contract owner key controls `authorize_issuer`, `revoke_issuer`,
`admin_revoke_credential`, `pause`, and the upgrade timelock. A single compromised key could
de-authorize every institution or pause the entire platform.

**Options:**
- **Multisig Stellar account** — Set the owner to a Stellar account with a threshold of 2-of-3
  signers. Each signer held by a different team member. Cheapest to implement.
- **Hardware Security Module (HSM)** — Yubikey or Ledger as one of the signers. Best for an
  institution operating at scale.
- **Governance contract** — A separate time-locked governance contract holds ownership. Most
  complex, most decentralised.

**Recommended starting point:** 2-of-3 multisig Stellar account before mainnet. HSM for at
least one signer key.

---

### 3. Credential TTL Keeper

**Why it matters:** Soroban persistent storage entries expire if not bumped. A credential's
TTL is set to ~1 year on issuance. If no one bumps it, the credential entry archives on-chain
and is no longer immediately readable (it can be restored, but that requires a restore operation).

**What exists:** `worker/pinKeeper.ts` runs the IPFS side. A `bump_credential` entry point
exists on the contract and is callable by anyone.

**What's needed:**
- A funded Stellar account dedicated to TTL bumping
- A scheduled process (cron job or Vercel Cron) calling `bump_credential` for all token IDs
  approaching their threshold
- Alerting if the bumper account's balance drops below a safe threshold

---

### 4. Distributed Rate Limiting

**Why it matters:** The `/verify` endpoint is public and unauthenticated. Without distributed
rate limiting, a serverless deployment (Vercel) uses per-instance in-memory state, which
provides no protection against a distributed denial-of-service or credential enumeration attack
across multiple instances.

**What exists:** `frontend/src/lib/rateLimit.ts` is wired to Upstash Redis with graceful
fallback to in-memory.

**What's needed:**
- Create the Upstash Redis instance and record it in the ops inventory
- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the Vercel production environment. This is a configuration step, not a code change.
- Verify the limiter is using Redis: `GET /api/admin/rate-limit-health` should report the Redis backend in production
- Verify cross-instance throttling: a burst of verification requests must be throttled across instances, not per-instance

---

## Cutover Procedure

When all 4 blockers above are resolved:

1. Deploy the contract to Stellar mainnet:
   ```bash
   cd contracts
   make deploy-mainnet
   # Note the returned contract ID
   stellar contract invoke --id <NEW_ID> --network mainnet -- initialize --owner <MULTISIG_ADDRESS>
   ```

2. Update Vercel production environment variables:
   ```
   NEXT_PUBLIC_STELLAR_NETWORK=mainnet
   NEXT_PUBLIC_CREDENTIAL_NFT_CONTRACT=<MAINNET_CONTRACT_ID>
   NEXT_PUBLIC_CREDENTIAL_REGISTRY_CONTRACT=<MAINNET_CONTRACT_ID>
   ```

3. The app will fail to boot if `NEXT_PUBLIC_STELLAR_NETWORK=mainnet` and the contract ID
   matches the known testnet contract. This is intentional — see `runtimeConfig.ts`.

4. Provision the first institution's wallet on mainnet via the admin dashboard.

5. Run the smoke test against mainnet: issue one credential, verify it, revoke it.
   The script is network-parameterized, exits non-zero on any failed step, and
   records transaction hashes to a results file for pass/fail evidence:

   ```bash
   cd frontend
   npx tsx scripts/smoke-test.ts \
     --network mainnet \
     --contract-id <MAINNET_CONTRACT_ID> \
     --issuer-secret-key <ISSUER_SECRET_KEY> \
     --student-address <STUDENT_ADDRESS> \
     --credential-hash <SHA256_HEX>
   ```

   The same script runs in CI against testnet staging (see `.github/workflows/ci.yml`,
   `smoke-test` job). Re-running it immediately after mainnet cutover provides the
   recorded pass/fail evidence the manual exercise previously lacked.

6. Monitor the Stellar Expert explorer for the first 24 hours.

---

## Configuration Safety Rail

`frontend/src/lib/runtimeConfig.ts` throws `UnsafeConfigError` at boot time if:

- `NEXT_PUBLIC_STELLAR_NETWORK=mainnet`
- AND `NEXT_PUBLIC_CREDENTIAL_NFT_CONTRACT` equals the known testnet contract ID
  (`CARWFW27MJ3OJADAUAHI3TDFHIL62YMLVEKTUTMSNXOMH7JJTNZKC3DK`)

This prevents a misconfigured deployment from serving a confident-looking production app
backed by the wrong ledger. The boot fails loudly; there is no silent degraded mode for this
particular error class.
