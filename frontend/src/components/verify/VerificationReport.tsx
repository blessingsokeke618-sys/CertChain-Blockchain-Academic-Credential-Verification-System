'use client';

import Link from 'next/link';
import { Home, Printer, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CredentialFacts } from '@/components/verify/CredentialFacts';
import { TechnicalDetails } from '@/components/verify/TechnicalDetails';
import { VerificationSignals } from '@/components/verify/VerificationSignals';
import { VerificationVerdict } from '@/components/verify/VerificationVerdict';
import type {
    CredentialData,
    IntegrityStatus,
    RevocationSource,
    VerificationDetail,
} from '@/hooks/useCredentialVerification';

function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
}

function revocationLine(source: RevocationSource, revokedAt: string | null): string {
    const on = revokedAt ? ` on ${formatDate(revokedAt)}` : '';
    if (source === 'platform') {
        return `This credential was revoked by Acredia (the platform), not by the issuing institution${on}. Platform revocation is reserved for incident response, such as a compromised issuer key, and is recorded separately on-chain. It should no longer be relied on.`;
    }
    if (source === 'issuer') {
        return `This credential has been revoked by the issuing institution${on} and should no longer be relied on.`;
    }
    return `This credential has been revoked${on} and should no longer be relied on.`;
}

/**
 * A completed verification, in strict priority order: the verdict, then the
 * human facts, then the signals behind it, then the cryptographic proof.
 */
export function VerificationReport({
    credential,
    integrityStatus,
    detail,
    checkedAt,
}: {
    credential: CredentialData;
    integrityStatus: IntegrityStatus | null;
    detail: VerificationDetail | null;
    checkedAt: string;
}) {
    const revoked = credential.revoked;
    const revocationSource = detail?.revocationSource ?? credential.revocation_source ?? null;

    return (
        <div className="space-y-4">
            <VerificationVerdict
                kind={revoked ? 'revoked' : 'verified'}
                line={revoked ? revocationLine(revocationSource, credential.revoked_at) : undefined}
            />

            <CredentialFacts credential={credential} />

            <VerificationSignals
                credential={credential}
                integrityStatus={integrityStatus}
                detail={detail}
                checkedAt={checkedAt}
            />

            <TechnicalDetails credential={credential} />

            <p className="max-w-prose text-xs leading-5 text-muted-foreground">
                How revocations are attributed: a credential can be revoked by its issuing
                institution or, in rare incident-response cases such as a compromised issuer key, by
                Acredia (the platform). The two are written under separate on-chain events and are
                always labelled distinctly above — the platform can never revoke a credential
                silently in the issuing institution&apos;s name.
            </p>

            <div className="flex flex-wrap gap-3 pb-8 pt-2 print:hidden">
                <Button asChild>
                    <Link href="/verify">
                        <Shield className="h-4 w-4" />
                        Verify another
                    </Link>
                </Button>
                <Button variant="outline" onClick={() => window.print()}>
                    <Printer className="h-4 w-4" />
                    Print or save as PDF
                </Button>
                <Button variant="ghost" asChild>
                    <Link href="/">
                        <Home className="h-4 w-4" />
                        Return home
                    </Link>
                </Button>
            </div>
        </div>
    );
}
