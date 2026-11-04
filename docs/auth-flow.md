# Authentication & Roles

---

## Access Model

CertChain uses a **closed, delegated provisioning model**. There is no public sign-up.

- Acredia **admins** provision institutions.
- Institutions provision their **students**.
- Each new account is reached through a **single-use invite link** that the recipient uses to
  set their own password.
- Credential verification at `/verify` is **fully public** — no account required.

The `/auth/register` route is permanently redirected to `/contact`. This redirect is intentional
and is documented in `next.config.ts`.

---

## Roles

| Role | How it's granted | What it can do |
|---|---|---|
| `admin` | `ADMIN_EMAIL_ALLOWLIST` env var + manual Supabase provisioning | Provision institutions, authorize wallets on-chain, view system stats |
| `institution` | Admin sends invite link → POC accepts | Issue credentials, revoke own credentials, manage students |
| `student` | Institution sends invite link → student accepts | View own credentials, share, claim to wallet |
| `verifier` | No account needed | Access `/verify`, enter token ID / scan QR |

---

## Session Flow

### Login

```
User visits /auth/login
  → Submits email + password
  → Supabase Auth validates
  → Session JWT issued (stored in Supabase cookie)
  → Next.js middleware reads session from cookie
  → roleResolver.ts determines role from profiles table
  → Redirect to /dashboard (institution/student) or /admin (admin)
```

### Invite Acceptance

```
Admin creates institution record
  → Supabase generates single-use invite link
  → Link emailed to POC (or copy-pasted from admin dashboard)
  → POC opens /auth/accept-invite?token=<TOKEN>
  → Sets own password
  → Session created; redirected to /dashboard
```

### Password Reset

```
User visits /auth/login → "Forgot password"
  → Supabase Auth sends reset email
  → User opens reset link → sets new password
  → Redirected to /dashboard
```

---

## Wallet Connection

Wallet connection is **separate from authentication**. A user logs in with email/password, then
optionally connects a Stellar wallet to:

- Issue credentials (institution role, requires on-chain `authorize_issuer`)
- Claim a credential to their Stellar address (student role)

The wallet connection is managed by `wallet/adapter.ts` and does not affect the Supabase
session. The connected wallet address is stored in local state and optionally saved to the
user's profile.

---

## Role Resolution

`frontend/src/lib/roleResolver.ts` determines a user's role on every server request:

1. Read the Supabase session from the cookie.
2. Query the `profiles` table for the user's `role` column.
3. Cross-check against `ADMIN_EMAIL_ALLOWLIST` — admin role requires both a matching email
   AND a provisioned account; email alone is not sufficient.
4. Return the resolved role; the API route or page renders accordingly.

---

## Route Guards

`frontend/src/middleware.ts` (Next.js edge middleware) enforces:

- `/admin/*` — requires `admin` role; redirects to `/auth/admin-login` otherwise.
- `/dashboard/*` — requires any authenticated session; redirects to `/auth/login` otherwise.
- `/auth/accept-invite` — validates the invite token before rendering.
- `/verify` — always public, no guard.

---

## Security Notes

- **Invite links expire.** Supabase invite tokens are single-use and expire after 24 hours by
  default. Admins can regenerate them from the institution detail page.
- **Admin accounts must be provisioned server-side.** A user cannot self-grant the admin role
  by manipulating their profile. The `ADMIN_EMAIL_ALLOWLIST` check in `serverAuth.ts` is the
  authoritative gate.
- **Passwords are never seen by Acredia staff.** The invite flow is designed so the POC sets
  their own password via Supabase's signed invite URL. No staff member can intercept it.
- **Sessions are scoped.** The Supabase anon key (safe to expose) cannot read other users'
  data. RLS policies enforce per-user row visibility.
