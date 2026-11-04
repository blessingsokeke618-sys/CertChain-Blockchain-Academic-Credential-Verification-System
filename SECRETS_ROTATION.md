# Secrets Rotation Runbook

This document describes how to rotate every secret used by CertChain, what
to do when a secret is compromised, and the pre-commit / CI secret-scan workflow.

---

## Inventory of Secrets

| Secret | Location | Purpose | Rotation frequency |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env (server-only) | Supabase admin access, bypasses RLS | Annually or on compromise |
| `PINATA_JWT` | Vercel env (server-only) | Pin files to IPFS via Pinata API | Annually or on compromise |
| `VERIFICATION_LOG_HASH_SECRET` | Vercel env (server-only) | HMAC for privacy-safe audit log | Annually |
| `CRON_SECRET` | Vercel env (server-only) | Authenticates `/api/cron/*` routes | Quarterly |
| `RESEND_API_KEY` | Vercel env (server-only) | Transactional email (optional) | Annually or on compromise |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel env (server-only) | Distributed rate limiting | Annually |
| `SECONDARY_PINNING_TOKEN` | Vercel env (server-only) | Secondary IPFS pin provider | Annually |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel env (public) | Supabase anonymous access | On compromise only (RLS-gated) |
| Stellar contract owner secret key | Hardware wallet / secret manager | Signs `authorize_issuer`, `pause`, upgrades | On compromise; migrate to multisig |
| Stellar deployer secret key | Hardware wallet / secret manager | Contract deployment and initialization | Post-deployment, keep offline |

**Never put any secret key (Stellar `S...`) in `.env.local` or any file committed to git.**

---

## When a Secret Is Compromised

### Immediate actions (within 1 hour)

1. **Revoke the compromised secret** at its source:
   - Supabase service role key: Supabase dashboard → Project Settings → API → regenerate.
   - Pinata JWT: Pinata dashboard → API Keys → revoke.
   - Upstash token: Upstash console → Database → Reset token.
   - Resend API key: Resend dashboard → API Keys → delete and recreate.
   - Stellar secret key: cannot be rotated — migrate ownership to a new account (see below).

2. **Update the secret in Vercel** production environment variables immediately and trigger a
   redeployment.

3. **Audit the exposure window.** Review Vercel logs, Supabase logs, and IPFS pin activity for
   the period the secret was exposed.

4. **Rotate all co-located secrets** — a compromised `.env.local` may have exposed multiple
   secrets simultaneously.

### Stellar contract owner key compromise

This is the highest-severity event. The owner key controls `authorize_issuer`, `admin_revoke_credential`,
`pause`, and the upgrade flow.

1. If you have a pending owner setup, use `transfer_owner` + `accept_owner` immediately to move
   ownership to a new keypair.
2. If the attacker may already control the key, pause the contract first:
   ```bash
   cd contracts && make pause OWNER_IDENTITY=<current-key-identity>
   ```
3. Transfer ownership to a new, secure keypair.
4. Unpause once the new key is confirmed.
5. Revoke any issuers that may have been unauthorized by the attacker.
6. Initiate a security incident review.

---

## Routine Rotation Procedures

### Rotate CRON_SECRET (quarterly)

1. Generate a new secret:
   ```bash
   openssl rand -base64 32
   ```
2. Update `CRON_SECRET` in Vercel → Production environment variables.
3. Redeploy the application (the new secret takes effect immediately on the next deploy).
4. Verify the cron runs successfully at the next scheduled time.

### Rotate SUPABASE_SERVICE_ROLE_KEY (annually)

1. Go to Supabase dashboard → Project Settings → API → Service Role → Copy new key.
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Vercel → Production.
3. Update `SUPABASE_SERVICE_ROLE_KEY` in any other environments (staging, dev team `.env.local` files).
4. Redeploy.

### Rotate PINATA_JWT (annually or on compromise)

1. Go to Pinata dashboard → API Keys → Create new key with the same permissions:
   `pinFileToIPFS`, `pinJSONToIPFS`, `unpin`, `pinList`.
2. Update `PINATA_JWT` in Vercel → Production.
3. Revoke the old key in Pinata.
4. Verify the pin keeper and issuance routes work with the new key.

### Rotate VERIFICATION_LOG_HASH_SECRET (annually)

**Note:** Rotating this secret means existing hashed IPs in `verification_logs` cannot be
de-hashed with the old secret. This is acceptable (and intentional — the whole point of hashing
is irreversibility). New verification logs will use the new secret.

1. Generate:
   ```bash
   openssl rand -base64 32
   ```
2. Update `VERIFICATION_LOG_HASH_SECRET` in Vercel → Production.
3. Redeploy.

---

## Secret-Scan Workflow

### Pre-commit (local)

The repository uses [gitleaks](https://github.com/gitleaks/gitleaks) via pre-commit hooks
to scan staged changes before every commit.

Setup (one-time):
```bash
pip install pre-commit
pre-commit install
```

Config: `.pre-commit-config.yaml` at the repo root.

To run manually:
```bash
pre-commit run --all-files
```

### CI secret scan

GitHub Actions runs a secret scan on every push and pull request
(`.github/workflows/secret-scan.yml`). Pull requests from forks are scanned against the
allowed patterns defined in `.gitleaks.toml`.

If gitleaks reports a false positive (e.g. a test fixture with a test-only key), add an
`allow` rule to `.gitleaks.toml` rather than disabling the scan.

---

## What Not to Do

- **Never paste secrets into GitHub issues, PR descriptions, or commit messages.** Even after
  deletion, they remain in git history and GitHub's search index.
- **Never put a secret in a `NEXT_PUBLIC_*` variable.** `runtimeConfig.ts` will refuse to boot
  if it detects a server secret in a `NEXT_PUBLIC_*` env var.
- **Never commit `.env.local`.** It is in `.gitignore`. If you accidentally commit it, rotate
  every secret it contains immediately, even if the commit is reverted.
- **Never share secrets over Slack, email, or chat.** Use a password manager with secure sharing
  (1Password, Bitwarden) or a secrets manager (AWS Secrets Manager, Doppler).
- **Never embed a Stellar secret key (`S...`) anywhere in application code or configuration
  files.** Stellar secret keys belong in a hardware wallet, a CLI keyring, or a secrets manager.
