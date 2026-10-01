import { describe, expect, it } from 'vitest';
import {
    last12Months,
    groupByMonth,
    fillMonths,
    topVerified,
    toCsv,
} from '../src/lib/analyticsAggregation';

describe('last12Months', () => {
    it('returns exactly 12 entries', () => {
        expect(last12Months()).toHaveLength(12);
    });

    it('entries are in YYYY-MM format', () => {
        for (const m of last12Months()) {
            expect(m).toMatch(/^\d{4}-\d{2}$/);
        }
    });

    it('last entry is the current month', () => {
        const now = new Date();
        const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const months = last12Months();
        expect(months[months.length - 1]).toBe(expected);
    });

    it('entries are ascending', () => {
        const months = last12Months();
        for (let i = 1; i < months.length; i++) {
            expect(months[i] > months[i - 1]).toBe(true);
        }
    });
});

describe('groupByMonth', () => {
    it('counts ISO timestamps by YYYY-MM prefix', () => {
        const dates = ['2025-01-15T10:00:00Z', '2025-01-20T10:00:00Z', '2025-02-05T10:00:00Z'];
        expect(groupByMonth(dates)).toEqual({ '2025-01': 2, '2025-02': 1 });
    });

    it('returns empty object for empty input', () => {
        expect(groupByMonth([])).toEqual({});
    });
});

describe('fillMonths', () => {
    it('fills missing months with 0', () => {
        const counts = { '2025-01': 3 };
        const months = ['2025-01', '2025-02', '2025-03'];
        expect(fillMonths(counts, months)).toEqual([
            { month: '2025-01', count: 3 },
            { month: '2025-02', count: 0 },
            { month: '2025-03', count: 0 },
        ]);
    });

    it('returns empty array for empty months', () => {
        expect(fillMonths({}, [])).toEqual([]);
    });
});

describe('topVerified', () => {
    const credMap = new Map([
        ['cred-1', { tokenId: 'tok-1', credentialType: 'Degree', studentName: 'Alice' }],
        ['cred-2', { tokenId: 'tok-2', credentialType: 'Certificate', studentName: 'Bob' }],
    ]);

    it('returns credentials sorted by verification count descending', () => {
        const logs = [
            { credential_id: 'cred-2' },
            { credential_id: 'cred-2' },
            { credential_id: 'cred-1' },
        ];
        const result = topVerified(logs, credMap);
        expect(result[0].tokenId).toBe('tok-2');
        expect(result[0].count).toBe(2);
        expect(result[1].tokenId).toBe('tok-1');
        expect(result[1].count).toBe(1);
    });

    it('respects the limit parameter', () => {
        const logs = [
            { credential_id: 'cred-1' },
            { credential_id: 'cred-2' },
        ];
        expect(topVerified(logs, credMap, 1)).toHaveLength(1);
    });

    it('uses fallback values for unknown credential IDs', () => {
        const logs = [{ credential_id: 'unknown-id' }];
        const result = topVerified(logs, new Map());
        expect(result[0].tokenId).toBe('unknown-id');
        expect(result[0].studentName).toBe('Unknown');
    });

    it('returns empty array for no logs', () => {
        expect(topVerified([], credMap)).toEqual([]);
    });
});

describe('toCsv', () => {
    it('produces a header row followed by data rows', () => {
        const credentials = [
            {
                token_id: 'tok-1',
                issued_at: '2025-01-15T10:00:00Z',
                revoked: false,
                metadata: {
                    credentialData: {
                        studentName: 'Alice',
                        credentialType: 'Bachelor',
                        degree: 'BSc',
                        major: 'CS',
                        gpa: '3.8',
                        issueDate: '2025-01-15',
                    },
                },
            },
        ];
        const csv = toCsv(credentials);
        const lines = csv.split('\n');
        expect(lines[0]).toBe('token_id,student_name,credential_type,degree,major,gpa,issue_date,issued_at,status');
        expect(lines[1]).toContain('"tok-1"');
        expect(lines[1]).toContain('"Alice"');
        expect(lines[1]).toContain('"active"');
    });

    it('marks revoked credentials with status "revoked"', () => {
        const credentials = [
            {
                token_id: 'tok-2',
                issued_at: '2025-02-10T10:00:00Z',
                revoked: true,
                metadata: null,
            },
        ];
        const csv = toCsv(credentials);
        expect(csv).toContain('"revoked"');
    });

    it('escapes double-quotes in field values', () => {
        const credentials = [
            {
                token_id: 'tok-3',
                issued_at: '2025-03-01T10:00:00Z',
                revoked: false,
                metadata: { credentialData: { studentName: 'O"Brien' } },
            },
        ];
        const csv = toCsv(credentials);
        expect(csv).toContain('O""Brien');
    });

    it('returns only the header for empty input', () => {
        const csv = toCsv([]);
        expect(csv.trim()).toBe('token_id,student_name,credential_type,degree,major,gpa,issue_date,issued_at,status');
    });
});
