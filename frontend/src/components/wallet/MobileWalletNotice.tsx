'use client';

import { Monitor, Smartphone } from 'lucide-react';

/**
 * What a phone user sees when this device has no wallet it can use
 * (ACREDIA-STELLAR#4).
 *
 * The old failure was a dead end with wrong copy: "Freighter wallet not
 * detected. Please install the browser extension!" — told to install a desktop
 * extension, on a phone. This is the same dead end with accurate copy and a
 * route out of it, which is the difference between a bug and a limitation.
 *
 * Deliberately names no wallet the student cannot get. Every option here is
 * either reachable from the phone they are holding or explicitly labelled as
 * needing a computer.
 */
export function MobileWalletNotice({ className }: { className?: string }) {
    return (
        <div
            className={
                className ??
                'rounded-lg border border-info/25 bg-info/8 px-4 py-3 text-sm text-foreground'
            }
            role="status"
        >
            <p className="flex items-center gap-2 font-semibold">
                <Smartphone className="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
                Connecting a wallet on this phone
            </p>

            <p className="mt-2 text-muted-foreground">
                Most Stellar wallets are browser extensions, which only run on a computer. On a
                phone you have two options:
            </p>

            <ul className="mt-3 space-y-2.5">
                <li className="flex gap-2.5">
                    <Smartphone
                        className="mt-0.5 h-4 w-4 shrink-0 text-info"
                        aria-hidden="true"
                    />
                    <span>
                        <span className="font-medium">Use a wallet app.</span>{' '}
                        <a
                            href="https://lobstr.co/"
                            className="font-medium text-primary underline hover:no-underline"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Lobstr
                        </a>{' '}
                        and{' '}
                        <a
                            href="https://hanawallet.io/"
                            className="font-medium text-primary underline hover:no-underline"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Hana
                        </a>{' '}
                        both have iOS and Android apps. Open this page from inside the app&rsquo;s
                        built-in browser, or wait for QR sign-in — we are rolling it out.
                    </span>
                </li>
                <li className="flex gap-2.5">
                    <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
                    <span>
                        <span className="font-medium">Continue on a computer.</span> Open Acredia
                        on a desktop browser and connect there. Your credential stays where it is
                        — it is on the blockchain, not on this device.
                    </span>
                </li>
            </ul>

            <p className="mt-3 text-xs text-muted-foreground">
                Nothing is lost by waiting. A credential issued to your wallet address remains
                claimable whenever you can reach it.
            </p>
        </div>
    );
}
