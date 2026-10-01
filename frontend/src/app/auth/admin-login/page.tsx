'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, Lock, Mail, Shield, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/auth/AuthShell';
import { safeGetSession, supabase } from '@/lib/supabase';

export default function AdminLoginPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    useEffect(() => {
        const checkSession = async () => {
            try {
                const {
                    data: { session },
                } = await safeGetSession();
                if (session?.user) {
                    router.push('/admin');
                }
            } catch {
                // Ignore invalid cached sessions and allow normal login flow.
            }
        };
        checkSession();
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) {
                toast.error(
                    'Login failed: ' + (error instanceof Error ? error.message : String(error)),
                );
                return;
            }

            if (data.user) {
                toast.success('Login successful! Now connect your contract owner wallet.');
                router.push('/admin');
            }
        } catch (error: unknown) {
            toast.error(
                'An error occurred: ' + (error instanceof Error ? error.message : String(error)),
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthShell
            variant="admin"
            title="Admin portal"
            subtitle="Contract owner access only."
            footer={
                <div className="space-y-2 text-center">
                    <Link
                        href="/auth/admin-setup"
                        className="text-sm font-medium text-primary hover:underline"
                    >
                        First time? View the admin setup guide
                    </Link>
                    <p className="text-sm text-muted-foreground">
                        Not an admin?{' '}
                        <Link href="/auth/login" className="font-semibold text-primary hover:underline">
                            User sign in
                        </Link>
                    </p>
                </div>
            }
        >
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-warning/25 bg-warning/8 p-4">
                <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div>
                    <p className="text-sm font-semibold text-foreground">
                        Wallet verification required
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        After login, you must connect the contract owner wallet to access admin
                        features.
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                    <Label htmlFor="email">Admin email</Label>
                    <div className="relative">
                        <Mail className="pointer-events-none absolute left-3 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            id="email"
                            type="email"
                            placeholder="admin@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            className="pl-10"
                            disabled={loading}
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <div className="relative">
                        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            id="password"
                            type={showPassword ? 'text' : 'password'}
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="pl-10 pr-10"
                            disabled={loading}
                        />
                        <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                            {showPassword ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
                        </button>
                    </div>
                </div>

                <Button type="submit" size="lg" className="w-full" disabled={loading}>
                    {loading ? (
                        'Authenticating…'
                    ) : (
                        <>
                            <Shield className="h-4 w-4" />
                            Access admin portal
                        </>
                    )}
                </Button>
            </form>
        </AuthShell>
    );
}
