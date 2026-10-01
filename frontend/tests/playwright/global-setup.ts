import type { FullConfig } from '@playwright/test';
import { APP_IDENTITY_META_NAME, hasAppIdentityMeta } from '../../src/lib/appIdentity';

/**
 * Refuses to run the browser suite against an app that is not Acredia.
 *
 * `webServer.reuseExistingServer` attaches to whatever is already listening on
 * the configured port. On a developer machine that port is shared with every
 * other web project, so the suite could audit a foreign app and report its
 * violations as ours — or, worse, report a pass while Acredia's own
 * regressions went unexercised (ACREDIA-STELLAR#271).
 *
 * Playwright has already started or adopted the server by the time this runs,
 * so one fetch of the base URL settles the question: the root layout emits an
 * Acredia-specific `<meta name="x-acredia-app">` marker on every route, and
 * anything without it is somebody else's app.
 */

/** How long to wait for the base URL to answer before giving up. */
const PROBE_TIMEOUT_MS = 30_000;

export function identityFailureMessage(baseURL: string, detail: string): string {
    return [
        '',
        `Refusing to run the Playwright suite against ${baseURL}.`,
        '',
        detail,
        '',
        'The server answering that URL is not Acredia, so any results would',
        'describe a different application — including a green run that proves',
        'nothing about this repository.',
        '',
        'Fix it by either:',
        '  • stopping whatever owns that port, or',
        '  • running on a free one:  PLAYWRIGHT_PORT=<port> npx playwright test',
        '',
        'See frontend/tests/TEST_STRATEGY.md ("Base-URL identity guard").',
        '',
    ].join('\n');
}

/** Fetches the base URL, retrying while it is still coming up. */
export async function fetchBaseUrl(
    baseURL: string,
    {
        timeoutMs = PROBE_TIMEOUT_MS,
        fetchImpl = fetch,
    }: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        try {
            return await fetchImpl(baseURL, { headers: { accept: 'text/html' } });
        } catch (error) {
            // A connection refused here usually means the dev server is still
            // booting; Playwright's own readiness check races with the first
            // successful bind on slower machines. Keep retrying until the
            // deadline, then report the last failure as the cause.
            if (Date.now() >= deadline) {
                throw new Error(
                    identityFailureMessage(
                        baseURL,
                        `No server answered within ${Math.round(timeoutMs / 1000)}s (${String(error)}).`,
                    ),
                    { cause: error },
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

/**
 * Asserts the response came from Acredia. Exported so the guard itself can be
 * tested against a non-Acredia responder.
 */
export async function assertAcrediaResponse(baseURL: string, response: Response): Promise<void> {
    if (!response.ok) {
        throw new Error(
            identityFailureMessage(
                baseURL,
                `The server answered HTTP ${response.status} ${response.statusText} instead of a page.`,
            ),
        );
    }

    const html = await response.text();
    if (!hasAppIdentityMeta(html)) {
        throw new Error(
            identityFailureMessage(
                baseURL,
                `The page it served carries no <meta name="${APP_IDENTITY_META_NAME}"> marker.`,
            ),
        );
    }
}

export async function verifyBaseUrlIsAcredia(
    baseURL: string,
    options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<void> {
    const response = await fetchBaseUrl(baseURL, options);
    await assertAcrediaResponse(baseURL, response);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
    const baseURL = config.projects[0]?.use?.baseURL;
    if (!baseURL) {
        throw new Error(
            'Playwright has no baseURL configured, so the Acredia identity guard cannot run. ' +
                'Set `use.baseURL` in playwright.config.ts.',
        );
    }

    await verifyBaseUrlIsAcredia(baseURL);
}
