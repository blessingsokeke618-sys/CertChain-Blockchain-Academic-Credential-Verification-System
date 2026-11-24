import { describe, expect, it } from 'vitest';
import { buildCertificatePdf, certificateLines } from '@/lib/pdfCertificate';

describe('printable certificate PDF (#92)', () => {
    it('renders credential fields into a valid single-page PDF', () => {
        const lines = certificateLines({
            tokenId: '42',
            institutionName: 'Stellar University',
            credentialType: 'BSc Computer Science',
            studentName: 'Ada Lovelace',
            issueDate: '2026-01-01',
            verificationUrl: 'https://example.com/verify?token=42',
        });
        const pdf = buildCertificatePdf(lines);
        const text = Buffer.from(pdf).toString('latin1');

        expect(text.startsWith('%PDF-1.4')).toBe(true);
        expect(text).toContain('/Type /Catalog');
        expect(text).toContain('/Count 1');
        expect(text).toContain('Credential #42');
        expect(text).toContain('Stellar University');
        expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
        expect(text).toContain('startxref');
    });

    it('escapes parentheses and strips non-ASCII from metadata', () => {
        const pdf = Buffer.from(buildCertificatePdf(['Institution (École) \\ test'])).toString('latin1');
        expect(pdf).toContain('Institution \\(Ecole\\) \\\\ test');
    });
});
