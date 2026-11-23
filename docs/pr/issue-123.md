# Separate timing-sensitive load tests from unit CI (#123)

## Summary

The endpoint load tests assert wall-clock p95 bounds over 25 iterations and run in the default Vitest suite, so noisy
shared CI runners fail unrelated PRs. They are now excluded from the default run and remain available through
`npm run test:load`, with generous environment-adjusted budgets.

## What changed

- **`frontend/vitest.config.ts`** — excludes `tests/load-endpoints.test.ts` from the default include (while preserving
  Vitest's default excludes).
- **`frontend/tests/load-endpoints.test.ts`** — replaced the three hard-coded 50 ms p95 assertions with a single
  `LOAD_P95_BUDGET_MS` default of 250 ms, overridable via `LOAD_P95_BUDGET_MS` for slower machines.
- `npm run test:load` already targets this file directly and is unaffected.

## Acceptance criteria addressed

- Default CI is deterministic on noisy runners — the timing-sensitive file no longer runs in `npm test`.
- The load test remains runnable on demand via `npm run test:load`.

closes #123
