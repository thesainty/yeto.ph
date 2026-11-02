# Playful username defaults

New accounts can receive a playful username such as `bouncy_taho_4821`, `sleepy_pandesal_7394`, or `wiggly_mango_0158`. These names do not include an email address or display name.

## Enable the new signup default

In the existing Supabase project's SQL Editor, run only the new file `supabase/migrations/202611020001_playful_signup_usernames.sql` once. It replaces the existing new-user trigger function in place. It does not recreate the trigger, update existing profile rows, or change account IDs, friendships, posts, plans, or permissions.

Do not rerun either earlier setup migration. No new service key, environment variable, Supabase project, or website change is needed. The public browser key cannot install this trigger upgrade; a project administrator applies it in the dashboard or their migration process.

The database chooses friendly word pairs plus four random digits and retries username collisions. A playful UUID-based fallback keeps signups working if the short-name retries are exhausted. Username uniqueness and the existing 3–40-character rule remain enforced by PostgreSQL. Profile display names retain their existing validation; a blank new display name falls back to `TARA friend`.

## Existing accounts

Existing usernames stay unchanged automatically. In the profile editor, choose **Suggest a fun username** to fill a draft, then choose **Save profile** to adopt it. A suggestion is not an availability reservation; if someone has taken it, suggest another or type your own. Closing the account dialog without saving keeps the existing username. Changing a username does not change the account ID or existing connections/content.

## Validation

`node tests/username-database.test.mjs` checks this upgrade against a minimal isolated PostgreSQL scaffold. It does not execute the original setup or contact Supabase. `python tests/usernames.py` checks draft suggestions, explicit save, conflicts, and account isolation using fake browser responses with the local servers documented in `tests/accounts.py`. Neither suite creates real accounts.

After the administrator reports the SQL applied successfully, a genuine new signup can verify the new default during normal use. An existing account's suggestion button verifies the profile flow; it does not prove the server-side new-user trigger was updated.
