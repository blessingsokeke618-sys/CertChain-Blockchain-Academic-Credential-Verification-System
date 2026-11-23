# Test claim nonce and claim verify routes (#126)

## Summary

The replay protection behind student credential ownership had no route-level tests. This adds a focused Vitest suite
covering nonce issuance, consumption, expiry and signature verification with a mocked Supabase nonce store.

## What changed

- **`frontend/tests/claimRoutes.test.ts`** (new) — mocks `getServiceRoleClient` with an in-memory `wallet_claim_nonces`
  store, plus rate limiting, address validation, hashing, logging and `verifyWalletSignature`. Tests assert:
  - a fresh nonce is issued with a message bound to the wallet and stored unconsumed;
  - a valid signature succeeds exactly once — the nonce is consumed and a replay is rejected without creating a second
    account;
  - an expired nonce is rejected with the expiry message and no account creation;
  - an invalid signature returns 401 and leaves the nonce unconsumed.

## Acceptance criteria addressed

- Reused nonces are rejected.
- Valid signatures succeed exactly once.

closes #126
