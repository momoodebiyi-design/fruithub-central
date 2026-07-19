# Security regression tests

SQL suites that pin down invariants around authentication, RLS, and
role-scoped RPCs. Any change that reintroduces a previously-fixed
security issue should fail one of these.

## Run

```bash
./scripts/run-security-tests.sh
```

Uses the ambient `PG*` env vars. Read-only — safe to run against any
environment.

## Layout

- `signup_guards.sql` — bootstrap + invite-only signup guards
  (see 2026-07-19 fix for `open_signup_readonly` /
  `OPEN_SIGNUP_BROAD_READ`). Verifies:
  - `bootstrap_allowed()` shape and current state
  - `handle_new_user` still requires a valid invite and never grants
    a default `readonly` role
  - trigger stays attached to `auth.users`
  - `validate_user_invite` rejects expired / accepted / cancelled invites

## Adding a suite

1. Drop a new `*.sql` file in this folder.
2. Start with `\set ON_ERROR_STOP on` and use the `pg_temp.assert(cond, msg)`
   pattern from `signup_guards.sql` (create it in a `DO` block so each
   suite is self-contained).
3. Prefer structural assertions (`pg_get_functiondef`, `pg_policies`,
   `pg_trigger`) over data mutations — the runner has select+insert
   access only, and we do not want tests writing to production tables.
4. End with `SELECT '<suite>: PASS' AS result;` so the runner surfaces
   a clear line per suite.
