# IPFS Pin Redundancy

Academic credentials must be accessible for the lifetime of the credential — potentially
decades. A single IPFS pinning provider is a single point of failure. This document describes
CertChain's pin-redundancy strategy.

---

## The Problem

If Pinata (the primary pin provider) loses a pin or shuts down, the IPFS document linked by
an on-chain credential becomes unreachable. The hash on-chain is still valid, but the full
credential document cannot be fetched.

---

## The Strategy

1. **Primary pin:** Every credential document and metadata blob is pinned to Pinata immediately
   on issuance via `frontend/src/lib/ipfsServer.ts`.

2. **Secondary pin:** A second, independent provider (configurable via
   `SECONDARY_PINNING_ENDPOINT` / `SECONDARY_PINNING_TOKEN`) receives the same pin via the
   IPFS Pinning Services API spec. Any compliant provider works: Filebase, Crust Network,
   Temporal, or a self-hosted `ipfs-cluster`.

3. **Pin keeper:** `frontend/worker/pinKeeper.ts` runs periodically (via `npm run worker:pin-keeper`)
   and verifies that all known pins are present on both providers. Missing pins are re-pinned
   automatically.

---

## Configuration

In `frontend/.env.local` (or production env):

```bash
# Secondary provider — any IPFS Pinning Services API-compliant endpoint
SECONDARY_PINNING_PROVIDER_NAME=web3storage   # or filebase, crust, etc.
SECONDARY_PINNING_ENDPOINT=https://api.web3.storage/pins
SECONDARY_PINNING_TOKEN=your_secondary_token
```

If `SECONDARY_PINNING_ENDPOINT` is empty, the pin keeper records the state as `not_configured`
rather than `failed` — an honest status that does not alert on intentional single-provider
deployments.

---

## Pin Keeper Operation

Run manually:
```bash
cd frontend
npm run worker:pin-keeper
```

Or schedule as a cron job (e.g. Vercel Cron targeting a `/api/cron/pin-keeper` route).

The keeper:
1. Queries Supabase for all credential `ipfs_hash` values.
2. For each CID, checks pin status on both providers via their respective APIs.
3. Re-pins any CID that is missing from either provider.
4. Logs a summary: `{ checked, healthy, repinned, failed, not_configured }`.

---

## Recovery

If a CID is archived or lost from one provider:

1. Fetch the document from the healthy provider:
   ```bash
   ipfs get <CID>
   ```
2. Re-pin to the failed provider:
   ```bash
   curl -X POST https://api.pinata.cloud/pinning/pinByHash \
     -H "Authorization: Bearer $PINATA_JWT" \
     -H "Content-Type: application/json" \
     -d '{"hashToPin": "<CID>", "pinataMetadata": {"name": "credential-<token_id>"}}'
   ```
3. Verify the `pinList` response shows `status: "pinned"`.

---

## Durability Guarantee

With two independent providers and an active pin keeper, a credential document is lost only if:

- Both providers lose the pin simultaneously **AND**
- The pin keeper has not run since the first loss **AND**
- No cached copy exists anywhere (browser cache, gateway cache, local node)

This is a very low probability event for an actively-monitored deployment. For maximum
durability, run the pin keeper at least once per day and monitor its output.
