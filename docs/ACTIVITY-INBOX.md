# Activity inbox and audience review

TARA’s signed-in bell opens an account-private activity inbox. Posts and plans also show a final audience review immediately above their publishing controls. Existing accounts, content, saved circles, recipient snapshots, storage identifiers, branding, and Supabase connection settings are preserved.

## Activate the inbox once

After the existing account and real feed/plan migrations are already installed, apply only `supabase/migrations/202611020003_activity_inbox.sql` to the existing project through its SQL Editor or normal migration workflow. Do not rerun the old setup. The saved-circle migration is independent: keep it if already installed, or follow [its separate instructions](SAVED-CIRCLES.md) when enabling circles.

The inbox migration is transactional and prepared in the repository; it has not been applied to hosted Supabase by local tests. It adds the private activity table, authenticated read/acknowledgement/target RPCs, server-side capture and cleanup triggers, and a PostgREST schema refresh. It does not change website URLs, redirects, keys, existing profiles, friendships, post audiences, or plan invitations. No private key belongs in the browser.

Until the inbox is enabled, the app shows a friendly unavailable state with **Open friend requests**. Friends, Home, Plans, and audience review continue to work. Audience review needs no additional migration.

## Inbox behavior

- The bell’s unread count and inbox show the latest 100 currently authorized activities, ordered newest first. The count covers that same window so the displayed unread badge can always be cleared. Older-history pagination is not included in this version.
- New incoming friend requests notify their recipient; acceptance notifies the original requester. Declined or cancelled requests disappear. Request links open the Requests view and focus the relevant request; acceptance links open Friends.
- New plan invitations notify invitees. Joining or leaving a plan notifies its organizer, using one latest RSVP activity per invitee/plan. Repeated joins cannot flood the inbox. Each new RSVP state has a new event ID and resets its read state.
- Comments and reactions notify the post’s author. Your own actions do not notify you. Unlike removes the reaction activity; a later reaction is a new unread event.
- Opening the inbox alone does not mark anything read. Opening an unread item marks only that item. **Mark visible as read** acknowledges only the exact displayed unread event IDs, up to 100, so activity arriving during the request stays unread. Read state survives sign-out and device changes through the account.
- Activity refreshes when the inbox opens, on focus, every 30 seconds while visible, and after local social/relationship changes. There are no push alerts or email messages.
- Links fetch the exact authorized post or plan, including items outside the feed’s latest-100 window, then focus its card. An invitation opens even if Plans was filtered to My plans. Background checks preserve subsequent manual filter choices. Unavailable targets show a clear message and remove known stale copies; they never substitute sample content.

Activation imports existing pending friend requests and current plan invitations. It does not import historic comments, reactions, accepted requests, or RSVP actions as new alerts.

## Audience review

Every new post and plan still starts with **Only me**. The review shows either the private audience or **Sharing with N friends** / **Inviting N friends**. Expand **Review N recipients** to inspect exact display names and usernames before publishing. The review uses the same recipient IDs as the picker; it is independent of the search filter and private circle names.

The author/organizer is included separately from the friend count. Missing or unverifiable selections show a warning, and the existing publish validation requires current, unblocked friends. Publishing stores a fixed recipient list; new friendships and later circle edits never expand it. The review itself does not save or publish anything and introduces no extra confirmation dialog.

## Privacy and API

Activity and read state belong only to their recipient. Direct client writes and anonymous access are denied. Activity rows hold source references, not copies of post bodies, comment bodies, circle names, or historical private titles. Current profile names and plan titles are joined only after current source access is checked. Deleting source content removes dependent activity. Removing or blocking permanently prunes the pair’s events; re-friending never restores them. Existing social revocation remains in force. No activity or audience operation grants location access.

| RPC | Parameters | Result |
| --- | --- | --- |
| `activity_inbox_snapshot` | none | `{items, unread_count}` for the latest 100 visible activities |
| `mark_activity_read` | `activity_ids: uuid[]` | Marks only the caller’s still-visible IDs read, at most 100 |
| `activity_target_snapshot` | `post_id: uuid or null`, `plan_id: uuid or null` | Existing social snapshot shape containing exactly one authorized target, or empty arrays |

Target lookup requires exactly one non-null ID and retains existing content and participant visibility rules. It cannot grant access. Read acknowledgements take no owner argument. A delayed acknowledgement of an old RSVP/reaction ID cannot mark a newer event read. Account switches hide old snapshots and discard late responses.

## Verification

```sh
npm run build
npm test
# Start the local unconfigured/configured servers described in tests/accounts.py:
python tests/inbox.py
python tests/accounts.py
python tests/social.py
python tests/circles.py
python tests/pilot.py
YETO_TEST_URL=http://127.0.0.1:5190 python tests/smoke.py
```

Database tests use isolated PGlite with the installed account contract, not hosted data. Browser tests intercept the fake account service. After applying the single inbox upgrade to the existing project, use disposable content between existing test accounts to verify invitations, a reaction/comment, an RSVP, persistent read state, fixed audiences, and removal/blocking revocation.
