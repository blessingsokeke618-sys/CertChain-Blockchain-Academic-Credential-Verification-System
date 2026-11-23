# Provide a standalone Stellar dev network (#82)

## Summary

Contract development previously depended on testnet availability and its faucet. This adds a Compose service running
Stellar quickstart in standalone mode, a frontend env profile pointing at local RPC/Horizon, and a guide covering the
full build → deploy → invoke loop offline.

## What changed

- **`docker-compose.yml`** (new) — `stellar/quickstart:testing` in `--standalone` mode with RPC on 8000, Horizon on 8001,
  a healthcheck, and a named volume so the ledger survives restarts.
- **`frontend/.env.local.local.example`** (new) — `custom` network profile with the standalone passphrase and local
  RPC/Horizon URLs, kept separate from the testnet defaults.
- **`docs/local-stellar-network.md`** (new) — startup, CLI network registration, friendbot funding, build/deploy/
  initialize/invoke commands, frontend wiring and troubleshooting.
- **`README.md`** — links the offline workflow next to the existing quick-start TL;DR.

## Acceptance criteria addressed

- A fresh clone can deploy and invoke the contract fully offline after the image is pulled once.
- The README documents the local profile.

closes #82
