import { describe, expect, it } from 'vitest';
import { buildClaimMessage, buildWalletLoginMessage } from '@/lib/walletOwnership';

describe('SEP-0010 wallet login messages (#94)', () => {
    it('produces a login challenge distinct from the claim challenge', () => {
        const login = buildWalletLoginMessage('GABC', 'nonce-1');
        const claim = buildClaimMessage('GABC', 'nonce-1');
        expect(login).not.toBe(claim);
        expect(login).toContain('sign in');
        expect(login).toContain('GABC');
        expect(login).toContain('nonce-1');
    });

    it('binds the message to both the address and the nonce', () => {
        expect(buildWalletLoginMessage('GABC', 'n1')).not.toBe(
            buildWalletLoginMessage('GXYZ', 'n1'),
        );
        expect(buildWalletLoginMessage('GABC', 'n1')).not.toBe(
            buildWalletLoginMessage('GABC', 'n2'),
        );
    });
});
