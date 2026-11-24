import { describe, expect, it } from 'vitest';
import {
    OFFLINE_VERIFICATION_POLICY,
    classifyConnectivity,
    verificationFailureMessage,
} from '@/lib/offlineVerification';

describe('offline / low-bandwidth verification (#91)', () => {
    it('classifies connectivity from the online flag and connection hints', () => {
        expect(classifyConnectivity(false)).toBe('offline');
        expect(classifyConnectivity(true, '2g')).toBe('degraded');
        expect(classifyConnectivity(true, 'slow-2g')).toBe('degraded');
        expect(classifyConnectivity(true, '4g')).toBe('online');
    });

    it('never presents an offline failure as an invalid credential', () => {
        const message = verificationFailureMessage(new Error('fetch failed'), 'offline');
        expect(message).toContain('offline');
        expect(message).toContain('fresh network check');
        expect(message).toContain('stale');
    });

    it('keeps the original message online and explains slow links', () => {
        expect(verificationFailureMessage(new Error('Not found'), 'online')).toBe('Not found');
        expect(verificationFailureMessage(new Error('timeout'), 'degraded')).toContain('slow');
    });

    it('encodes the no-offline-verification policy', () => {
        expect(OFFLINE_VERIFICATION_POLICY.freshCheckRequired).toBe(true);
        expect(OFFLINE_VERIFICATION_POLICY.cachedResultCountsAsVerified).toBe(false);
        expect(OFFLINE_VERIFICATION_POLICY.cacheStoresPii).toBe(false);
    });
});
