'use client';

import Link from 'next/link';
import { KeyRound, Lock, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AuthShell } from '@/components/auth/AuthShell';

export default function AdminSetupPage() {
    return (
        <AuthShell
            variant="admin"
            title="Admin setup is locked"
            subtitle="Admin accounts cannot be created from a public browser route."
            footer={
                <Button asChild variant="outline" size="lg" className="w-full">
                    <Link href="/auth/admin-login">Back to admin login</Link>
                </Button>
            }
        >
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-warning/25 bg-warning/8 p-4">
                <Lock className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div>
                    <p className="text-sm font-semibold text-foreground">
                        Public admin registration is disabled
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Acredia requires administrators to be provisioned through a trusted
                        backend/database setup path. New public signups are always treated as
                        non-admin users until a trusted operator grants access.
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
                    <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div>
                        <h2 className="text-sm font-semibold text-foreground">
                            Trusted admin allowlist
                        </h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Set{' '}
                            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.7rem] text-foreground">
                                ADMIN_EMAIL_ALLOWLIST
                            </code>{' '}
                            on the server with the email addresses allowed to use admin API routes.
                        </p>
                    </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
                    <Terminal className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div>
                        <h2 className="text-sm font-semibold text-foreground">
                            Provision from Supabase
                        </h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Create the user through a trusted Supabase/admin process and update that
                            user&apos;s profile role to{' '}
                            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.7rem] text-foreground">
                                admin
                            </code>
                            . Never grant admin through client-submitted signup metadata.
                        </p>
                    </div>
                </div>
            </div>
        </AuthShell>
    );
}
