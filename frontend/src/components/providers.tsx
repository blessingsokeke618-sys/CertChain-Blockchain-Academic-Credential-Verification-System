'use client';

import { MotionConfig } from 'framer-motion';
import { StellarProvider } from '@/contexts/StellarContext';
import { AuthProvider } from '@/contexts/AuthContext';

/**
 * Root Providers Component
 *
 * Includes the Auth context for Supabase and the Stellar context for the
 * user's chosen wallet. MotionConfig honors the user's reduced-motion
 * preference so entrance animations never fight accessibility settings.
 */
export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <MotionConfig reducedMotion="user">
            <StellarProvider>
                <AuthProvider>{children}</AuthProvider>
            </StellarProvider>
        </MotionConfig>
    );
}
