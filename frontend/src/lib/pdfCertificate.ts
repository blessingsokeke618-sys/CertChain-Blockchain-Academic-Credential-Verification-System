/**
 * Dependency-free printable certificate generator (#92).
 *
 * Produces a minimal valid PDF 1.4 document with one page and Helvetica text.
 * No canvas or browser APIs are used, so the same code runs in an API route.
 * The PDF CID is deliberately NOT part of the canonical credential hash —
 * it is an additional, replaceable rendering of metadata that is already
 * committed, so existing credential hashes remain unchanged.
 */

function escapePdfText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/[^\x20-\x7E]/g, '?');
}

export interface CertificatePdfFields {
    tokenId: string;
    institutionName: string;
    credentialType: string;
    studentName: string;
    issueDate: string;
    verificationUrl: string;
}

export function certificateLines(fields: CertificatePdfFields): string[] {
    return [
        'ACREDIA - VERIFIABLE ACADEMIC CREDENTIAL',
        '',
        `Credential #${fields.tokenId}`,
        `Type: ${fields.credentialType || 'Academic credential'}`,
        `Institution: ${fields.institutionName}`,
        `Recipient: ${fields.studentName}`,
        `Issued: ${fields.issueDate}`,
        '',
        `Verify at: ${fields.verificationUrl}`,
        'This PDF is a printable rendering; the on-chain record is authoritative.',
    ];
}

/** Build a single-page PDF from text lines. */
export function buildCertificatePdf(lines: string[]): Uint8Array {
    const content = [
        'BT',
        '/F1 16 Tf',
        '72 740 Td',
        '18 TL',
        ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
        'ET',
    ].join('\n');

    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(Buffer.byteLength(pdf, 'latin1'));
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefStart = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    return new TextEncoder().encode(pdf);
}
