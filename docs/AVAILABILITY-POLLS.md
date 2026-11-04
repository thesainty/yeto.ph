# Availability polls

In signed-in **Plans**, choose **Find a time** to ask “When are we free?” Add a title, meeting place, plan type, and 2–5 distinct future dates and times. Times are entered and displayed in the Philippines time zone. Ordinary plan creation remains available.

Polls start with **Only me**. Use the existing audience picker to choose up to 500 current friends, including saved circles or **All current friends**. Publishing copies the selected recipient IDs. New friends, later circle edits, and circle deletion never expand the poll or a plan created from it. Removing or blocking a friend permanently revokes their old poll access and votes; re-friending does not restore them.

The organizer and invited friends can select every option that works, then save their availability. Saving with no selected options clears their votes. Poll results show vote totals and the current user's choices. Only the organizer can choose a time and create the plan, using the poll's saved details and remaining original audience. Voting does not RSVP to the resulting plan; invitees join or leave that plan separately.

Each poll can create one plan. Conversion closes voting, and cancelling that plan does not reopen the poll. The organizer can delete a poll; deleting it does not cancel a plan already created from it.

Invitees receive an account-private `poll_invite` item in the activity inbox. Opening it loads that poll after checking current access, including an older poll outside the latest-100 list. No push notifications or email are enabled.

## Additive upgrade

Migration: [`20261104121739_availability_polls.sql`](../supabase/migrations/20261104121739_availability_polls.sql).

Apply only the new availability-poll migration after the existing accounts, social feed/plans, saved circles, and activity-inbox upgrades. **Do not rerun old setup.** The migration preserves existing accounts, content, audiences, circles, activity, storage identifiers, and Supabase settings. It adds poll storage, access-controlled RPCs, and the poll invitation inbox kind.

The connected project has this upgrade installed as `availability_polls`, migration-history version `20261104122606`. The source file keeps its CLI-generated name. Do not apply it again to that project.

## API

All operations require an authenticated account. Direct client writes to poll tables are denied.

| RPC | Parameters | Result |
| --- | --- | --- |
| `plan_polls_snapshot` | none | `{ polls: [...] }`, latest 100 visible polls |
| `plan_poll_target_snapshot` | `poll_id: uuid` | `{ polls: [...] }`, exact authorized poll or empty list |
| `create_plan_poll` | `poll_title: text`, `poll_place: text`, `poll_kind: text`, `option_times: timestamptz[]`, `invitee_ids: uuid[]` | Poll UUID |
| `set_plan_poll_votes` | `poll_id: uuid`, `option_ids: uuid[]` | void; replaces caller's choices |
| `convert_plan_poll` | `poll_id: uuid`, `option_id: uuid` | Resulting plan UUID |
| `delete_plan_poll` | `poll_id: uuid` | void; organizer only |

Titles allow 1–70 characters, places 1–90, and plan types are `coffee`, `food`, or `trip`. Server checks reject invalid audiences, duplicate or past creation times, foreign option IDs, and votes on closed or expired options. Conversion uses the saved audience and is serialized to prevent duplicate plans.

## Validation

Run `npm run build` and `node tests/polls-database.test.mjs`. Database tests use isolated PostgreSQL semantics; they do not contact the hosted project. Run `python tests/polls.py` with the configured/unconfigured local servers described in `tests/accounts.py`. Browser checks use intercepted fictional accounts and should cover private defaults, explicit audiences, multi-option voting, plan conversion, inbox targets, failed saves, account switching, and small screens in both themes.

For hosted rollout, compare existing-data counts before and after the additive migration, verify RLS and grants, then exercise the poll RPCs inside a transaction that is rolled back. Hosted rollback checks must leave no polls, votes, plans, or inbox invitations behind.

The completed checks passed: production build, 67 configuration/database checks (including 16 poll checks), and 85 browser checks (including 13 poll checks). Browser tests use fictional accounts with intercepted requests. Authenticated hosted rollback checks verified private/shared audiences, voting, inbox read state, one-plan conversion, independent RSVP, cancellation, removal, and no audience restoration after re-friending. Counts and fingerprints for existing accounts, profiles, friendships, posts, plans, circles, and activity matched before and after; no test polls, options, invitations, or votes remained.

All four poll tables have RLS enabled, authenticated reads subject to policies, no anonymous reads, and no direct client writes. Security advisors reported the same pre-existing [authenticated-definer RPC notices](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) and [disabled leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), with no new poll findings. Existing authentication settings were preserved. Public poll mutations use invoker wrappers around private, authenticated implementations with fixed search paths.
