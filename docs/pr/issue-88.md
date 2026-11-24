# Publish an OpenAPI 3.0 API reference (#88)

## Summary

There was no machine-readable API reference and the README listed it as planned. This adds a generated OpenAPI 3.0
document covering all 33 Next.js API routes, a regeneration/validation script, and a CI check that fails when a new
route has no spec entry.

## What changed

- **`frontend/scripts/check-openapi.mjs`** — walks `src/app/api/**/route.ts`, converts dynamic segments (`[id]` →
  `{id}`), detects exported HTTP methods, and builds a deterministic OpenAPI 3.0 document with tags, operation ids,
  route-appropriate security schemes, request bodies and standard responses. `--generate` rewrites the spec; default
  mode diffs and fails with a clear regeneration instruction.
- **`frontend/docs/openapi.json`** — generated spec covering all 33 routes.
- **`frontend/package.json`** — `openapi:generate` and `openapi:check` scripts.
- **`.github/workflows/ci.yml`** — runs `npm run openapi:check` in the frontend lint job.
- **`README.md`** — docs index now links the generated reference instead of "planned".

## Acceptance criteria addressed

- Every route in `frontend/src/app/api/` has an entry (33 paths verified locally).
- CI fails when a new/changed route has no spec update, because the regenerated document differs.

closes #88
