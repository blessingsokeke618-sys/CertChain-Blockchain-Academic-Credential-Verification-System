/**
 * Indexer lag health metric and alerting (#80).
 *
 * Pure helpers used by scripts/indexer.ts. The metric is emitted every poll
 * so lag is observable even while healthy; an alert is raised only when the
 * newest indexed ledger is more than 24 hours behind the network head.
 */

/** Maximum healthy lag between the network head and the last indexed ledger. */
export const MAX_INDEXER_LAG_SECONDS = 24 * 60 * 60;
/** Fallback seconds per ledger when close timestamps are unavailable. */
export const DEFAULT_LEDGER_SECONDS = 5;

export interface IndexerLagInput {
  lastIndexedLedger: number;
  latestLedger: number;
  /** ISO close time of the latest network ledger, when the RPC provides it. */
  latestLedgerClosedAt?: string;
  /** ISO close time of the last indexed ledger, when known. */
  lastIndexedLedgerClosedAt?: string;
  maxLagSeconds?: number;
  secondsPerLedger?: number;
}

export interface IndexerLagReport {
  lastIndexedLedger: number;
  latestLedger: number;
  lagLedgers: number;
  lagSeconds: number;
  thresholdSeconds: number;
  alert: boolean;
  message: string;
}

/**
 * Compute the indexer lag. Ledger close timestamps are preferred because a
 * standalone network can advance at a different rate than mainnet; when they
 * are missing the lag is estimated from the ledger gap.
 */
export function evaluateIndexerLag(input: IndexerLagInput): IndexerLagReport {
  const thresholdSeconds = input.maxLagSeconds ?? MAX_INDEXER_LAG_SECONDS;
  const lagLedgers = Math.max(0, input.latestLedger - input.lastIndexedLedger);

  let lagSeconds: number;
  if (input.latestLedgerClosedAt && input.lastIndexedLedgerClosedAt) {
    const head = Date.parse(input.latestLedgerClosedAt);
    const indexed = Date.parse(input.lastIndexedLedgerClosedAt);
    lagSeconds = Number.isFinite(head) && Number.isFinite(indexed)
      ? Math.max(0, (head - indexed) / 1000)
      : lagLedgers * (input.secondsPerLedger ?? DEFAULT_LEDGER_SECONDS);
  } else {
    lagSeconds = lagLedgers * (input.secondsPerLedger ?? DEFAULT_LEDGER_SECONDS);
  }

  // Strictly greater than the threshold: exactly 24h is still healthy.
  const alert = lagSeconds > thresholdSeconds;
  const message = alert
    ? `INDEXER LAG ALERT: last indexed ledger ${input.lastIndexedLedger} is ${lagLedgers} ledgers (${Math.round(lagSeconds)}s) behind network ledger ${input.latestLedger}`
    : `Indexer lag ${Math.round(lagSeconds)}s (${lagLedgers} ledgers), last indexed ledger ${input.lastIndexedLedger}`;

  return {
    lastIndexedLedger: input.lastIndexedLedger,
    latestLedger: input.latestLedger,
    lagLedgers,
    lagSeconds,
    thresholdSeconds,
    alert,
    message,
  };
}

/** Structured JSON line suitable for log aggregation/alerting rules. */
export function formatLagMetric(report: IndexerLagReport): string {
  return JSON.stringify({
    metric: 'indexer_lag_seconds',
    last_indexed_ledger: report.lastIndexedLedger,
    latest_ledger: report.latestLedger,
    lag_ledgers: report.lagLedgers,
    lag_seconds: Math.round(report.lagSeconds),
    threshold_seconds: report.thresholdSeconds,
    alert: report.alert,
  });
}
