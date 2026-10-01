'use client';

import { useState } from 'react';
import { Copy, LogOut, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useStellarAccount } from '@/contexts/StellarContext';
import { MobileWalletNotice } from '@/components/wallet/MobileWalletNotice';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from './dialog';
import { Button } from './button';

export function ConnectWallet() {
    const { address, isConnecting, connect, disconnect, walletName, hasNoUsableWallet } =
        useStellarAccount();
    const [noticeOpen, setNoticeOpen] = useState(false);

    if (address) {
        return (
            <div className="flex h-10 items-center overflow-hidden rounded-lg border border-border bg-card shadow-xs">
                <button
                    type="button"
                    className="flex h-full items-center gap-2 border-r border-border px-3 font-mono text-sm text-foreground transition-colors hover:bg-secondary"
                    onClick={() => {
                        navigator.clipboard.writeText(address);
                        toast.success('Wallet address copied!');
                    }}
                    title="Copy address"
                    aria-label={`${walletName ?? 'Wallet'} connected: ${address.slice(0, 5)}...${address.slice(-4)}. Click to copy full address.`}
                >
                    <span className="flex h-2 w-2 shrink-0 rounded-full bg-success" />
                    <Wallet className="h-4 w-4 text-primary" />
                    <span className="hidden sm:inline">
                        {address.slice(0, 5)}…{address.slice(-4)}
                    </span>
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                <button
                    type="button"
                    onClick={disconnect}
                    className="flex h-full items-center px-3 text-muted-foreground transition-colors hover:bg-destructive/8 hover:text-destructive"
                    title="Disconnect wallet"
                    aria-label="Disconnect wallet"
                >
                    <LogOut className="h-4 w-4" />
                </button>
            </div>
        );
    }

    // On a phone with no reachable wallet, the button explains the situation
    // instead of opening a modal listing desktop extensions
    // (ACREDIA-STELLAR#4). It stays enabled: a disabled control with no
    // explanation is the dead end this issue is about.
    if (hasNoUsableWallet) {
        return (
            <>
                <Button variant="outline" onClick={() => setNoticeOpen(true)}>
                    <Wallet className="h-4 w-4" />
                    Wallet options
                </Button>

                <Dialog open={noticeOpen} onOpenChange={setNoticeOpen}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>Connect a wallet</DialogTitle>
                        </DialogHeader>
                        <MobileWalletNotice className="text-sm text-foreground" />
                    </DialogContent>
                </Dialog>
            </>
        );
    }

    return (
        <Button
            onClick={connect}
            disabled={isConnecting}
            aria-label={
                isConnecting ? 'Connecting wallet…' : 'Connect a Stellar wallet'
            }
        >
            <Wallet className="h-4 w-4" />
            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
        </Button>
    );
}
