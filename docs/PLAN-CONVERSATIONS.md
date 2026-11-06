# Private plan conversations

In signed-in **Plans**, choose **Conversation** on a plan. The organizer and selected invitees can send text messages of 1–1,000 characters. The latest 50 messages load first; **Load earlier messages** uses a stable timestamp/ID cursor. A private **Only me** plan supports notes visible only to its organizer. RSVP changes do not change the plan's invitation or conversation membership.

## Audience and deletion

Each message saves an explicit audience from the plan's eligible members when it is sent. New friendships, later invitations, and circle changes never expand older messages. A blocked person is excluded from new messages between that pair.

Removing a plan invitation or the organizer/invitee friendship removes the departed person's old grants, read markers, and conversation notifications, and deletes messages they authored in that plan. Blocking between invitees permanently removes their old pair grants while the organizer retains accessible history. Unblocking can permit future messages between existing plan members; it never restores old grants.

Only the currently authorized author can delete a message. Deleting it removes its content and linked read markers/notifications. Cancelling a plan removes its whole conversation. There is no member-management control inside the conversation and no automatic addition of new friends.

## Unread state and delivery

Opening a conversation marks only the exact loaded messages from other authors as read while the conversation is visible. A message arriving during that acknowledgement stays unread until it is fetched. Read markers are personal; other participants cannot see them. New messages hidden behind a delete confirmation are not automatically acknowledged.

The activity inbox keeps one conversation item per plan and recipient, linked to the latest message. A new message rotates that item's ID and resets its read state, so a late acknowledgement of an earlier item cannot read a newer one. Notifications store references rather than copies of message bodies. Deleting the referenced latest message removes its inbox item without rebuilding an older notification; remaining unread messages still contribute to the conversation badge.

Open, visible conversations refresh every five seconds and offer a manual refresh. Unread counts refresh every 15 seconds while the app is visible. Inbox links resolve the exact authorized plan, including one outside the latest-100 plan list. This upgrade does not enable Realtime, push alerts, email, or a new scheduled job.

Unsent drafts remain only in memory when the dialog is closed or a send fails. Account or relationship-scope changes discard them. Client nonces make retries of an uncertain send idempotent. Real messages and drafts are never written into demo/browser storage. Failed reads clear cached content, and account/scope tokens discard late responses. Normal background target revalidation preserves an open conversation and draft until authorization fails.

## Additive installation

Apply [`20261105120302_plan_conversations.sql`](../supabase/migrations/20261105120302_plan_conversations.sql) once after the existing calendar/reminder upgrades. **Do not rerun old setup or earlier migrations.** It adds messages, explicit recipient grants, personal read markers, and the `plan_message` inbox kind. Existing accounts, content, audiences, read state, storage identifiers, and Auth/Storage/Cron settings are preserved.

New tables use RLS and deny direct client writes. Public RPCs use invoker privileges; narrowly granted private mutation helpers check `auth.uid()` and use fixed empty search paths. Conversation mutations lock participant profiles in global UUID order before the plan/message rows. The inbox index and RSVP trigger predicate are upgraded together so reminders and ordinary RSVP activity remain compatible.

The connected project has `plan_conversations` installed at migration-history version `20261106113950`. The source file keeps its CLI-generated name above. Do not reapply it to that project.

## API

| RPC | Parameters | Result |
| --- | --- | --- |
| `plan_conversations_snapshot` | none | `{ conversations: [{ plan_id, unread_count }] }` for visible messages |
| `plan_conversation_snapshot` | `plan_id: uuid`, `before_created_at: timestamptz \| null`, `before_id: uuid \| null` | `{ plan_id, messages, unread_count, has_more, next_before }`, up to 50 messages in ascending order |
| `send_plan_message` | `plan_id: uuid`, `body_text: text`, `client_nonce: uuid` | Message UUID; same nonce/content returns the original message |
| `delete_plan_message` | `message_id: uuid` | void; authorized author only |
| `mark_plan_messages_read` | `plan_id: uuid`, `message_ids: uuid[]` | void; up to 100 exact currently authorized message IDs |

All RPCs require authentication. Messages contain only ID, author profile, body, and creation time. Message pages expose no recipient list or other participants' read markers.

## Validation

Run `npm run build` and `npm test`. The completed node checks pass 117 tests, including 22 isolated PostgreSQL conversation checks. The fixture verifies old-data preservation, grants/RLS, recipient snapshots, nonce retries, pagination, exact unread acknowledgements, notification coalescing, deletion, revocation, and RSVP/reminder compatibility; it does not contact hosted data.

Run `python tests/conversations.py` with the configured/unconfigured local servers described in `tests/accounts.py`. It uses intercepted fictional accounts. The build and 118 browser checks passed, including 20 conversation checks for retries, private unread state, pagination, deletion, stale responses, inbox links, and mobile light/dark layouts.

Hosted rollback verification passed for Only-me/shared privacy, idempotent sends, exact read markers, coalesced notifications, own deletion, cancellation, RSVP/reminder compatibility, revocation, and no access restoration. Fingerprints matched across 19 existing tables; all four accounts remained, with no test messages, recipient grants, read markers, or message events left behind. The existing reminder job stayed active and its latest run succeeded.

Security advisors reported the same pre-existing [authenticated-definer RPC notices](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) and [disabled leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), with no new conversation findings. Auth/Storage/Cron settings were preserved.
