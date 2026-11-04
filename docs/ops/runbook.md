# Operations Runbook

On-call procedures and incident response for CertChain operators.

---

## Severity Levels

| Level | Description | Response time |
|---|---|---|
| P0 | All credential verification broken; contract unreachable | Immediate |
| P1 | Issuance broken for all institutions; auth down | < 1 hour |
| P2 | Single institution cannot issue; IPFS degraded | < 4 hours |
| P3 | Non-critical feature broken; UI only | Next business day |

---

## Common Incidents

### P0 — Contract unreachable

**Symptoms:** `/verify` returns errors; browser console shows Soroban RPC failures.

**Steps:**
1. Check Stellar network status: https://status.stellar.org
2. Check Soroban RPC health:
   ```bash
   curl -s https://soroban-testnet.stellar.org -X POST \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":{}}' | jq .
   ```
3. If the RPC is down, set a maintenance banner in the app (env var `NEXT_PUBLIC_MAINTENANCE_MODE=true` if wired up).
4. Wait for SDF to restore the RPC. Stellar testnet RPC outages are typically < 1 hour.
5. If persistent, consider the backup RPC endpoint in `.env.local` (`NEXT_PUBLIC_SOROBAN_RPC_URL`).

### P1 — Issuance broken

**Symptoms:** Institutions get errors on the issuance form; transactions failing.

**Steps:**
1. Check if the contract is paused: `make check-paused` (see `contracts/Makefile`).
2. If paused, check for a known incident. Only the contract owner can unpause:
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --network testnet --source owner -- unpause
   ```
3. Check if the institution's wallet is still authorized:
   ```bash
   make check-issuer ISSUER=<WALLET_ADDRESS>
   ```
4. Check Supabase status: https://status.supabase.com
5. Check Vercel deployment logs for API route errors.

### P2 — IPFS degraded

**Symptoms:** Credential documents load slowly or time out; images missing.

**Steps:**
1. Check Pinata status: https://status.pinata.cloud
2. Verify a specific CID manually:
   ```bash
   curl -I https://gateway.pinata.cloud/ipfs/<CID>
   ```
3. If the primary gateway is down, switch to the public IPFS gateway temporarily by updating
   `NEXT_PUBLIC_PINATA_GATEWAY=https://ipfs.io` in the Vercel env and redeploying.
4. Run the pin keeper to verify redundancy:
   ```bash
   cd frontend && npm run worker:pin-keeper
   ```

### P0 — Database down

**Symptoms:** Login broken; dashboard shows no credentials; all API routes fail.

**Steps:**
1. Check Supabase project status at https://app.supabase.com → your project → Health.
2. If the project is paused (free tier pauses after 1 week of inactivity), click "Restore".
3. If genuinely down, check https://status.supabase.com for an incident.

---

## Regular Maintenance

### Weekly
- [ ] Check pin keeper logs — ensure secondary pins are healthy
- [ ] Check TTL keeper logs — ensure no credentials are approaching expiry
- [ ] Review Vercel function error rate in dashboard

### Monthly
- [ ] Rotate `CRON_SECRET` (see `SECRETS_ROTATION.md`)
- [ ] Review admin audit logs in Supabase
- [ ] Check Supabase database size vs plan limits

### Before each release
- [ ] Run `cd frontend && npm test` — all tests green
- [ ] Run `cd contracts && cargo test` — all tests green
- [ ] Deploy to testnet staging environment first
- [ ] Smoke test: issue one credential, verify it, revoke it

---

## Emergency Contract Pause

If a critical vulnerability is discovered, the contract owner can halt all state-changing
operations immediately:

```bash
stellar contract invoke \
  --id CARWFW27MJ3OJADAUAHI3TDFHIL62YMLVEKTUTMSNXOMH7JJTNZKC3DK \
  --network testnet \
  --source owner \
  -- pause
```

This allows read operations and verification to continue while minting and revocation are halted.
Unpause with `-- unpause` when safe.

---

## Escalation Contacts

| Role | Contact |
|---|---|
| On-call engineer | certchain.stellar@gmail.com |
| Stellar network issues | https://discord.gg/stellardev |
| Supabase support | https://app.supabase.com/support |
| Pinata support | https://app.pinata.cloud/support |
