import { describe, it, expect } from 'vitest';
import {
  MAX_INDEXER_LAG_SECONDS,
  evaluateIndexerLag,
  formatLagMetric,
} from '../scripts/indexerHealth';

describe('indexer lag health (#80)', () => {
  it('does not alert on a healthy lag and still emits the metric', () => {
    const report = evaluateIndexerLag({
      lastIndexedLedger: 1000,
      latestLedger: 1005,
    });
    expect(report.alert).toBe(false);
    expect(report.lagLedgers).toBe(5);
    expect(report.lagSeconds).toBe(25);
    expect(report.message).toContain('last indexed ledger 1000');
    expect(formatLagMetric(report)).toContain('"metric":"indexer_lag_seconds"');
  });

  it('alerts with the last indexed ledger when lag exceeds 24 hours', () => {
    const report = evaluateIndexerLag({
      lastIndexedLedger: 500,
      latestLedger: 500 + (25 * 3600) / 5,
      secondsPerLedger: 5,
    });
    expect(report.lagSeconds).toBe(25 * 3600);
    expect(report.alert).toBe(true);
    expect(report.message).toContain('last indexed ledger 500');
    expect(report.message).toContain('ALERT');
  });

  it('uses ledger close timestamps when available', () => {
    const report = evaluateIndexerLag({
      lastIndexedLedger: 10,
      latestLedger: 20,
      lastIndexedLedgerClosedAt: '2026-01-01T00:00:00.000Z',
      latestLedgerClosedAt: '2026-01-02T01:00:00.000Z',
    });
    expect(report.lagSeconds).toBe(25 * 3600);
    expect(report.alert).toBe(true);
  });

  it('treats exactly 24 hours as healthy', () => {
    const report = evaluateIndexerLag({
      lastIndexedLedger: 1,
      latestLedger: 1 + MAX_INDEXER_LAG_SECONDS / 5,
      secondsPerLedger: 5,
    });
    expect(report.lagSeconds).toBe(MAX_INDEXER_LAG_SECONDS);
    expect(report.alert).toBe(false);
  });

  it('never reports negative lag', () => {
    const report = evaluateIndexerLag({
      lastIndexedLedger: 50,
      latestLedger: 40,
    });
    expect(report.lagLedgers).toBe(0);
    expect(report.lagSeconds).toBe(0);
  });
});
