# Add Rust to the CodeQL analysis matrix (#121)

## Summary

CodeQL only analysed the TypeScript/JavaScript frontend, leaving `contracts/src/lib.rs` — the highest-value attack
surface — unscanned. The workflow now runs a language matrix covering both ecosystems, with a WASM build step for Rust.
`SECURITY.md` documents the coverage decision.

## What changed

- **`.github/workflows/codeql.yml`** — added a `fail-fast: false` matrix over `javascript-typescript` and `rust`; init
  uses `${{ matrix.language }}`; a conditional Rust step installs the `wasm32v1-none` target and builds the contract so
  CodeQL has compiled code to analyse.
- **`SECURITY.md`** — new "Static analysis coverage" section: Soroban/WASM is included via Rust source analysis; the
  generated WASM is not separately scanned because behaviour derives from the analysed sources and pinned SDK; results
  appear in the Security tab for both languages.
- Validated the workflow as YAML.

## Acceptance criteria addressed

- CodeQL reports results for Rust via the new matrix job.
- The security doc describes the Soroban/WASM inclusion decision.

closes #121
