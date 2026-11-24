# Publish the WASM artifact and digest from CI (#120)

## Summary

Successful CI runs previously produced no downloadable artifact, so a mainnet upgrade could not be tied to a tested
build. The smart-contracts job now computes the WASM SHA-256 and uploads both the binary and digest as a workflow
artifact; the mainnet checklist records where to find and paste that digest.

## What changed

- **`.github/workflows/ci.yml`** — repaired the pre-existing truncated `smart-contracts` job (format, WASM build, tests,
  clippy) and added:
  - a **Record WASM SHA-256 digest** step that verifies the artifact exists and writes `wasm.sha256` plus a step output;
  - an **Upload WASM artifact and digest** step publishing `certchain-wasm-<commit sha>` with 90-day retention.
- **`contracts/MAINNET_CHECKLIST.md`** — the rollback item now points at the CI artifact digest and includes a table for
  recording the deployed commit and its exact digest.
- Workflow YAML was validated after the edit.

## Acceptance criteria addressed

- Every successful CI run produces a downloadable, digest-verified artifact.
- Mainnet docs record the digest used (template added to the checklist).

closes #120
