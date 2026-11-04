# Yeto accounts and friendships

Apply `migrations/202610310001_accounts_and_friends.sql` **once to a new Supabase project** using the SQL editor, or apply it through the Supabase migration workflow. Existing app accounts created just before the migration are backfilled. It is a transactional migration; a failure rolls the migration back. It is not an idempotent script for repeated execution.

This migration creates no location tables and grants no location access. Friendship is a social connection only.

## API contract

All operations require a signed-in Supabase user and the public/publishable browser key. Never put a `service_role` or secret key in the app.

- `profiles`: `id`, `username`, `display_name`, `created_at`. No email or location fields. Sign-up creates a unique `yeto_` + UUID username. Users may update only their own `username` and `display_name` columns; usernames must be 3–40 lowercase ASCII letters, digits, or underscores. Display names must contain visible content, be trimmed, contain no control characters, and be at most 60 characters.
- `friend_requests`: `id`, `requester_id`, `recipient_id`, `status`, `created_at`, `updated_at`. Status is `pending`, `accepted`, `declined`, or `cancelled`. Only participants may read; writes use the RPCs below.
- `friendships`: `id`, `user_a`, `user_b`, `created_at`. The canonical pair has `user_a < user_b`. Only participants may read. Acceptance creates one pair atomically.
- `blocks`: `blocker_id`, `blocked_id`, `created_at`. Only the outgoing blocker can read their block row. Blocking hides the pair's profiles from each other, prevents both request directions, cancels pending requests, and removes friendship. Unblocking never restores old requests or friendship.

RPCs (parameter names matter for `supabase.rpc`):

| RPC                      | Parameters                                  | Result                               |
| ------------------------ | ------------------------------------------- | ------------------------------------ |
| `search_people`          | `search_text: text`                         | Rows of `id, username, display_name` |
| `send_friend_request`    | `target_id: uuid`                           | Request UUID                         |
| `respond_friend_request` | `request_id: uuid, accept_request: boolean` | void                                 |
| `cancel_friend_request`  | `request_id: uuid`                          | void                                 |
| `remove_friend`          | `target_id: uuid`                           | void                                 |
| `block_person`           | `target_id: uuid`                           | void                                 |
| `unblock_person`         | `target_id: uuid`                           | void                                 |

Search uses a literal, case-insensitive username or display-name prefix, requires 2–60 characters, excludes self and either-direction blocks, and returns at most 20 rows. `%` and `_` are not treated as search wildcards. Profiles are discoverable to signed-in people; private data must not be added to this table without a separate access design.

Block-list display names are unavailable through the ordinary profiles query after blocking. The UI can display the blocked ID and remove a block; do not weaken profile hiding merely to decorate that list.

All relationship writes take both profile-row locks in canonical order to serialize operations on a pair. SQL grants and row-level-security policies reject direct relationship writes, sender spoofing, unauthenticated calls, and third-party acceptance. SECURITY DEFINER functions use a fixed empty search path with qualified references. Explicit function grants to `anon` and other API roles are revoked before intended permissions are granted, including when inherited from Supabase defaults.

## Local validation

```sh
node tests/database.test.mjs
```

This executes 12 named checks with real PostgreSQL semantics in PGlite. The test fixture emulates Supabase's `auth.users` table, `auth.uid()`, API roles, and explicit default function grants. It verifies RLS, grants, input constraints, request ownership, friendship transitions, and blocking. It does **not** verify hosted Supabase Auth, email delivery, JWT issuance, deployment, multi-connection concurrency, or end-to-end remote connectivity. Those checks require the actual project after it is created.

## Additive availability polls

Existing projects use [`migrations/20261104121739_availability_polls.sql`](migrations/20261104121739_availability_polls.sql) after the accounts, social, saved-circle, and activity-inbox upgrades. Apply that new migration once; **do not rerun the account setup or earlier upgrades**. See [the poll setup and API contract](../docs/AVAILABILITY-POLLS.md).

The connected project already records `availability_polls` at version `20261104122606`. Its source file keeps the CLI-generated timestamp above; do not rerun it on that project. Hosted rollback verification passed and existing-data fingerprints matched.

Polls keep explicit recipient UUIDs, default to **Only me**, and allow up to 500 current friends. The organizer and invitees can vote for multiple proposed times. Only the organizer can convert a poll into one plan, using the remaining original audience; votes do not become RSVPs. Relationship removal/blocking permanently revokes poll access and votes. The upgrade adds private `poll_invite` inbox items without enabling push or email.

Run `node tests/polls-database.test.mjs` for the isolated database contract. Before hosted rollout, review RLS/grants and compare existing-data counts. Verify the new RPCs in a rolled-back hosted transaction so test polls, votes, plans, and invitations do not persist. Existing accounts, data, storage namespaces, and Supabase settings must remain intact.
