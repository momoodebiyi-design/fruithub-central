#!/usr/bin/env bash
# Runs the SQL regression suites in supabase/tests/*.sql against the DB
# defined by the PG* environment variables. Fails on the first error.
#
# Locally:  PGHOST=... PGUSER=... PGPASSWORD=... ./scripts/run-security-tests.sh
# Lovable sandbox: env is preconfigured — just run the script.

set -euo pipefail

if [ -z "${PGHOST:-}" ]; then
  echo "PGHOST is not set — cannot reach the database." >&2
  exit 2
fi

cd "$(dirname "$0")/.."
shopt -s nullglob
FILES=(supabase/tests/*.sql)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No test files found under supabase/tests/." >&2
  exit 2
fi

fail=0
for f in "${FILES[@]}"; do
  echo "▶ $f"
  if ! psql -v ON_ERROR_STOP=1 -X -q -f "$f"; then
    echo "✗ $f FAILED" >&2
    fail=1
  else
    echo "✓ $f"
  fi
done

exit $fail
