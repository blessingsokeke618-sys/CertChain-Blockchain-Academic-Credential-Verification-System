# Product Vision

## The One-Line Vision

The trust layer for academic credentials: institutions issue tamper-proof credentials, students
own them for life, and anyone verifies them in seconds — for free.

---

## The Problem

Academic credentials are critical signals of human potential, yet the infrastructure for
managing them is broken:

- **Fraud is easy.** Fake degrees and falsified transcripts cost employers and institutions
  billions annually. A forged PDF is indistinguishable from a real one to a recruiter.
- **Verification is slow.** Contacting a registrar, waiting for a response, and cross-checking
  against a central database can take days or weeks.
- **Students don't own their records.** A university closure, a registrar system failure, or a
  natural disaster can make verified transcripts permanently unavailable.
- **Access is unequal.** In many regions, physical credential verification requires mailing
  documents internationally, paying fees, and waiting weeks.

---

## Our Solution

CertChain replaces the paper-and-registry model with a three-layer system:

1. **Blockchain layer** — A Soroban smart contract on Stellar stores an immutable record of
   every credential: who issued it, to whom, and when. This record cannot be altered,
   deleted, or forged.
2. **Storage layer** — The full credential document (formatted as a W3C Verifiable Credential /
   Open Badges 3.0) is stored on IPFS. Content-addressing means the document cannot change
   without the hash changing — and the hash is on-chain.
3. **Database layer** — Supabase provides fast querying, institution management, and audit
   logs. It mirrors the blockchain but never replaces it as the source of truth.

The result: any employer, university, or institution can verify a credential in seconds from
any browser, with no account required, pointing directly at the Stellar ledger.

---

## Who It's For

### Institutions (universities, colleges, bootcamps, certification bodies)

**Pain:** Verification requests flood registrar offices. Transcript fraud is rampant and hard
to detect. Paper certificates are easy to fake.

**Gain:** Issue credentials once; never answer a verification request again. Every credential
is on-chain and self-verifying. Revocation is instant.

**Journey:**
1. An Acredia admin provisions the institution and sends an invite link.
2. The institution POC accepts the invite and connects a Stellar wallet.
3. The admin authorizes the wallet on-chain (`authorize_issuer`).
4. The institution fills the issuance form (student, degree, subjects, document) and signs the
   transaction with their wallet.
5. The credential is minted on-chain and the document pinned to IPFS.
6. The institution can revoke any credential they issued, at any time.

### Students / Graduates

**Pain:** Requesting transcripts is slow and expensive. Documents can be lost. Sharing
credentials with employers requires involving the institution every time.

**Gain:** Credentials live in a blockchain account you control, forever. Share a link or QR code
— no institution involvement, no delay.

**Journey:**
1. Receive an invite from your institution.
2. Accept the invite and optionally connect a Stellar wallet.
3. Receive credentials directly in your dashboard.
4. Share a verification link or QR code with anyone.
5. Export/download the credential (W3C VC / Open Badges 3.0 format).

### Verifiers (employers, ATS, admissions offices)

**Pain:** Verifying credentials manually takes days. Automated systems can't trust PDFs.

**Gain:** Paste a token ID or scan a QR. Get an instant, cryptographic answer from the
Stellar ledger. No account, no fee.

**Journey:**
1. Open the shared link or go to `/verify`.
2. Enter a token ID or scan the QR code.
3. See authenticity, revocation status, issuer identity, and full credential detail in seconds.
4. Click the Stellar Expert link to inspect the on-chain record directly.

### Admins / Operators

**Pain:** Managing who is trusted to issue credentials, at scale.

**Gain:** A dashboard to provision institutions, authorize issuers on-chain, and monitor
system-wide activity.

---

## Differentiators

| What | CertChain | Traditional registrar | Centralized VC platform |
|---|---|---|---|
| Verification speed | Seconds | Days–weeks | Seconds |
| Verification cost to verifier | Free | Paid (often) | Free or paid |
| Account required to verify | No | Sometimes | Usually |
| Student ownership | Blockchain account | Institution holds records | Platform holds records |
| Tamper resistance | Cryptographic, on-chain | Paper/PDF | Platform-dependent |
| Offline / low-bandwidth friendly | Partial (read cached) | No | No |
| Open standard output | W3C VC / Open Badges 3.0 | PDF | Varies |
| Credential fraud prevention | Hash-locked on-chain | None | Depends on platform |

---

## Business Model (Operator Perspective)

CertChain is open-source. Operators (universities, governments, ed-tech companies) run their own
deployments or use a hosted service.

**Revenue levers for a hosted service:**
- Per-issuance fee for institutions (fractions of a cent on Stellar — easily absorbed or passed on)
- SaaS subscription tiers (institutions per month, credential volume)
- White-label licensing for ed-tech platforms embedding the verification widget
- Enterprise support contracts

**Cost structure:**
- Stellar transaction fees: < $0.01 per credential
- IPFS storage (Pinata free tier covers development; production ~$0.15/GB)
- Supabase hosting (free tier covers early stage; scales with usage)

---

## Roadmap Horizon

See [ISSUE_DRAFTS.md](../../ISSUE_DRAFTS.md) for the full, current backlog.

**Near-term (Phase 2):**
- Batch credential issuance UI (contract support is already live)
- Email notifications for issuance and revocation
- PDF certificate generation

**Medium-term (Phase 3):**
- Credential revocation UI
- Decentralized identity (DID) integration
- Public API for third-party integrations and ATS plugins
- Mobile wallet support improvements (WalletConnect)

**Long-term (Phase 4):**
- Stellar mainnet deployment (pending security audit and key custody decisions)
- Cross-chain credential verification
- Enterprise analytics and compliance tools
- W3C DID:stellar resolver registration
