import { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = {
    title: 'Solutions for Institutions - Acredia',
    description: 'Enable your institution to issue tamper-proof, blockchain-verified academic credentials with ease.',
    openGraph: {
        title: 'Solutions for Institutions - Acredia',
        description: 'Enable your institution to issue tamper-proof, blockchain-verified academic credentials with ease.',
        images: ['/institute.png'],
        type: 'website',
    },
    twitter: {
        card: 'summary_large_image',
        title: 'Solutions for Institutions - Acredia',
        description: 'Enable your institution to issue tamper-proof, blockchain-verified academic credentials with ease.',
        images: ['/institute.png'],
    },
};

export default function InstitutionsLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
