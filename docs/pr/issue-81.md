# Verify regenerated contract bindings in CI (#81)

## Summary

The `smart-contracts` CI job ran format/build/test/clippy but never checked that the checked-in TypeScript bindings
matched the compiled WASM, so ABI changes could ship with stale client code. This adds a regeneration-and-diff step.
While doing so, the pre-existing truncated `ci.yml` (the file ended at an incomplete `with:` block plus a literal
truncation marker) was repaired so the workflow is valid YAML again.

## What changed

- **`.github/workflows/ci.yml`**
  - Completed the `smart-contracts` job: cargo cache, `cargo fmt --check`, WASM build, tests and clippy.
  - Added **Verify checked-in TypeScript bindings are current**: copies `frontend/src/contracts/certchain.ts`, runs
    `make bindings` (which builds the WASM and regenerates bindings from its ABI), diffs the result, and fails with a
    clear `::error::` annotation plus the exact regeneration command when they differ.
- Verified the workflow parses as valid YAML.

## Acceptance criteria addressed

- CI fails on a deliberately stale binding file — the `diff` step exits non-zero and prints the regeneration hint.
- Passing CI means bindings match the compiled WASM — regeneration happens from the freshly built artifact.

closes #81
