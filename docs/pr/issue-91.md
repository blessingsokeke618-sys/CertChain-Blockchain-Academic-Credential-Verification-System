# Define and test offline / low-bandwidth verification (#91)

## Summary

Verification failures were reported with the raw fetch error regardless of connectivity, which could be read as "credential invalid" when the real cause was a dropped or slow connection. This defines an explicit policy: verification always requires a fresh network check, cached results may be shown only as stale, and connectivity-specific messages are tested.

## What changed

- **`frontend/src/lib/offlineVerification.ts`** (new) — `classifyConnectivity()`, `verificationFailureMessage()` and
  `OFFLINE_VERIFICATION_POLICY` constants (fresh check required, cached result never counts as verified, no PII cached).
- **`frontend/src/hooks/useCredentialVerification.ts`** — on a failed verify request, uses `navigator.onLine` and the
  connection hint to classify the failure, shows an offline/slow-specific message, clears the verdict and marks integrity
  `unavailable` instead of reporting an invalid credential.
- **`frontend/tests/offlineVerification.test.ts`** — covers classification, messages and the policy constants.
- **`docs/offline-verification.md`** — documents the behaviour matrix and test command.

## Acceptance criteria addressed

- Offline and low-bandwidth behaviour is defined, documented and covered by tests.
- No cached result is ever treated as a valid verification.

closes #91
