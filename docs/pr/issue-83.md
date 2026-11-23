# Document the local Supabase development workflow (#83)

## Summary

The repo already contained `frontend/supabase/config.toml`, migrations and `seed.sql`, but contributors were told to use a
hosted Supabase project. This adds a complete local-development guide and links it from the README.

## What changed

- **`docs/local-supabase.md`** (new) — covers:
  - prerequisites and `npx supabase start`;
  - the configured local ports for API, Studio, mail/auth and Postgres;
  - `npx supabase db reset` to apply `migrations/*.sql` and `seed.sql`, and the distinction between the generated
    `schema.sql` (hosted snapshot) and the migrations (source of truth);
  - exact `.env.local` values using the keys printed by `supabase start`;
  - local auth behaviour (signups enabled, confirmations disabled, mail captured on port 54324) and the RLS/service-role
    split;
  - useful commands and troubleshooting for port conflicts, redirect URLs and missing tables.
- **`README.md`** — the Database Setup section now links the local guide and states that no hosted project is needed.

## Acceptance criteria addressed

- A contributor can run the app against local Supabase by following the guide.
- No hosted project is required for local development.

closes #83
