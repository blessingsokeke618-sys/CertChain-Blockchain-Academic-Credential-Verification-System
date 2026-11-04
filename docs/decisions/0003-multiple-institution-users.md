# ADR 0003: Multiple Users Per Institution

**Status:** Accepted  
**Date:** 2026-08-06  
**Deciders:** CertChain core team

---

## Context

The initial data model had a single user account per institution: one email address mapped
directly to one institution row. This worked for the MVP but created a fragile single point
of failure:

- If the POC leaves, the institution loses access until an admin manually re-provisions.
- There is no way for a registrar and a department head to both issue credentials without
  sharing credentials.
- Larger institutions need role separation: an administrator who manages settings vs. a
  staff member who issues credentials day-to-day.

---

## Decision

Introduce an `institution_members` join table that allows multiple user accounts to be
members of a single institution, each with a role.

**Schema (migration `20260808000000_institution_membership.sql`):**

```sql
CREATE TABLE institution_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  invited_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (institution_id, user_id)
);
```

Roles within an institution:
- `owner` — the POC. Full access. Can add/remove other members.
- `admin` — can issue credentials and manage students. Cannot remove other admins.
- `member` — can issue credentials. Read-only access to institution settings.

---

## Consequences

**Good:**
- Business continuity: if the POC leaves, another `owner` can manage the handover.
- Role separation: institutions with separate registrar and issuance staff can model this.
- Audit trail: each action is tied to a specific user, not just an institution.

**Bad:**
- Increased complexity in role resolution (`roleResolver.ts` must now check
  `institution_members` as well as `profiles`).
- The invite flow now has two paths: Acredia admin invites institution POC (existing) and
  institution POC invites additional members (new).
- RLS policies become more complex (per-institution member visibility).

**Neutral:**
- Wallet authorization on-chain is still per-address, not per-user. A user can be a member
  without their wallet being authorized to issue. Authorization is a separate admin action.

---

## Alternatives Considered

**Option A: Single account, shared credentials**  
Simple, but unacceptable for security and accountability reasons. Multiple people sharing one
password cannot be individually audited.

**Option B: Multiple accounts, each mapped to a separate institution row**  
Would allow multiple users per institution de facto, but creates data duplication (institution
name, address, etc. stored multiple times) and makes cross-institution queries harder.

**Option C (chosen): Join table with roles**  
Standard multi-tenant pattern. Adds complexity but is the right long-term model.

---

## Implementation Notes

- The `institution_members` table was added in migration `20260808000000_institution_membership.sql`.
- `roleResolver.ts` queries `institution_members` to determine a user's institution affiliation
  and within-institution role.
- The admin dashboard's "Add member" flow (institution detail page) invites additional users
  via Supabase invite.
- The POC handover procedure (`docs/ops/poc-handover.md`) describes how to safely change the
  `owner` member.
