/**
 * Maps Acredia's design tokens onto the wallet kit's modal theme.
 *
 * The kit ships a generic blue-and-grey modal. Dropping that into the product
 * unchanged would be the one screen in the connect flow that does not look
 * like Acredia — and it is the screen users meet *before* they trust us with
 * a wallet, which is the worst possible place to look unfamiliar.
 *
 * Values are read from the live CSS custom properties rather than duplicated,
 * so the modal follows `globals.css` (light and dark) without a second source
 * of truth to keep in sync.
 */

/** The kit's theme token names. Its `SwkAppTheme` type, restated locally so this file stays kit-agnostic. */
export interface WalletModalTheme {
    background: string;
    'background-secondary': string;
    'foreground-strong': string;
    foreground: string;
    'foreground-secondary': string;
    primary: string;
    'primary-foreground': string;
    transparent: string;
    lighter: string;
    light: string;
    'light-gray': string;
    gray: string;
    danger: string;
    border: string;
    shadow: string;
    'border-radius': string;
    'font-family': string;
}

/** Reads a CSS custom property off `<html>`, falling back when it is unset. */
function token(name: string, fallback: string): string {
    if (typeof window === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/**
 * Builds the modal theme from the current computed design tokens.
 *
 * Call this at modal-open time rather than once at module load: the user can
 * flip the theme (next-themes) at any point, and a theme captured at import
 * would leave a light modal sitting on a dark page.
 */
export function buildWalletModalTheme(): WalletModalTheme {
    return {
        background: token('--popover', '#ffffff'),
        'background-secondary': token('--secondary', '#eef2f7'),
        'foreground-strong': token('--foreground', '#0f2136'),
        foreground: token('--popover-foreground', '#0f2136'),
        'foreground-secondary': token('--muted-foreground', '#3a4b5e'),
        primary: token('--primary', '#0a2540'),
        'primary-foreground': token('--primary-foreground', '#ffffff'),
        transparent: 'rgba(0, 0, 0, 0)',
        lighter: token('--card', '#ffffff'),
        light: token('--muted', '#f4f6fa'),
        'light-gray': token('--border', '#e2e8f0'),
        gray: token('--muted-foreground', '#3a4b5e'),
        danger: token('--destructive', '#c53434'),
        border: token('--border', '#e2e8f0'),
        shadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
        'border-radius': token('--radius', '0.75rem'),
        'font-family': 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
    };
}
