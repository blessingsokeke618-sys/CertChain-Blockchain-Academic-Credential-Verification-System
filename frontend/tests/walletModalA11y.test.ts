import { describe, expect, it } from 'vitest';
import { labelForIconPath, labelModalIconButtons } from '../src/lib/wallet/modalA11y';

/**
 * The a11y repairs applied to the wallet-selection modal
 * (ACREDIA-STELLAR#272).
 *
 * Stellar Wallets Kit 2.7.0 renders its header controls as icon-only buttons
 * with no accessible name, which axe rates a *critical* `button-name`
 * violation — on the screen where someone decides whether to trust us with a
 * wallet. `src/lib/wallet/modalA11y.ts` supplies the names; measured against
 * the real modal in Chromium, that took the page from 1 critical violation to
 * 0 across all axe rules.
 *
 * The icon paths below are copied verbatim from the kit's
 * `components/shared/header.js`. That is the point of this file: a kit upgrade
 * that redraws an icon breaks the path matching, and without these assertions
 * nothing would notice until the next manual audit.
 *
 * The repo has no DOM test environment (`environment: 'node'`, no jsdom), so
 * the DOM-touching function is exercised against a small stub rather than by
 * adding a dependency for one file.
 */

/** Real path data from the kit's header component, 2.7.0. */
const KIT_ICON_PATHS = {
    help: 'M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM11 15H13V17H11V15ZM13 13.3551V14H11V12.5C11 11.9477 11.4477 11.5 12 11.5C12.8284 11.5 13.5 10.8284 13.5 10C13.5 9.17157 12.8284 8.5 12 8.5C11.2723 8.5 10.6656 9.01823 10.5288 9.70577L8.56731 9.31346C8.88637 7.70919 10.302 6.5 12 6.5C13.933 6.5 15.5 8.067 15.5 10C15.5 11.5855 14.4457 12.9248 13 13.3551Z',
    close: 'M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z',
    back: 'M7.82843 10.9999H20V12.9999H7.82843L13.1924 18.3638L11.7782 19.778L4 11.9999L11.7782 4.22168L13.1924 5.63589L7.82843 10.9999Z',
} as const;

describe('icon identification', () => {
    it('recognises every header icon the kit renders unlabelled', () => {
        expect(labelForIconPath(KIT_ICON_PATHS.help)).toBe('Help with connecting a wallet');
        expect(labelForIconPath(KIT_ICON_PATHS.close)).toBe('Close wallet selection');
        expect(labelForIconPath(KIT_ICON_PATHS.back)).toBe('Back');
    });

    it('does not guess a label for an unrecognised icon', () => {
        // Inventing a name for someone else's button would be worse than
        // leaving it for axe to report honestly.
        expect(labelForIconPath('M0 0H24V24H0Z')).toBeNull();
        expect(labelForIconPath(null)).toBeNull();
        expect(labelForIconPath('')).toBeNull();
    });

    it('distinguishes the close icon from the back icon', () => {
        // Both start with "M" and similar coordinates; a prefix too short
        // would label the close button "Back".
        expect(labelForIconPath(KIT_ICON_PATHS.close)).not.toBe(
            labelForIconPath(KIT_ICON_PATHS.back),
        );
    });
});

/** A `button` element just complete enough for `labelModalIconButtons`. */
function stubButton({ pathData, text = '', ariaLabel }: {
    pathData?: string;
    text?: string;
    ariaLabel?: string;
}) {
    const attributes = new Map<string, string>();
    if (ariaLabel) attributes.set('aria-label', ariaLabel);

    return {
        textContent: text,
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        hasAttribute: (name: string) => attributes.has(name),
        querySelector: (selector: string) =>
            selector === 'svg path' && pathData
                ? { getAttribute: (name: string) => (name === 'd' ? pathData : null) }
                : null,
    };
}

/** A `ParentNode` whose `querySelectorAll('button')` yields the given stubs. */
function stubRoot(buttons: ReturnType<typeof stubButton>[]) {
    return {
        querySelectorAll: () => buttons,
    } as unknown as ParentNode;
}

describe('labelModalIconButtons', () => {
    it('names the help and close buttons the kit leaves unlabelled', () => {
        const help = stubButton({ pathData: KIT_ICON_PATHS.help });
        const close = stubButton({ pathData: KIT_ICON_PATHS.close });

        expect(labelModalIconButtons(stubRoot([help, close]))).toBe(2);
        expect(help.getAttribute('aria-label')).toBe('Help with connecting a wallet');
        expect(close.getAttribute('aria-label')).toBe('Close wallet selection');
    });

    it('leaves a button that already has text alone', () => {
        // The wallet rows carry their own names; adding aria-label would
        // override the visible text, not supplement it.
        const wallet = stubButton({ text: 'Freighter' });

        expect(labelModalIconButtons(stubRoot([wallet]))).toBe(0);
        expect(wallet.hasAttribute('aria-label')).toBe(false);
    });

    it('does not overwrite a name the kit may add upstream', () => {
        // This repair should quietly become a no-op once the kit fixes it,
        // rather than fighting whatever label upstream chooses.
        const close = stubButton({ pathData: KIT_ICON_PATHS.close, ariaLabel: 'Dismiss' });

        expect(labelModalIconButtons(stubRoot([close]))).toBe(0);
        expect(close.getAttribute('aria-label')).toBe('Dismiss');
    });

    it('ignores unnamed buttons that are not the kit’s icons', () => {
        const foreign = stubButton({ pathData: 'M0 0H1' });

        expect(labelModalIconButtons(stubRoot([foreign]))).toBe(0);
        expect(foreign.hasAttribute('aria-label')).toBe(false);
    });

    it('is idempotent', () => {
        const buttons = [
            stubButton({ pathData: KIT_ICON_PATHS.help }),
            stubButton({ pathData: KIT_ICON_PATHS.close }),
        ];
        const root = stubRoot(buttons);

        expect(labelModalIconButtons(root)).toBe(2);
        expect(labelModalIconButtons(root)).toBe(0);
    });
});

describe('ensureModalA11y', () => {
    /**
     * It runs inside `connect()`, so a throw here would stop a user reaching
     * their wallet — an accessibility enhancement taking down the feature it
     * was meant to improve. There is no DOM in this environment, which is
     * exactly the condition worth asserting.
     */
    it('is a no-op without a DOM rather than throwing', async () => {
        const { ensureModalA11y, __resetModalA11yForTests } = await import(
            '../src/lib/wallet/modalA11y'
        );
        __resetModalA11yForTests();

        expect(typeof document).toBe('undefined');
        expect(() => ensureModalA11y()).not.toThrow();
        // Still safe to call twice.
        expect(() => ensureModalA11y()).not.toThrow();
    });
});
