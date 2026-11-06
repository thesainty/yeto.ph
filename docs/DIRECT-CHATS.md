# Private friend chats

Open **Chats → New chat → choose a current friend** to start a private one-to-one conversation. Opening an empty chat sends no message or notification. Anonymous users see a sign-in prompt. Existing plan conversations remain inside **Plans → Conversation**.

Chats support text messages of 1–1,000 characters, emoji shortcuts, friend search in **New chat**, and search by name or username in the recent-chat list. Authors can delete their own messages for both people. The phone layout opens one conversation at a time with **Back to chats**; desktop shows the list beside the conversation. Both layouts support light and dark mode.

## Privacy and friendship changes

Only the two current, unblocked friends can open or send to a chat. Each chat belongs to the original friendship row, not just the two account IDs. Removing the friendship or blocking either person permanently removes that thread, its messages, private read markers, and linked notifications. Both confirmations explain that the chat is deleted for both people. Re-friending creates a fresh chat and never restores the old history. Unblocking alone does not restore the friendship or chat.

There are no groups or saved-circle audiences in this first release. Opening a chat never adds a recipient to a post, plan, or plan conversation, and never grants location access.

Messages and unsent drafts are not written to localStorage, sessionStorage, or the demo-data namespace. Drafts and retry nonces stay in memory while switching conversations or returning to the chat list. Account or relationship-scope changes discard them; leaving the Chats screen or refreshing the page also discards them. Retrying the same uncertain send reuses its client nonce so a saved message is not duplicated. Failed reads clear displayed private content, and account/scope guards discard late responses.

## Unread state and delivery

Unread badges are personal. The visible conversation acknowledges only exact loaded messages from the other author, in batches of at most 100. A message arriving during an acknowledgement remains unread until a later fetch. Another person cannot read your read markers. Background tabs and conversations covered by the new-chat dialog, delete confirmation, or an app dialog do not load or acknowledge new replies.

The activity inbox keeps one item per recipient and thread, linked to the latest message. A new message rotates the notification ID and resets its read state, so a stale acknowledgement cannot read a newer item. Notifications contain references rather than message-body copies. Deleting the latest referenced message removes its event without rebuilding an earlier event; any remaining unread messages still count toward the chat badge. Inbox links open the exact authorized thread, including one outside the recent-chat list.

The active, visible conversation refreshes every five seconds. Chat summaries and their unread counts refresh every 15 seconds while the app is visible. Manual refresh is available. The list shows the latest 100 threads. Each conversation loads its latest 50 messages in ascending order and offers **Load earlier messages** using a timestamp/ID cursor. Refreshing reloads the opened pages so deleted older messages are not retained.

This feature does not enable Realtime, push alerts, email, or a new scheduled job.

## Additive installation

Apply [`20261106115515_direct_friend_chats.sql`](../supabase/migrations/20261106115515_direct_friend_chats.sql) once after the existing private plan-conversation upgrade. **Do not rerun account setup or earlier migrations.** This adds three RLS-protected tables, authenticated chat RPCs, and the `direct_message` activity kind. It preserves existing accounts, content, audience snapshots, storage identifiers, and Auth/Storage/Cron settings.

Direct client writes are denied. Public RPCs use invoker privileges; narrowly granted private mutation helpers check authentication and current friendship access with fixed empty search paths. Mutations lock participant profiles in canonical order before the thread and message. Friendship deletion cascades through the thread, and a block trigger revokes it even before ordinary friendship cleanup completes. The existing plan activity index and RSVP trigger remain compatible.

The connected project records `direct_friend_chats` at version `20261106215356`. Its source keeps the CLI-generated filename above. Do not reapply it on that project.

## API

| RPC | Parameters | Result |
| --- | --- | --- |
| `direct_chats_snapshot` | none | `{ chats: [{ id, friend, last_message, unread_count, created_at }] }`, latest 100 threads |
| `open_direct_chat` | `friend_id: uuid` | Existing or newly created thread UUID; no message is sent |
| `direct_chat_snapshot` | `chat_id: uuid`, `before_created_at: timestamptz \| null`, `before_id: uuid \| null` | `{ chat, messages, unread_count, has_more, next_before }`, up to 50 messages in ascending order |
| `send_direct_message` | `chat_id: uuid`, `body_text: text`, `client_nonce: uuid` | Message UUID; identical nonce/content returns the original message |
| `delete_direct_message` | `message_id: uuid` | void; authorized author only |
| `mark_direct_messages_read` | `chat_id: uuid`, `message_ids: uuid[]` | void; up to 100 exact authorized message IDs |

All RPCs require authentication. `chat` contains `id`, `friend`, and `created_at`. Messages expose only ID, author profile, body, and creation time. A non-null `last_message` contains `id`, `body`, `created_at`, and `from_me`. Pages do not expose the other person's read markers.

## Validation

Run `npm run build` and `npm test`. `npm run test:chats` runs the isolated PostgreSQL contract without contacting hosted accounts. It covers grants/RLS, friendship-bound access, nonce retries, cursor pagination, exact unread acknowledgements, notification coalescing, deletion, removal/block revocation, no history restoration, and compatibility with existing features.

Run `python tests/direct-chats.py` with the configured/unconfigured local servers described in `tests/accounts.py`. Browser checks intercept fictional account and chat responses; they do not send messages to real people. They cover search, sends and retries, pagination, deletion, unread state, notification links, stale responses, account changes, modal pauses, and mobile light/dark layouts.

The production build and all 137 Node checks passed, including 20 direct-chat database checks. All 143 browser checks passed: 22 direct-chat checks and 121 existing-app regressions, with phone and desktop visual review. The hosted RPC smoke passed 34 assertions in a rolled-back transaction. Fingerprints across all 22 existing public tables and the four account identities matched before and after; no test chats, messages, read markers, or events remained. RLS is enabled on all three new tables, and the existing reminder job remained active with a successful latest run.

Security advisors reported the same pre-existing [authenticated-definer RPC notices](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) and [disabled leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), with no new findings. Auth/Storage/Cron settings were preserved.
