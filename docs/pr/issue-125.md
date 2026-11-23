# Clarify what the load baselines measure (#125)

## Summary

The "load" numbers came from in-process route handlers with IPFS, Stellar, Supabase and auth fully mocked, but the docs
did not say so and could be read as production latency figures. `TEST_STRATEGY.md` now states exactly what is measured
and what is not.

## What changed

- **`frontend/tests/TEST_STRATEGY.md`** — added a "What the 'load' numbers measure" section explaining that
  `load-endpoints.test.ts` times mocked handlers with `performance.now()`, that the baselines guard against handler
  regressions only, and that production latency is dominated by RPC, database, IPFS and network conditions. Explicitly
  forbids quoting the numbers as production latency or SLOs, and notes the on-demand `npm run test:load` workflow.

## Acceptance criteria addressed

- Docs state what the numbers do and do not measure.
- No production latency claims are made; misleading claims are explicitly ruled out.

closes #125
