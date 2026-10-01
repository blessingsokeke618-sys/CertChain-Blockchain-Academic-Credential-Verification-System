/**
 * A stable, Acredia-specific marker emitted on every server-rendered page.
 *
 * The Playwright suite can attach to an already-running dev server, and a
 * generic port (3000) is shared with every other Next.js/CRA project on a
 * developer's machine. Without a marker, attaching to a *foreign* app produces
 * confident-looking failures — or, worse, passes — for code that is not ours
 * (ACREDIA-STELLAR#271).
 *
 * `tests/playwright/global-setup.ts` fetches the base URL before any spec runs
 * and refuses to continue unless this marker is present, so a mismatched server
 * fails with an explicit "not Acredia" message instead of being audited.
 *
 * Keep the name and value stable: the guard is a string comparison, and
 * changing either side alone breaks every browser run.
 */
export const APP_IDENTITY_META_NAME = 'x-acredia-app';

/** Value of the {@link APP_IDENTITY_META_NAME} meta tag. */
export const APP_IDENTITY_META_CONTENT = 'acredia-stellar';

/**
 * Whether a raw HTML document carries the Acredia marker.
 *
 * Matches the tag rather than parsing the document: the Playwright global
 * setup reads the response body as text, so it never needs a DOM. Attribute
 * order is not assumed — React and Next.js are both free to emit
 * `content` before `name` — so each attribute is looked for independently
 * within the same `<meta>` tag.
 */
export function hasAppIdentityMeta(html: string): boolean {
    const metaTags = html.match(/<meta\b[^>]*>/gi);
    if (!metaTags) return false;

    const name = new RegExp(`\\bname=["']${APP_IDENTITY_META_NAME}["']`, 'i');
    const content = new RegExp(`\\bcontent=["']${APP_IDENTITY_META_CONTENT}["']`, 'i');

    return metaTags.some((tag) => name.test(tag) && content.test(tag));
}
