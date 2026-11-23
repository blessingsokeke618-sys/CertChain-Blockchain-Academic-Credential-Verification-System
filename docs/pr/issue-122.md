# Fail CI on committed test-snapshot drift (#122)

## Summary

Local `cargo test` runs could rewrite committed snapshots under `contracts/test_snapshots/` while CI never compared the
result, so behaviour changes could ship without a reviewed snapshot diff. CI now checks for drift and the contribution
guide explains when an update is legitimate.

## What changed

- **`.github/workflows/ci.yml`** — repaired the truncated `smart-contracts` job and added **Fail on committed
  test-snapshot drift**: after `cargo test`, `git diff --exit-code -- contracts/test_snapshots` fails with an actionable
  error if any snapshot changed.
- **`CONTRIBUTING.md`** — new "Test snapshots" section: intentional output changes must review and commit the diff with
  an explanation; unexpected changes are regressions; proptest (which disables capture) must not be used to refresh
  baselines.
- Validated the workflow as YAML.

## Acceptance criteria addressed

- CI fails when a snapshot changes.
- Contribution docs explain when to deliberately update snapshots.

closes #122
