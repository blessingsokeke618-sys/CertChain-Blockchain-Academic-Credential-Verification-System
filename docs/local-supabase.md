# Local Supabase development

This guide runs the whole database and auth stack on your machine. No hosted
Supabase project is required for local work.

## Prerequisites

- Docker (the Supabase CLI runs the local stack as containers)
- Node.js and the repo's frontend dependencies (`npm ci` in `frontend/`)
- The Supabase CLI — use the pinned project copy with `npx supabase` so you do
  not need a global install

All commands below are run from the `frontend/` directory.

## 1. Start the stack

```bash
cd frontend
npx supabase start
```

The first start pulls the images and can take a few minutes. The command prints
the local API URL, the `anon` key and the `service_role` key. Keep that output
handy — you will paste the keys into `.env.local`.

`frontend/supabase/config.toml` fixes the local ports:

| Service | URL |
|---|---|
| API (PostgREST/Auth) | `http://127.0.0.1:54321` |
| Studio (database UI) | `http://127.0.0.1:54323` |
| Auth callbacks / mail | `http://127.0.0.1:54324` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

## 2. Apply migrations and seed data

```bash
npx supabase db reset
```

`db reset` recreates the local database, applies every file in
`frontend/supabase/migrations/*.sql` in filename order, and then runs
`frontend/supabase/seed.sql`. Use it after pulling new migrations.

- **`migrations/*.sql`** are the source of truth for the schema.
- **`supabase/schema.sql`** is a generated, idempotent snapshot for hosted
  projects that do not use the CLI. Do **not** run it against the local
  database — `db reset` already applies the migrations. After adding a
  migration, regenerate the snapshot with `npm run db:schema`.

## 3. Point the frontend at the local stack

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key printed by supabase start>
SUPABASE_SERVICE_ROLE_KEY=<service_role key printed by supabase start>
```

`NEXT_PUBLIC_*` values are compiled into the browser bundle; the
`service_role` key must stay server-only. Then start the app:

```bash
npm run dev
```

The app is available at `http://127.0.0.1:3000`, which matches `site_url` and
`additional_redirect_urls` in `config.toml`.

## 4. Local auth and invites

`config.toml` enables signups (`[auth] enable_signup = true`,
`[auth.email] enable_signup = true`) and disables email confirmation
(`enable_confirmations = false`), so accounts created through the UI are
usable immediately.

- Create test users in Studio → **Authentication** → **Add user**, or through
  the app's sign-up flow.
- Magic links and invite emails are captured by the local mail server at
  `http://127.0.0.1:54324` instead of being sent externally.
- Row Level Security policies from the migrations apply locally exactly as in
  production. Requests from the browser use the `anon` key; server-only API
  routes use the `service_role` key and bypass RLS, so exercise both paths.

Seeded rows from `seed.sql` (demo institutions, profiles and sample
credentials) are available after `db reset` for exercising institution
dashboards and verification flows without hosted data.

## 5. Useful commands

```bash
npx supabase status          # print running services and keys again
npx supabase db reset        # re-apply migrations + seed (destructive locally)
npx supabase stop            # stop the stack, keep the database volume
npm run db:schema            # regenerate supabase/schema.sql from migrations
```

## Troubleshooting

- **Port already in use** — stop another local Supabase instance
  (`npx supabase stop`) or change the ports in `supabase/config.toml`.
- **Auth redirects fail** — confirm the app runs on `127.0.0.1:3000` and that
  `.env.local` points at `127.0.0.1:54321` (not `localhost`, which can resolve
  to IPv6).
- **Missing tables after `supabase start`** — `start` does not apply project
  migrations on a fresh volume; run `npx supabase db reset`.
