/**
 * Offline / low-bandwidth verification behaviour (#91).
 *
 * Verification is always a fresh check against the API (which in turn reads
 * the chain and IPFS). A cached result may be displayed for convenience but
 * must never be presented as a valid verification: revocation can happen at
 * any time, so stale data is not evidence.
 */

export type Connectivity = 'online' | 'degraded' | 'offline';

/** Classify connectivity from the browser online flag and connection hints. */
export function classifyConnectivity(isOnline: boolean, effectiveType?: string): Connectivity {
    if (!isOnline) return 'offline';
    const hint = (effectiveType ?? '').toLowerCase();
    return hint === 'slow-2g' || hint === '2g' ? 'degraded' : 'online';
}

/**
 * Turn a failed verification into a user-facing message appropriate for the
 * current connectivity. Never suggests that an offline result is valid.
 */
export function verificationFailureMessage(error: unknown, connectivity: Connectivity): string {
    const original =
        error instanceof Error && error.message ? error.message : 'Failed to verify credential';
    if (connectivity === 'offline') {
        return 'You are offline. Verification requires a fresh network check — reconnect and try again. Any previously shown result is stale and must not be treated as valid.';
    }
    if (connectivity === 'degraded') {
        return `Your connection is slow (${original}). Verification is still checked live; please wait and retry if it times out.`;
    }
    return original;
}

/** Policy constants shared by docs and tests. */
export const OFFLINE_VERIFICATION_POLICY = {
    freshCheckRequired: true,
    cachedResultCanBeDisplayed: true,
    cachedResultCountsAsVerified: false,
    cacheStoresPii: false,
} as const;
