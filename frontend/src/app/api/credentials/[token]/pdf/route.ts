import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient, hasServiceRoleEnv } from '@/lib/serverAuth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { captureException } from '@/lib/debug';
import { pinFileToPinata } from '@/lib/ipfsServer';
import { buildCertificatePdf, certificateLines } from '@/lib/pdfCertificate';

export const dynamic = 'force-dynamic';

const PDF_RATE_LIMIT = {
    windowSeconds: 60,
    maxRequests: 20,
    prefix: 'credential-pdf',
} as const;

/**
 * Printable certificate for a credential (#92). The PDF is generated from the
 * public credential fields and pinned to IPFS as an additional artifact; it is
 * intentionally excluded from the canonical credential hash so previously
 * issued hashes remain valid.
 */
export async function GET(
    request: NextRequest,
    context: { params: Promise<{ token: string }> },
) {
    const requestId = request.headers.get('x-request-id') || 'unknown';
    try {
        const limited = await enforceRateLimit(request, PDF_RATE_LIMIT);
        if (limited) return limited;

        if (!hasServiceRoleEnv()) {
            return NextResponse.json({ success: false, error: 'Server configuration error' }, { status: 500 });
        }
        const { token } = await context.params;
        const supabase = getServiceRoleClient();
        const { data, error } = await supabase
            .from('credentials')
            .select('token_id, issued_at, metadata, institution:institutions!credentials_institution_id_fkey (name)')
            .eq('token_id', token)
            .maybeSingle();

        if (error || !data) {
            return NextResponse.json({ success: false, error: 'Credential not found' }, { status: 404 });
        }

        const credentialData = (data.metadata as { credentialData?: Record<string, unknown> } | null)?.credentialData ?? {};
        const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://acredia-stellar-tau.vercel.app';
        const bytes = buildCertificatePdf(
            certificateLines({
                tokenId: data.token_id,
                institutionName: String(credentialData.institutionName ?? (data.institution as { name?: string } | null)?.name ?? 'Issuing institution'),
                credentialType: String(credentialData.credentialType ?? 'Academic credential'),
                studentName: String(credentialData.studentName ?? credentialData.name ?? 'Credential holder'),
                issueDate: String(credentialData.issueDate ?? data.issued_at ?? ''),
                verificationUrl: `${origin.replace(/\/$/, '')}/verify?token=${encodeURIComponent(data.token_id)}`,
            }),
        );

        const file = new File([bytes], `credential-${data.token_id}.pdf`, { type: 'application/pdf' });
        const cid = await pinFileToPinata(file);

        return new NextResponse(bytes as BodyInit, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="credential-${data.token_id}.pdf"`,
                'X-IPFS-CID': cid,
                'Cache-Control': 'private, max-age=300',
            },
        });
    } catch (error) {
        captureException(error, { requestId, context: 'GET /api/credentials/[token]/pdf' });
        return NextResponse.json({ success: false, error: 'Failed to generate certificate' }, { status: 500 });
    }
}
