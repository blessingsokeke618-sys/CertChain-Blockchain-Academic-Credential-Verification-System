#!/usr/bin/env bash
set -euo pipefail

# Mainnet Deployment Explicit Confirmation Gate (#114)
# Enforces manual confirmation to prevent accidental deployments to Stellar Mainnet.

NETWORK="${STELLAR_NETWORK:-mainnet}"

if [ "$NETWORK" = "mainnet" ]; then
    echo "⚠️  WARNING: You are about to deploy to STELLAR MAINNET!"
    echo "This operation will consume live mainnet XLM and publish irreversible contracts."
    
    if [ "${CONFIRM_MAINNET_DEPLOY:-}" != "CONFIRM_MAINNET_DEPLOY" ]; then
        if [ -t 0 ]; then
            read -r -p "Type 'CONFIRM_MAINNET_DEPLOY' to proceed: " CONFIRMATION
            if [ "$CONFIRMATION" != "CONFIRM_MAINNET_DEPLOY" ]; then
                echo "❌ Mainnet deployment cancelled: Confirmation string did not match."
                exit 1
            fi
        else
            echo "❌ Non-interactive environment detected without CONFIRM_MAINNET_DEPLOY env set. Aborting."
            exit 1
        fi
    fi
    echo "✅ Mainnet confirmation verified. Proceeding with deployment..."
else
    echo "ℹ️  Deploying to non-mainnet target: $NETWORK"
fi
