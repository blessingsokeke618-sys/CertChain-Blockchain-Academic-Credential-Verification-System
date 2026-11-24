# Offline and low-bandwidth verification

Credential verification is defined as a **fresh** check: the public verify API re-reads the
credential record, IPFS metadata and the on-chain registry before it returns a verdict. Revocation
can happen at any moment, so a locally cached "valid" result is never evidence.

## Behaviour

| Connectivity | Behaviour |
|---|---|
| Online | Normal verification; a failed fetch is reported with the server's message. |
| Slow (`2g` / `slow-2g`) | Verification still runs live; timeouts are explained as connection problems and the user is asked to retry. |
| Offline | No verification is attempted successfully. The UI reports that a fresh network check is required, marks integrity as `unavailable`, and clears any previous verification verdict. |

A cached credential summary may be displayed for convenience, but it is labelled stale and never
drives the `verified` badge. Caches must not store GPA, marks or other granular academic PII —
public verification already omits those fields.

The policy is implemented in `frontend/src/lib/offlineVerification.ts` and applied in
`useCredentialVerification` when the verify request fails.

## Testing

```bash
cd frontend
npm test -- tests/offlineVerification.test.ts
```

The tests pin the connectivity classification, the offline/degraded messages, and the policy
constants so a future change cannot silently start treating cached results as valid.
