# Make load-baselines.json authoritative (#124)

## Summary

`frontend/tests/load-baselines.json` was committed but never read, and its p95 values disagreed with the hard-coded 50 ms
assertions. The on-demand load test now reads the JSON and validates each measured endpoint against it, with failure
messages that name the baseline and its capture date.

## What changed

- **`frontend/tests/load-endpoints.test.ts`**
  - Imports `load-baselines.json` and maps the three test labels (`verify`, `ipfs-file`, `ipfs-json`) to their baseline
    entries.
  - `assertWithinBaseline()` checks p95 against the baseline value with a configurable tolerance (default 2x) to absorb
    runner noise; the assertion message includes the measured value, baseline, tolerance and `capturedAt`.
  - Removed the three hard-coded 50 ms assertions.
- The baseline file is now the single source of truth; no thresholds are duplicated in code beyond the tolerance.

## Acceptance criteria addressed

- The baseline file is authoritative rather than orphaned.
- Test failure messages reference the baseline (value and capture date).

closes #124
