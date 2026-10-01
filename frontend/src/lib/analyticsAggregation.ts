export function last12Months(): string[] {
    const months: string[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return months;
}

export function groupByMonth(dates: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const d of dates) {
        if (d.length < 7) continue;
        const m = d.slice(0, 7);
        counts[m] = (counts[m] ?? 0) + 1;
    }
    return counts;
}

export function fillMonths(
    counts: Record<string, number>,
    months: string[],
): { month: string; count: number }[] {
    return months.map((m) => ({ month: m, count: counts[m] ?? 0 }));
}

export interface TopCredential {
    tokenId: string;
    credentialType: string;
    studentName: string;
    count: number;
}

export function topVerified(
    logs: { credential_id: string }[],
    credMap: Map<string, { tokenId: string; credentialType: string; studentName: string }>,
    limit = 5,
): TopCredential[] {
    const counts: Record<string, number> = {};
    for (const log of logs) {
        counts[log.credential_id] = (counts[log.credential_id] ?? 0) + 1;
    }
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([credId, count]) => {
            const c = credMap.get(credId);
            return {
                tokenId: c?.tokenId ?? credId,
                credentialType: c?.credentialType ?? 'Unknown',
                studentName: c?.studentName ?? 'Unknown',
                count,
            };
        });
}

interface CsvCredential {
    token_id: string;
    issued_at: string;
    revoked: boolean;
    metadata: {
        credentialData?: {
            studentName?: string;
            credentialType?: string;
            degree?: string;
            major?: string;
            gpa?: string;
            issueDate?: string;
        };
    } | null;
}

export function toCsv(credentials: CsvCredential[]): string {
    const headers = ['token_id', 'student_name', 'credential_type', 'degree', 'major', 'gpa', 'issue_date', 'issued_at', 'status'];
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = credentials.map((c) => {
        const d = c.metadata?.credentialData ?? {};
        return [
            c.token_id,
            d.studentName ?? '',
            d.credentialType ?? '',
            d.degree ?? '',
            d.major ?? '',
            d.gpa ?? '',
            d.issueDate ?? '',
            c.issued_at,
            c.revoked ? 'revoked' : 'active',
        ]
            .map(escape)
            .join(',');
    });
    return [headers.join(','), ...rows].join('\n');
}
