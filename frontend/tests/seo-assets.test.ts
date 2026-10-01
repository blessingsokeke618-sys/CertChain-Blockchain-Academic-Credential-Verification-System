import { describe, expect, it } from 'vitest';
import robots from '../src/app/robots';
import sitemap from '../src/app/sitemap';
import manifest from '../src/app/manifest';

describe('SEO & PWA assets', () => {
    it('robots.ts returns correct rules and sitemap link', () => {
        const config = robots();
        expect(config.rules).toBeDefined();
        expect(config.sitemap).toBeDefined();
        expect(config.rules).toMatchObject({
            userAgent: '*',
            allow: '/',
            disallow: ['/admin/', '/dashboard/'],
        });
    });

    it('sitemap.ts returns correct urls', () => {
        const urls = sitemap();
        expect(urls.length).toBe(5);
        const paths = urls.map((u) => u.url);
        expect(paths).toContain('https://acredia.example');
        expect(paths).toContain('https://acredia.example/about');
        expect(paths).toContain('https://acredia.example/verify');
        expect(paths).toContain('https://acredia.example/solutions/institutions');
        expect(paths).toContain('https://acredia.example/solutions/students');
    });

    it('manifest.ts returns web manifest metadata', () => {
        const config = manifest();
        expect(config.name).toBe('Acredia Academic Credentials');
        expect(config.short_name).toBe('Acredia');
        expect(config.icons).toBeDefined();
        expect(config.icons?.length).toBeGreaterThan(0);
    });
});
