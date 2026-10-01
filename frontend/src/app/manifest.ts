import { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: 'Acredia Academic Credentials',
        short_name: 'Acredia',
        description: 'Secure, tamper-proof academic credentials powered by blockchain',
        start_url: '/',
        display: 'standalone',
        background_color: '#030712',
        theme_color: '#3b82f6',
        icons: [
            {
                src: '/favicon.ico',
                sizes: 'any',
                type: 'image/x-icon',
            },
            {
                src: '/icon.png',
                sizes: '192x192',
                type: 'image/png',
            },
            {
                src: '/icon.png',
                sizes: '512x512',
                type: 'image/png',
            },
        ],
    };
}
