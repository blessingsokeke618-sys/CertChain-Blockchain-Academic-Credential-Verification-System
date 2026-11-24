# Rate-limit IPFS issuance uploads per institution (#89)

## Summary

The IPFS upload routes used during credential issuance had per-IP and per-user quotas only, so several accounts in one
institution could each spend the shared Pinata budget. A per-institution quota now applies to both JSON and file uploads.

## What changed

- **`frontend/src/app/api/ipfs/json/route.ts`** and **`frontend/src/app/api/ipfs/file/route.ts`**
  - Added `IPFS_*_INSTITUTION_QUOTA` (30 requests/minute) enforced with `identifier: authCheck.institutionId`, falling
    back to the user id when membership resolution is unavailable.
  - The limit is applied after the existing per-IP and per-user checks, so a request passes all three or is rejected with
    the standard 429 and `Retry-After` response.

## Acceptance criteria addressed

- Issuance uploads are throttled per institution, not only per account or IP.

closes #89
