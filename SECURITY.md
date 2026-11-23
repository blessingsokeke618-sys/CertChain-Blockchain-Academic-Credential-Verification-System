# Security Advisories

## Static analysis coverage

CodeQL runs on every push and pull request to `main` (and weekly) for both
`javascript-typescript` and `rust`, using the `security-extended` and
`security-and-quality` query suites. The Rust job builds the Soroban contract
for `wasm32v1-none` before analysis because `contracts/src/lib.rs` is the
highest-value attack surface and needs compiled code for a useful database.
Soroban/WASM is therefore **included**, not excluded: the contract sources are
analysed as Rust, while the generated WASM itself is not separately scanned —
its behaviour derives from those sources and the pinned `soroban-sdk`, which is
covered by the dependency audit below. Results are uploaded to the repository's
Security tab for both languages.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

To report a security issue, email **security@acredia.app** with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept (screenshots, logs, or code snippets).
- Affected versions or components.

**What to expect:**

- Acknowledgement within **48 hours** of your report.
- A status update within **7 days** as we assess severity and scope.
- We will coordinate a disclosure date with you once a fix is ready.
- Credits in the release notes for responsible disclosure (opt-in).

Do not publish details of the vulnerability until we have released a fix and agreed on a disclosure date. If you do not receive a response within 7 days, follow up at the same address referencing your original report.

## Secrets Management and Rotation

The authoritative runbook for secret storage, testnet/mainnet profile separation,
and emergency key rotation is in `SECRETS_ROTATION.md`.

Highlights:

- Server-only secrets must never be exposed via `NEXT_PUBLIC_*` variables.
- Use one network selector: `NEXT_PUBLIC_STELLAR_NETWORK` (`testnet`, `mainnet`, `custom`).
- Rotate immediately if secrets were committed/shared in issues, logs, screenshots, or chat.
- Repository protections include `gitleaks` in CI and a pre-commit `gitleaks` hook.

## Public Verification Audit Logs

`/api/verify/[token]` writes an operational audit row only after its rate limiter
allows the request. Logs are stored in `verification_logs.verification_result`
with a coarse `result_type` such as `verified`, `revoked`, `not_found`,
`chain_unavailable`, or `mismatch`.

The route does not store raw IP addresses, raw token IDs, user-agent strings,
verifier email, or verifier organization. Request identifiers are HMAC hashes
derived from `VERIFICATION_LOG_HASH_SECRET`; if that is not set, the server-only
`SUPABASE_SERVICE_ROLE_KEY` is used as the fallback secret. Set a dedicated
`VERIFICATION_LOG_HASH_SECRET` in production when possible.

Verification logs are for abuse detection, aggregate reliability monitoring,
and incident response. Treat them as operational data: keep them admin-only,
avoid exporting raw rows, and purge rows older than 90 days unless an active
security investigation or legal requirement needs a longer hold.

Example retention cleanup:

```sql
DELETE FROM public.verification_logs
WHERE created_at < NOW() - INTERVAL '90 days';
```

## Dependency Audit Cadence

**Owner:** maintainers (@blessingsokeke618-sys)
**Frequency:** monthly, and immediately after any dependency update that bumps a major version.
**Tool:** `npm audit` (frontend) + `cargo audit` (contracts via `cargo-audit`)
**Where results are recorded:** Update the audit table below after each run.

To run locally:

```bash
# Frontend
cd frontend && npm audit

# Contracts (requires cargo-audit)
cd contracts && cargo audit
```

---

## Dependency Audit — 2026-05-27

All known vulnerabilities resolved. `npm audit` reports **0 vulnerabilities**.

### Fixes Applied

| Package | Issue | Resolution |
|---|---|---|
| `axios` (via `@stellar/stellar-sdk`) | SSRF, prototype pollution, header injection (HIGH) | Forced to `^1.16.1` via `overrides` |
| `postcss` (bundled by `next`) | XSS via unescaped `</style>` (MODERATE) | Forced to `^8.5.10` via `overrides` |
| `next` | DoS, cache poisoning, middleware bypass (HIGH) | Upgraded to `^15.5.14` (latest stable) |
| `follow-redirects` | Auth header leakage on cross-domain redirect (MODERATE) | Resolved via `npm audit fix` |
| `ws` | Uninitialized memory disclosure (MODERATE) | Resolved via `npm audit fix` |
| `ajv` | ReDoS via `$data` option (MODERATE) | Resolved via `npm audit fix` |
| `@stellar/stellar-sdk` | Transitive axios vulnerability | Upgraded to `^15.1.0` |
| `vitest` / `esbuild` | Dev server request interception (MODERATE) | Upgraded `vitest` to `^4.1.7` |

### npm `overrides`

Two transitive dependencies are pinned in `package.json` `overrides` because upstream packages do not yet declare patched versions as their minimum:

```json
"overrides": {
  "axios": "^1.16.1",
  "postcss": "^8.5.10"
}
```

These overrides should be removed once `@stellar/stellar-sdk` and `next` declare patched minimums in their own `package.json`.
