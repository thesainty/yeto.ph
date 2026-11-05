# Calendar support and personal reminders

In signed-in **Plans**, choose **Add to calendar** or **Remind me** on a plan. Both open **Calendar & reminders**, including for plans created from availability polls. These tools keep the plan's existing audience.

## Personal reminders

Reminders start off. Each account can save **1 day before**, **1 hour before**, both, or neither. Choices are private to that account; the organizer cannot change someone else's reminders. Newly enabling a reminder whose deadline has passed is rejected. Existing choices can still be turned off after their deadline.

The server checks due reminders every minute and creates account-private `plan_reminder` inbox activity. Delivery is idempotent: retrying the job does not create duplicates or reset a read reminder. Opening the inbox follows the existing read-state rules. TARA does not enable browser push alerts or email; the inbox is available when the app is opened.

Opting out removes that account's preferences and linked reminder activity. Cancelling the plan, deleting an invitation, leaving through RSVP, removing a friend, or blocking the organizer/invitee pair removes the affected preferences and activity. Rejoining or re-friending does not restore old reminders.

## Calendar files

**Download calendar event** resolves the exact plan through a fresh authorization check, then downloads an `.ics` file for the user to open in a calendar app. Unsaved reminder edits must be saved or discarded first. The file includes only the plan's title, meeting place, saved start instant, and optional alerts from the user's saved reminder choices whose deadlines remain in the future. It contains no invitee/attendee list or account credentials.

The export uses UTC times, a stable plan UID, escaped text, and UTF-8 content-line folding. The app has no plan end time, so the file does not invent an end time or duration. An account or access change during the request prevents the download.

**An imported calendar event is a copy.** It does not update automatically, and TARA cannot revoke or remove a file or event already saved outside the app. Remove the calendar copy if the plan is cancelled, you leave, or your access is revoked. Any imported calendar alerts are managed by that calendar app.

## Additive installation

Apply these new migrations once, in order, after the existing availability-poll upgrade:

1. [`20261104123952_plan_calendar_reminders.sql`](../supabase/migrations/20261104123952_plan_calendar_reminders.sql) adds personal preference storage, authorization-controlled calendar/reminder RPCs, reminder activity, pruning, and a private dispatcher.
2. [`20261104124007_plan_reminder_schedule.sql`](../supabase/migrations/20261104124007_plan_reminder_schedule.sql) enables `pg_cron` if needed and creates the single `tara-plan-reminders-v1` job on a one-minute schedule. It retains seven days of only that job's run history and leaves other jobs/logs alone. It rejects an existing job with the same name rather than overwriting it.

**Do not rerun old setup or earlier migrations.** Existing accounts, plans, audiences, polls, inbox/read state, storage identifiers, and Auth/Storage settings are preserved. The new reminder table uses RLS with account-private reads and denies direct client writes. The dispatcher has no client-role `EXECUTE` grant; only the server scheduler calls it.

The connected project has both upgrades installed: `plan_calendar_reminders` at migration-history version `20261105114928`, followed by `plan_reminder_schedule` at `20261105115022`. Source files keep their CLI-generated names above. Do not reapply them to that project.

## API

| RPC | Parameters | Result |
| --- | --- | --- |
| `plan_reminders_snapshot` | none | `{ reminders: [{ plan_id, minutes_before: [...] }] }` for the signed-in account |
| `set_plan_reminders` | `plan_id: uuid`, `reminder_minutes: integer[]` | void; replaces that account's choices with `60`, `1440`, both, or an empty list |
| `plan_calendar_snapshot` | `plan_id: uuid` | `{ plan: { id, title, place, starts_at, created_at } \| null, reminder_minutes: [...] }` under current access |

All RPCs require authentication. Only a plan's organizer or a currently authorized invited friend can save reminders or export its calendar details. Public mutation wrappers use invoker privileges and delegate to a narrowly granted private implementation with a fixed search path.

## Validation

Run `npm run build` and `npm test`. The configuration, PostgreSQL, and calendar-export suites pass 95 checks, including 21 reminder database checks and 7 calendar-file checks. The PostgreSQL fixture is isolated and never contacts the hosted project. Run `python tests/reminders.py` with the configured/unconfigured local servers described in `tests/accounts.py`; it uses intercepted fictional accounts and checks actual downloaded files.

The build and 98 browser checks passed, including 13 calendar/reminder checks. Hosted rollback verification passed for default-off personal settings, minimal authorized exports, two-offset delivery, deduplication, read state, opt-out, cancellation, RSVP, and permanent access revocation. Existing-data counts and fingerprints matched across 18 tables, all four accounts remained, and no test preferences or reminder events remained. The active one-minute Cron job completed successfully.

The worker checks actual time after acquiring locks, so a delayed transaction cannot dispatch a reminder after a plan starts or newly enable an elapsed deadline. Security advisors reported the same pre-existing [authenticated-definer RPC notices](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) and [disabled leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), with no new reminder findings. Existing Auth settings were preserved.
