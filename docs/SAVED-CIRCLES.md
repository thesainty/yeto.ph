# Saved audience circles

This is a separate, additive upgrade for TARA’s existing Supabase project, after the account/friendship and real feed/plan migrations. It preserves existing accounts, usernames, friendships, posts, plans, storage identifiers, and connection settings.

## Apply this upgrade once

In the existing project’s SQL Editor or normal migration workflow, run only:

`supabase/migrations/202611020002_saved_audience_circles.sql`

Do not rerun the original account setup or the earlier feed/plan migration. Keep the existing project, public URL, redirects, and `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` values. No private key is needed in the app. This migration is prepared in the repository; local tests do not apply it to the hosted database.

The migration adds private circles and memberships, authenticated circle RPCs, and membership cleanup after removing or blocking friends. It raises the shared post/plan recipient limit from 50 to 500; existing audiences and invitations are unchanged. If circles are not enabled yet or cannot load, the app still allows private items and individual friend selection.

## Choose recipients

- Every new post and plan starts with **Only me**. This also clears a draft’s recipients at any time.
- **All current friends** copies the currently loaded friend list into the draft in one tap, including friends hidden by the search filter. It never selects pending requests or blocked people. If there are more than 500 friends, select a smaller audience; the app never silently drops recipients.
- Search by display name or username to select individual friends. Filtering keeps previous selections. Complete friendship pages and small profile batches load before the picker becomes available.
- Create private circles such as **Pamilya**, **Barkada**, or **Close friends**. Names are 1–40 characters and unique within your account without regard to case. Each account can save up to 50 circles with up to 500 current friends each, including empty circles. Circle names and membership are visible only to their owner; members are not notified.
- Use a circle to copy its current members into the draft. You can then add or remove individuals. Editing, renaming, or deleting a circle does not change the draft you already selected. Select the circle again to use its revised membership.
- Circle edits are saved to your account and shared between the post and plan pickers. Cancelled edits remain unsaved. Circle data is not stored in the demo’s browser storage. Account changes discard drafts and hide the previous account’s circles.

## Fixed audiences and revocation

Publishing sends only explicit recipient IDs. The existing post and plan RPCs validate that each ID is a current, unblocked friend, take the existing profile locks, and insert one fixed audience/invitation row per recipient. No published item references a circle or an “all friends” mode. New friendships, circle membership edits, circle renames, and circle deletion cannot expand or shrink older audiences.

Removing or blocking a friend continues to revoke the pair’s old post audiences, interactions, plan invitations, and attendance. Their saved-circle memberships are also removed in both directions. Unblocking or re-friending restores neither old access nor old circle memberships; sharing again requires a new selection. No circle, post, plan, or friendship grants GPS or location access.

The 500-recipient bound replaces the previous 50-recipient limit for larger friend lists while keeping validation, profile-row locking, and writes bounded. The browser and database enforce the same maximum; no Supabase row-limit setting changes are required. The existing social feed limits (100 recent items and 100 comments per post) are unchanged.

## API and verification

| RPC | Parameters | Result |
| --- | --- | --- |
| `audience_circles_snapshot` | none | Array of `{id, name, member_ids}` for the signed-in owner |
| `save_audience_circle` | `circle_id` (null to create), `circle_name`, `member_ids` | Circle UUID |
| `delete_audience_circle` | `circle_id` | void |

Circle tables use owner-only row-level security. Writes go through the authenticated RPCs; an account cannot supply a different owner. Direct API writes, anonymous calls, and mutations of someone else’s circle are rejected. RPCs use fixed empty search paths and explicit grants. Raw recipient arrays of more than 500 elements are rejected before deduplication.

```sh
npm run build
npm test
node tests/social-database.test.mjs
node tests/circles-database.test.mjs
# Start the two local servers described in tests/accounts.py, then:
python tests/accounts.py
python tests/social.py
python tests/circles.py
python tests/pilot.py
YETO_TEST_URL=http://127.0.0.1:5190 python tests/smoke.py
```

Database tests use isolated local PostgreSQL semantics in PGlite. Browser tests intercept the fake account service; they do not create hosted accounts or write hosted data. After applying the upgrade to the existing project, use disposable content with existing test accounts to confirm a saved circle survives sign-in/reload, a private item stays private, and a circle edit or new friendship cannot grant access to an older post or plan. Verify removal/blocking revokes access before expanding the pilot.
