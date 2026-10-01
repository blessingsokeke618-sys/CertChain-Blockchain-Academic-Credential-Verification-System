import type { StellarSigner } from '@/lib/stellarSigner';
import { walletAdapter } from './index';
import type { WalletCapabilities } from './types';

/**
 * Bridges the wallet layer to the signing seam (ACREDIA-STELLAR#3).
 *
 * `contracts.ts` needs a {@link StellarSigner}; the user has a connected
 * wallet. This is the one place those two are joined, which is what keeps
 * `contracts.ts` free of any wallet import — the acceptance criterion this
 * issue turns on.
 *
 * The network passphrase arrives per-call rather than being captured here:
 * `contracts.ts` already knows which network it built the transaction for, and
 * a signer holding its own idea of the network is how a transaction gets signed
 * against the wrong ledger.
 */
export function createWalletSigner(
    address: string,
    capabilities?: WalletCapabilities | null,
): StellarSigner {
    const signer: StellarSigner = {
        address,

        async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
            return walletAdapter.signTransaction(xdr, {
                networkPassphrase: opts.networkPassphrase,
                address,
            });
        },
    };

    // `signMessage` is optional on the interface precisely so an incapable
    // wallet can omit it: Albedo and Rabet reject the call. Attaching a method
    // that always throws would let a caller's `if (signer.signMessage)` check
    // pass and then fail anyway.
    if (capabilities?.signMessage === false) {
        return signer;
    }

    return {
        ...signer,
        async signMessage(message: string, opts: { networkPassphrase: string }): Promise<string> {
            return walletAdapter.signMessage(message, {
                networkPassphrase: opts.networkPassphrase,
                address,
            });
        },
    };
}
