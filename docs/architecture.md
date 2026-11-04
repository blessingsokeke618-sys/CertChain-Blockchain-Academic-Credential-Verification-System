# Architecture

CertChain uses a three-layer architecture. Each layer has a single responsibility and a clear
contract with the others.

---

## Layers

```
┌───────────────────────────────────────────────────────┐
│                  Presentation Layer                    │
│   Next.js App Router · React 19 · Tailwind CSS v4     │
│   Radix UI · Framer Motion · Stellar Wallets Kit      │
└────────────────────────┬──────────────────────────────┘
                         │ HTTP / RPC
┌────────────────────────▼──────────────────────────────┐
│                 Application Layer                      │
│  Next.js API Routes · Supabase Auth · Role resolver   │
│  IPFS (Pinata) · Rate limiting (Upstash) · Email      │
└──────┬──────────────────────────────────┬─────────────┘
       │ Soroban RPC                      │ Postgres (RLS)
┌──────▼──────────────┐          ┌────────▼─────────────┐
│   Blockchain Layer   │          │   Database Layer      │
│  Stellar + Soroban  │          │  Supabase Postgres    │
│  CertChainCredential│          │  Row-Level Security   │
│  contract           │          │  Off-chain index      │
└─────────────────────┘          └──────────────────────┘
```

**Blockchain layer** is the authoritative source of truth. The Soroban contract stores the
credential hash and token ID on-chain. Nothing in the app layer can forge or alter that record.

**Storage layer** (IPFS via Pinata) holds the full credential document and metadata, modelled
as a W3C Verifiable Credential / Open Badges 3.0 JSON-LD document. The document's SHA-256 hash
is what gets stored on-chain, binding the two layers together.

**Database layer** (Supabase Postgres) provides fast, queryable off-chain indexing. It mirrors
the on-chain state and adds institution/student relationships, invite management, and
verification audit logs. All tables have Row-Level Security policies.

---

## Component Responsibilities

| Component | Responsibility |
|---|---|
| `frontend/src/app/` | Next.js App Router pages and API routes |
| `frontend/src/lib/contracts.ts` | Write operations — build, simulate, sign, submit Soroban transactions |
| `frontend/src/lib/contractReads.ts` | Read-only Soroban simulations — no wallet needed |
| `frontend/src/lib/credentialService.ts` | Orchestrates a full credential issuance: IPFS pin → hash → contract write → DB record |
| `frontend/src/lib/credentialHash.ts` | Canonical SHA-256 hash builder (schema v1 + v2) |
| `frontend/src/lib/wallet/adapter.ts` | **The only file allowed to import a wallet library.** Implements `WalletAdapter` over Stellar Wallets Kit. |
| `frontend/src/lib/stellar.ts` | Active network config derived from `runtimeConfig` |
| `frontend/src/lib/runtimeConfig.ts` | Boot-time env validation; fails loudly on unsafe config |
| `frontend/src/lib/ipfs.ts` | Client-side IPFS utilities |
| `frontend/src/lib/ipfsServer.ts` | Server-side Pinata API calls (JWT never exposed to browser) |
| `frontend/src/lib/verifiableCredential.ts` | W3C VC / Open Badges 3.0 document builder |
| `frontend/scripts/indexer.ts` | Off-chain event indexer: reads Soroban events → writes to Supabase |
| `frontend/worker/pinKeeper.ts` | Background IPFS pin-redundancy keeper |
| `contracts/src/lib.rs` | The entire Soroban smart contract |

---

## Data Flows

### Issue a Credential

```
Institution fills form
  → frontend validates input (Zod schema)
  → credentialService.ts builds W3C VC document
  → ipfsServer.ts pins document + metadata to IPFS → returns CID
  → credentialHash.ts computes SHA-256 over canonical JSON payload
  → contracts.ts builds issue_credential(student, issuer, hash, ipfs_uri) transaction
  → WalletAdapter.signTransaction() → issuer's wallet signs
  → sorobanServer.sendTransaction() → Stellar ledger confirms
  → contract emits cred_iss event with token_id
  → Supabase row created (token_id, ipfs_hash, blockchain_hash, metadata)
```

### Verify a Credential

```
Verifier enters token ID (or scans QR)
  → contractReads.ts calls get_credential(token_id) via Soroban RPC simulation
  → returns Credential { student, issuer, credential_hash, ipfs_hash, revoked }
  → frontend fetches IPFS document by CID
  → recomputes SHA-256 over canonical fields → compares to on-chain hash
  → displays authenticity + revocation status
  → privacy-safe entry written to verification_logs (hashed IP, no PII)
```

### Revoke a Credential

```
Issuer clicks Revoke
  → contracts.ts builds revoke_credential(token_id, issuer) transaction
  → WalletAdapter.signTransaction() → issuer's wallet signs
  → Stellar ledger confirms; on-chain record flagged revoked (still readable)
  → Supabase row updated (revoked = true, revoked_at)
```

---

## Security Boundaries

- **Wallet isolation.** Only `wallet/adapter.ts` imports the wallet kit. ESLint and a test
  enforce this boundary. Adding a second import site is a build failure.
- **Server secrets.** `PINATA_JWT`, `SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET` are
  server-only. `runtimeConfig.ts` refuses to boot if any of them appear as `NEXT_PUBLIC_*`
  variables.
- **Contract guard.** The contract's `issue_credential` entry point calls `issuer.require_auth()`,
  so only a Stellar address that has been `authorize_issuer`-ed by the contract owner can mint.
- **RLS.** Every Supabase table has Row-Level Security. The anon key (safe to expose) cannot
  read or write anything it is not explicitly permitted to.
- **Mainnet safety rail.** `runtimeConfig.ts` throws `UnsafeConfigError` — failing the boot —
  if the app is configured for mainnet but points at the known testnet contract ID.

---

## Deployment Topology

```
Vercel (frontend)
  └── Next.js serverless functions (API routes, cron)
  └── Edge middleware (auth guards, rate limiting)

Supabase (database + auth)
  └── Postgres with RLS
  └── Auth (email/password, invite flow)
  └── Custom SMTP (Gmail or Resend)

Pinata (IPFS)
  └── Primary pin provider
  └── Optional secondary provider (pin-keeper redundancy)

Stellar (blockchain)
  └── Soroban RPC (soroban-testnet.stellar.org / mainnet.sorobanrpc.com)
  └── Horizon API (transaction history, account info)
  └── CertChainCredential contract
```

---

## Key Design Decisions

**Why a single unified contract?**
The previous design used two EVM-style contracts (CredentialNFT + CredentialRegistry).
Soroban's persistent storage model makes a registry a first-class concern of the credential
contract itself — splitting them would add cross-contract call overhead and complicate
authorization. One contract, one source of truth.

**Why Supabase alongside the blockchain?**
The contract is authoritative for authenticity. Supabase provides: fast full-text search,
institution/student relationships (the contract knows only addresses), invite management,
verification audit logs, and GDPR erasure. The two are kept in sync by the off-chain indexer.

**Why IPFS for documents?**
Storing a full W3C VC JSON-LD document on-chain would be expensive and inflexible. IPFS gives
content-addressed, censorship-resistant storage where the CID is the integrity guarantee. The
on-chain hash ties the two together: if the IPFS document changes, the hash won't match.

**Why the closed provisioning model?**
Public sign-up was removed (Issue #239). Acredia provisions institutions, institutions provision
students, each via single-use invite links. This prevents credential spam and ensures every
issuer has been vetted by an admin.
