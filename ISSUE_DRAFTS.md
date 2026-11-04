# Issue Drafts — Product & Market Backlog

Full backlog of 25 tracked issues across privacy, standards, indexer/worker, verification
API, docs, and more. Issues are grouped by theme and ordered within each group by priority.

---

## Privacy & GDPR

**#1 — GDPR right to erasure for credential metadata**
When a student requests erasure, the IPFS metadata (which may contain their name and wallet
address) must be unpinned. The on-chain hash record cannot be deleted (blockchain immutability),
but the document it points to can be made unreachable. Implement: unpin from Pinata and any
secondary provider, clear `ipfs_hash` in Supabase, return 404 from the IPFS proxy.

**#2 — Selective disclosure for verifiers**
Allow students to share a subset of credential fields (e.g. "I have a degree in CS" without
revealing GPA or individual subject marks). Requires a ZK-proof or selective-disclosure VC
format. Stretch goal for Phase 3.

**#3 — Verification log retention enforcement**
The `/api/cron/retention` route purges old verification log entries. Verify that the CRON_SECRET
is set in production and that the route is running on schedule (Vercel Cron via `vercel.json`).

---

## Stellar Ecosystem & Standards

**#4 — WalletConnect for mobile**
Eight of ten supported wallets are desktop-only browser extensions. WalletConnect (scan QR with
phone wallet app) is the only path to mobile. Implement: set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
in Vercel env. The code is already in `wallet/adapter.ts` — this is a configuration task.

**#5 — SEP-0001 stellar.toml live validation**
The stellar.toml file is now at `public/.well-known/stellar.toml`. Verify it passes validation
at https://stellar.expert/validator and that `ORG_URL` matches the live deployment domain.

**#6 — SEP-0010 authentication (wallet-based login)**
Allow institutions and students to log in using a Stellar wallet signature instead of (or in
addition to) email/password. Requires implementing the SEP-0010 challenge-response flow server-side.

**#7 — did:stellar resolver registration**
Issuer and student identities are expressed as `did:stellar:<address>` in the VC documents. Register
a `did:stellar` DID method with W3C so that resolvers can look up the DID document. Alternatively,
implement a lightweight resolver at `/.well-known/did.json` or `/<address>/did.json`.

**#8 — SEP-0007 QR codes for credential sharing**
Use the SEP-0007 URI builder (`src/lib/wallet/sep0007.ts`) to generate `web+stellar:` QR codes
for credential sharing. Any SEP-0007-aware wallet can scan the QR and open the verification page
directly, with the verifier's address pre-filled.

**#9 — Horizon event indexer reliability**
The off-chain indexer (`scripts/indexer.ts`) reads Soroban events from the RPC. Add: cursor
persistence (so a restart picks up where it left off), retry with exponential back-off on RPC
errors, and alerting on gaps > 24 hours.

---

## Verification

**#10 — Public verification API**
Expose a machine-readable REST API at `/api/v1/credential/<token_id>` for ATS (applicant
tracking systems) and employer integrations. Rate-limited. Returns JSON matching the
`OnChainCredential` type plus revocation status. No auth required.

**#11 — Batch verification endpoint**
Allow a verifier to submit multiple token IDs in one request. Useful for large employers
verifying a cohort. Returns per-token results.

**#12 — Verification widget (embeddable)**
`frontend/public/widget.js` exists. Wire it up to the public verification API so any website
can embed a "Verify credential" input field with a single `<script>` tag.

---

## Issuance & Operations

**#13 — Batch issuance UI**
The contract already supports `batch_issue_credential` (up to 20 per call). Build the UI:
CSV upload → parse → preview table → issue in chunks → per-row success/failure feedback.
The service layer (`batchCredentialService.ts`, `batchCredentialImport.ts`) is already wired.

**#14 — Credential revocation UI**
The contract supports revocation. Build the UI in the institution dashboard: list of issued
credentials with a "Revoke" button, confirmation modal, on-chain transaction.

**#15 — PDF certificate generation**
Generate a printable PDF certificate from the credential metadata. Libraries: `@react-pdf/renderer`
or `pdfkit`. Store the generated PDF as an additional IPFS pin.

**#16 — Email notifications on issuance**
When a credential is issued, send the student an email notification with a link to their
dashboard and the verification URL. Uses `emailWorker.ts` and the Resend API.

**#17 — TTL keeper cron job**
The credential TTL keeper needs: a funded Stellar account for bumping, a scheduled cron invocation
(add to `vercel.json`), and alerting when the keeper account balance drops below a threshold.

---

## Security

**#18 — Independent smart-contract audit**
Engage an audit firm. See `docs/mainnet-readiness.md` for details. Required before mainnet.

**#19 — Contract owner multisig**
Transfer contract ownership from a single key to a 2-of-3 multisig Stellar account. Required
before mainnet. See `docs/mainnet-readiness.md`.

**#20 — Rate-limit the issuance API**
The issuance API route is currently limited to authenticated institution users. Add a
per-institution per-minute rate limit using Upstash Redis to prevent accidental mass issuance.

---

## Developer Experience

**#21 — stellar-cli bindings generation in CI**
Add a CI step (`make bindings`) that regenerates `frontend/src/contracts/certchain.ts` from the
compiled WASM and fails if the checked-in file differs. Ensures bindings stay in sync.

**#22 — Local development with Stellar standalone network**
Provide a `docker-compose.yml` that starts a Stellar standalone node (quickstart image) for
fully offline local development. Currently developers must use testnet.

**#23 — Supabase local development**
Add `supabase/config.toml` setup instructions for running Supabase locally via `supabase start`.
The `seed.sql` file exists but the workflow isn't documented.

---

## Documentation

**#24 — API reference**
Document every Next.js API route: method, auth requirements, request/response schema, error
codes, rate limits. Publish as OpenAPI 3.0 spec.

**#25 — Contributing guide for Soroban contract changes**
Expand `CONTRIBUTING.md` with: how to set up the Rust toolchain for Soroban, how to run the
full test suite including property tests, and the PR review checklist for contract changes.
