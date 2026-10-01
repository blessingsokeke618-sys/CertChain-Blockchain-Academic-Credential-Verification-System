import { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = {
    title: 'Solutions for Students - Acredia',
    description: 'Own your academic records forever. Secure, shareable, and verifiable credentials on the Stellar blockchain.',
    openGraph: {
        title: 'Solutions for Students - Acredia',
        description: 'Own your academic records forever. Secure, shareable, and verifiable credentials on the Stellar blockchain.',
        images: ['/student.png'],
        type: 'website',
    },
    twitter: {
        card: 'summary_large_image',
        title: 'Solutions for Students - Acredia',
        description: 'Own your academic records forever. Secure, shareable, and verifiable credentials on the Stellar blockchain.',
        images: ['/student.png'],
    },
};

export default function StudentsLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
