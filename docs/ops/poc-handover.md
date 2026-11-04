# POC Handover Runbook

When the Point of Contact (POC) for an institution changes, the following procedure must be
followed to transfer access securely.

---

## Overview

An institution POC has:
- A Supabase account (email + password) granting dashboard access
- Optionally, a Stellar wallet that is authorized on-chain as an issuer

Both must be transferred or replaced. The contract authorization is tied to the wallet address,
not to the person — a wallet handover is a separate step from an account handover.

---

## Step 1: Verify the Incoming POC's Identity

Before making any changes, verify the identity of the new POC through an out-of-band channel
(phone call, video call, or in-person meeting with a government-issued ID). Log the verification
method and date in the institution's audit notes in the admin dashboard.

This step is not optional. A social engineering attack at this point could transfer control of
credential issuance to an unauthorized party.

---

## Step 2: Provision the New Account

1. In Admin Dashboard → Institutions → select the institution.
2. Click "Update POC" — enter the new POC's name and email.
3. Click "Send invite" — this generates a new single-use invite link and emails it to the new
   POC.
4. The new POC accepts the invite and sets their own password.
5. Log in as the new POC to confirm access.

No Acredia staff member sees the password. The invite token is signed and time-limited.

---

## Step 3: Deactivate the Previous Account

1. In Admin Dashboard → Institutions → select the institution.
2. Find the previous POC under "Members".
3. Click "Revoke access" — this disables their Supabase account.
4. Confirm the deactivation is reflected in the audit log.

The previous POC should no longer be able to log in. If they attempt to, they will see an
"account disabled" error.

---

## Step 4: Handle the Wallet Authorization (if applicable)

The previous POC's Stellar wallet may be authorized on-chain as an issuer. This is separate
from their account.

**Option A: The institution retains the same wallet**

If the institution's Stellar wallet is an institutional key (not the departing POC's personal
wallet), no on-chain change is needed. Update the wallet's custody arrangement separately.

**Option B: The wallet was personal to the departing POC**

1. The new POC sets up a new Stellar wallet (or the institution provides one).
2. An Acredia admin authorizes the new wallet:
   - Admin Dashboard → "Authorize Wallet" → enter the new Stellar address → confirm transaction.
3. An Acredia admin revokes the old wallet:
   ```bash
   stellar contract invoke \
     --id <CONTRACT_ID> --network testnet --source owner \
     -- revoke_issuer --issuer <OLD_WALLET_ADDRESS>
   ```
4. Verify the old wallet is no longer authorized:
   ```bash
   make check-issuer ISSUER=<OLD_WALLET_ADDRESS>
   ```
   Expected output: `false`

**Important:** Revoking an issuer's authorization does **not** affect credentials already
issued by that wallet. Existing credentials remain valid and verifiable.

---

## Step 5: Audit Trail

After completing the handover:

1. In Admin Dashboard → Institutions → select the institution.
2. Confirm the audit log shows:
   - Previous POC account deactivated (with timestamp)
   - New POC account created (with timestamp)
   - Wallet authorization changes (if any), with on-chain transaction hashes

The audit log is append-only and cannot be modified via the dashboard UI.

---

## Emergency Handover

If the departing POC is unavailable (e.g. sudden departure, unresponsive):

1. An Acredia admin can disable the account directly in Supabase Auth.
2. If the wallet authorization must be revoked, only the contract owner can do this — the
   departing POC's `require_auth()` is not needed for `revoke_issuer`.
3. Issue a new invite to the new POC from the admin dashboard.
4. Document the emergency handover circumstances in the institution's audit notes.
