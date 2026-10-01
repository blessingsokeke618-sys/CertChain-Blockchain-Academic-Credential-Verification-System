import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
    APP_IDENTITY_META_CONTENT,
    APP_IDENTITY_META_NAME,
    hasAppIdentityMeta,
} from '../src/lib/appIdentity';
import { verifyBaseUrlIsAcredia } from './playwright/global-setup';

/**
 * Proves the guard from ACREDIA-STELLAR#271: the Playwright suite must refuse
 * to run against an app that is not Acredia.
 *
 * The regression this protects against is not a crash — it is a *pass*. A
 * foreign dev server on the configured port produced a green a11y run for code
 * that was never ours. So the assertions here are mostly about rejection: a
 * plausible-looking HTML page that simply lacks our marker has to fail.
 */

const servers: Server[] = [];

/** Starts a throwaway HTTP responder and returns its base URL. */
async function startResponder(
    handler: (url: string) => { status?: number; body: string },
): Promise<string> {
    const server = createServer((req, res) => {
        const { status = 200, body } = handler(req.url ?? '/');
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
}

function acrediaPage(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="${APP_IDENTITY_META_NAME}" content="${APP_IDENTITY_META_CONTENT}"/><title>Acredia</title></head><body><main>Acredia</main></body></html>`;
}

/**
 * Stands in for the CRM dev server that caused the incident: a real,
 * well-formed app that answers 200 on every route and knows nothing about us.
 */
function foreignAppPage(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="generator" content="Some Other CRM"/><title>Objects · People</title></head><body><a id="nav-item-people-objects" class="navigation-drawer-item" aria-selected="false" href="/objects/people">People</a></body></html>`;
}

afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
});

describe('Playwright base-URL identity guard', () => {
    it('accepts a server serving Acredia', async () => {
        const baseURL = await startResponder(() => ({ body: acrediaPage() }));

        await expect(verifyBaseUrlIsAcredia(baseURL)).resolves.toBeUndefined();
    });

    it('rejects a foreign app that answers 200 on the base URL', async () => {
        const baseURL = await startResponder(() => ({ body: foreignAppPage() }));

        await expect(verifyBaseUrlIsAcredia(baseURL)).rejects.toThrow(
            new RegExp(`no <meta name="${APP_IDENTITY_META_NAME}"> marker`),
        );
    });

    it('names the offending URL and the escape hatch so the failure is actionable', async () => {
        const baseURL = await startResponder(() => ({ body: foreignAppPage() }));

        await expect(verifyBaseUrlIsAcredia(baseURL)).rejects.toThrow(
            expect.objectContaining({
                message: expect.stringContaining(baseURL),
            }),
        );
        await expect(verifyBaseUrlIsAcredia(baseURL)).rejects.toThrow(/PLAYWRIGHT_PORT=/);
    });

    it('rejects a server that answers with an error status', async () => {
        const baseURL = await startResponder(() => ({ status: 502, body: 'Bad Gateway' }));

        await expect(verifyBaseUrlIsAcredia(baseURL)).rejects.toThrow(/HTTP 502/);
    });

    it('rejects a base URL nothing is listening on', async () => {
        // Port 1 is privileged and unbound, so the connection is refused
        // immediately rather than hanging until the probe deadline.
        await expect(
            verifyBaseUrlIsAcredia('http://127.0.0.1:1', { timeoutMs: 100 }),
        ).rejects.toThrow(/No server answered/);
    });
});

describe('hasAppIdentityMeta', () => {
    it('matches regardless of attribute order', () => {
        expect(
            hasAppIdentityMeta(
                `<meta content="${APP_IDENTITY_META_CONTENT}" name="${APP_IDENTITY_META_NAME}"/>`,
            ),
        ).toBe(true);
    });

    // The marker is matched per-tag rather than across the whole document, so
    // a page that happens to contain both strings in *different* meta tags is
    // not mistaken for Acredia.
    it('does not match the name and content spread across separate tags', () => {
        expect(
            hasAppIdentityMeta(
                `<meta name="${APP_IDENTITY_META_NAME}" content="something-else"/><meta name="generator" content="${APP_IDENTITY_META_CONTENT}"/>`,
            ),
        ).toBe(false);
    });

    it('rejects a document with no meta tags at all', () => {
        expect(hasAppIdentityMeta('<html><body>hello</body></html>')).toBe(false);
    });
});

describe('root layout marker', () => {
    it('is declared in the app metadata so every route carries it', async () => {
        // The layout calls `Inter()` from next/font/google at module scope,
        // which is a build-time transform and throws under Vitest.
        const { vi } = await import('vitest');
        vi.doMock('next/font/google', () => ({
            Inter: () => ({ variable: '--font-sans', className: 'font-sans' }),
        }));

        const { metadata } = await import('../src/app/layout');
        expect(metadata.other?.[APP_IDENTITY_META_NAME]).toBe(APP_IDENTITY_META_CONTENT);
    });
});
