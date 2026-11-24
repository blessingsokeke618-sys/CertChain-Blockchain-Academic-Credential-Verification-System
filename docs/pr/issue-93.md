# Queue revocation email notifications (#93)

## Summary

Issuance already queued a student email, but revocation did not. The revocation path now enqueues the same bounded,
preference-aware notification job, and the ops guide documents retry and unsubscribe behaviour for both events.

## What changed

- **`frontend/src/lib/credentialService.ts`** — after a successful revocation and DB update, calls
  `POST /api/notifications/trigger` with `{ type: 'revoked', tokenId }`, mirroring the issuance path. The route enforces
  institution ownership, write permission and rate limits; transient failures are logged without failing the revocation.
- **`docs/ops/email-configuration.md`** — documents that both events queue `send_email` jobs containing only the email,
  name, institution and public verification link; the worker retries failed sends via the jobs queue and honours
  `notification_preferences` (shared with the public unsubscribe route).

## Acceptance criteria addressed

- Issue and revoke each produce one notification with a verification link.
- Unsubscribed recipients receive nothing (worker preference check); retry is handled by the existing job queue.

closes #93
