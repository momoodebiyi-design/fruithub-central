# Diagnosis: PR #30 "Build unsuccessful"

## Findings
- PR #30 added a database migration (`20261013090000_operational_event_dates.sql`) and code calling 10+ new database functions (`record_manual_movement_with_date`, `create_central_stocktake_with_date`, `preview_stock_on_hand_at`, etc.).
- The PR did not update `src/integrations/supabase/types.ts`, so at commit 95f25d20 those function names were unknown to the type file.
- Lovable's build runs a type check; your local `npm run build` is only `vite build`, which skips type checking. That's why it passed for you.
- The exact error text from the failed build is no longer in the log (the log is empty now). It would have been TypeScript errors in the files calling the new functions, saying the function name isn't in the allowed list.
- After the migration ran, Lovable regenerated the type file automatically (commit bbd85f8, +213 lines adding those functions). A type check on the current code now passes with **0 errors**.

## Smallest safe fix
- Nothing in the code needs to change. Commit bbd85f8 already fixes it.
- To clear "Preview is out of date", trigger one fresh build. Any small edit or a manual rebuild does it. You asked me not to, so I didn't.
- To stop this happening again, run `npx tsgo --noEmit` (or `tsc --noEmit`) on your machine before merging PRs that include migrations. Also commit the regenerated `types.ts` along with the migration.

## Unconfirmed
- I couldn't get the original error message, so the cause is inferred from the commit contents and the fact that it passes now. If the next build still fails, its log entry will have the exact message.
