# Local standalone Stellar network

A `docker-compose.yml` at the repository root starts a self-contained Stellar
network so contract work does not depend on testnet availability or the
friendbot faucet. After the image has been pulled once, the whole loop works
offline.

## 1. Start the network

```bash
# From the repository root
docker compose up -d
docker compose ps        # wait until the service is healthy
```

Services:

| Service | URL |
|---|---|
| Soroban RPC | `http://127.0.0.1:8000/soroban/rpc` |
| Horizon | `http://127.0.0.1:8001` |
| Network passphrase | `Standalone Network ; February 2017` |

To start from an empty ledger, remove the volume:
`docker compose down -v && docker compose up -d`.

## 2. Configure the Stellar CLI

```bash
stellar network add local \
  --rpc-url http://127.0.0.1:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017"
```

Generate a deployer and fund it from the local friendbot (no external faucet):

```bash
stellar keys generate --network local local-deployer
curl "http://127.0.0.1:8000/friendbot?addr=$(stellar keys address local-deployer)"
stellar keys address local-deployer
```

## 3. Build, deploy, initialize and invoke

```bash
cd contracts
make build

stellar contract deploy \
  --wasm target/wasm32v1-none/release/acredia_stellar.wasm \
  --source local-deployer --network local

# Initialize with the deployed contract id and the owner address, then invoke
# using the same network flag, for example:
export CONTRACT_ID=<deployed id>
stellar contract invoke --id "$CONTRACT_ID" --source local-deployer \
  --network local -- get_contract_info
```

The Makefile's `*-testnet` targets still target the public testnet; pass
`--network local` directly for the local loop, or override the Makefile
variables with a local network definition in your shell.

## 4. Point the frontend at the local network

```bash
cd frontend
cp .env.local.local.example .env.local
npm run dev
```

The example profile sets `NEXT_PUBLIC_STELLAR_NETWORK=custom`, the local
passphrase, and the local RPC/Horizon URLs. Supabase can stay local too — see
[docs/local-supabase.md](local-supabase.md).

## Troubleshooting

- **RPC not ready** — `docker compose logs stellar`; the healthcheck retries
  for about five minutes while the standalone network boots.
- **Account not found on invoke** — fund the address with the local friendbot
  URL above; testnet friendbot keys do not exist on the standalone ledger.
- **Wrong passphrase errors** — every CLI command and `.env.local` must use
  exactly `Standalone Network ; February 2017`.
