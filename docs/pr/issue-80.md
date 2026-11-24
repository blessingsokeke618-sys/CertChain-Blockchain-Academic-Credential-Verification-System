# Alert on indexer lag over 24 hours (#80)

## Summary

A silently stalled indexer left credentials missing from dashboards until users reported them. The indexer now emits a
structured lag metric on every poll and raises a single alert (with the last indexed ledger) when it falls more than 24
hours behind the network head. The check is documented in the weekly runbook.

## What changed

- **`frontend/scripts/indexerHealth.ts`** (new) — pure `evaluateIndexerLag()` and `formatLagMetric()` helpers.
  - Compares the newest indexed ledger with the network head using close timestamps when available, falling back to a
    configurable seconds-per-ledger estimate.
  - Alerts only when lag is **strictly greater** than 24 hours; exactly 24 hours is healthy. Lag is never negative.
  - The metric JSON includes last indexed ledger, network ledger, lag ledgers/seconds, threshold and alert flag.
- **`frontend/scripts/indexer.ts`** — logs the metric each poll, emits one `[ALERT] INDEXER LAG ALERT` line on threshold
  crossing (with the last indexed ledger) and a recovery line when the lag clears, avoiding alert spam.
- **`frontend/tests/indexerHealth.test.ts`** (new) — covers healthy lag, alert with ledger id, timestamp-based lag, the
  exact 24-hour boundary, and negative-lag clamping.
- **`docs/ops/runbook.md`** — documents the metric and adds the lag check to the weekly list next to pin-keeper and
  TTL-keeper checks.

## Acceptance criteria addressed

- Simulated lag produces an alert that names the last indexed ledger — covered by tests and the alert message.
- Healthy lag produces no alert and the metric is logged — metric emitted unconditionally; alert only on crossing.

closes #80
