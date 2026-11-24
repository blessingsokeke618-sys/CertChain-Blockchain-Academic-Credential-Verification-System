# Add SEP-0010-style wallet sign-in (#94)

## Summary

Wallet connection was separate from authentication. This adds server-side challenge issuance and signature verification
that authenticates only already-provisioned accounts, with replay/tamper protection and email/password retained as
recovery. Connecting a wallet alone never grants a role.

## What changed

- **`frontend/src/lib/walletOwnership.ts`** — `buildWalletLoginMessage()`, purpose-specific and bound to both address and
  nonce, distinct from the claim message.
- **`frontend/src/app/api/auth/wallet/challenge/route.ts`** (new) — rate-limited challenge endpoint storing a 5-minute
  nonce in `wallet_claim_nonces` with `purpose = 'login'`.
- **`frontend/src/app/api/auth/wallet/verify/route.ts`** (new) — validates the signature, atomically consumes the
  nonce, requires a `students` row with an existing `auth_user_id` and email, then issues a single-use Supabase magic-link
  session for that provisioned account. Unknown addresses, expired/consumed challenges, tampered messages and bad
  signatures are rejected; no account or role is created.
- **Migration `20261124000000_wallet_login_nonce_purpose.sql`** plus `schema.sql` — adds the `purpose` column and index
  so claim and login challenges cannot be crossed.
- **`frontend/tests/walletLogin.test.ts`** — message distinction and binding tests.
- **`docs/auth-flow.md`** — documents the flow and its security guarantees.

## Acceptance criteria addressed

- A valid signature authenticates only a known provisioned account.
- Replay, tampered and unknown-address attempts are rejected (single-use nonce, purpose filter, exact message binding,
  provisioned-account lookup).

closes #94
