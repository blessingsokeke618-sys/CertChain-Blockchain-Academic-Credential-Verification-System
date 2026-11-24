# Serve and validate stellar.toml at the well-known path (#96)

## Summary

`frontend/public/.well-known/stellar.toml` existed but the live domain returned **404** for
`/.well-known/stellar.toml` — Next.js does not serve dot-directories from `public/`. The canonical file now lives at
`public/stellar.toml`, is exposed through a rewrite at the SEP-0001 path, has a corrected canonical `ORG_URL`, and is
covered by a deploy smoke check plus validator instructions.

## What changed

- **`frontend/public/stellar.toml`** (new, replaces the dot-directory copy) — same SEP-0001 document with `ORG_URL`
  set to the canonical live URL `https://acredia-stellar-tau.vercel.app/` used in the README.
- **`frontend/next.config.ts`** — rewrite `/.well-known/stellar.toml` → `/stellar.toml` so the file is actually served.
- **`frontend/scripts/check-stellar-toml.mjs`** and `npm run check:stellar-toml` — fetches `DEPLOY_URL` (local dev by
  default), checks HTTP 200, `VERSION`, `SIGNING_KEY` shape, principal/contract sections, and that `ORG_URL` exactly
  matches the deployment URL.
- **`docs/mainnet-readiness.md`** — documents the smoke check and the `stellar.expert` validator step, including that
  `ORG_URL` must track the serving domain.

## Acceptance criteria addressed

- The document is now served at the live well-known path once deployed, and a repeatable smoke check plus public
  validator step verify it; `ORG_URL` matches the deployment URL.
- Note: the public validator run must happen against the deployed domain after this change ships; the pre-change live
  URL returned 404, which this fix addresses.

closes #96
