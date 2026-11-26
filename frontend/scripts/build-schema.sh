#!/usr/bin/env bash
# Regenerate or check supabase/schema.sql — a single, idempotent, paste-and-run
# file built from every migration in order. Run after adding a migration:
#     npm run db:schema
#     npm run db:schema -- --check
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET="supabase/schema.sql"
CHECK_MODE="${1:-}"

if [[ "$CHECK_MODE" == "--check" ]]; then
  OUT="$(mktemp)"
  trap 'rm -f "$OUT"' EXIT
else
  OUT="$TARGET"
fi

{
  echo "-- ============================================================================"
  echo "-- ACREDIA — Full database schema (generated; do not edit by hand)"
  echo "--"
  echo "-- Regenerate with:  npm run db:schema"
  echo "-- Source of truth:  supabase/migrations/*.sql"
  echo "--"
  echo "-- HOW TO USE"
  echo "--   Supabase dashboard → SQL Editor → paste this whole file → Run."
  echo "--"
  echo "-- SAFE TO RE-RUN. Every statement is idempotent:"
  echo "--   • CREATE TABLE / INDEX ... IF NOT EXISTS"
  echo "--   • ADD COLUMN ... IF NOT EXISTS"
  echo "--   • CREATE OR REPLACE FUNCTION"
  echo "--   • DROP POLICY / TRIGGER IF EXISTS before each CREATE"
  echo "-- Existing objects are skipped; missing ones are created. No data is dropped."
  echo "--"
  echo "-- ============================================================================"
  echo

  for f in supabase/migrations/*.sql; do
    echo
    echo "-- ============================================================================"
    echo "-- migration: $(basename "$f")"
    echo "-- ============================================================================"
    echo
    cat "$f"
    echo
  done
} > "$OUT"

if [[ "$CHECK_MODE" == "--check" ]]; then
  if ! cmp -s "$OUT" "$TARGET"; then
    diff -u "$TARGET" "$OUT" || true
    echo "Generated schema is out of date; run npm run db:schema." >&2
    exit 1
  fi
  echo "Generated schema is current."
else
  echo "Wrote $OUT ($(wc -l < "$OUT") lines from $(ls supabase/migrations/*.sql | wc -l) migrations)"
fi
