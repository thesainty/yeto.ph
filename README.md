# TARA — Stay connected. A little closer.

A playful, Philippines-first prototype for staying close to friends and family. Built from the approved mango, coral, and lilac mockup with original local SVG artwork and locally bundled fonts.

## Run

Requires Node.js 22.12+ (validated with Node 24) and npm.

```sh
cd /workspace/yeto.ph
npm ci
npm run dev -- --port 5173
```

Use the existing checkout; each cloud task is already isolated. No extra Git worktree is needed. In a restricted command sandbox, dependency downloads and opening the development server may need the platform's network permission. Keep the inherited proxy and TLS verification configuration.

```sh
npm run typecheck
npm run build
npm run preview -- --port 4173
```

The production output is in `dist/`. The app uses hash navigation, so every screen works on static hosting without rewrite rules. No runtime variables or external services are required for the sample prototype. The optional real account panel requires the public Supabase connection values documented below. Fonts and illustrated maps stay local.

## Anonymous demo

- Light/dark mode switch beside the bell, available throughout the app. Light is the default; your choice is remembered on this browser and synced between its tabs.
- Responsive Home, Map, Plans, and Friends screens, including desktop and mobile navigation.
- Meetup join/leave, plan creation, and a personal plans filter.
- Accept/decline Ana's sample friend request; search sample profiles and send a local request to Nico.
- Search and remove friends; inspect sample Pamilya/Barkada circles.
- Check-in posts, likes, and comments.
- Select an audience and a timed or ongoing **demo** sharing session. Timers expire, survive refresh, and can be stopped immediately. Accepting a new friend or removing a friend stops your session, so a changed circle never silently changes your viewers.
- Illustrated BGC map with selectable sample pins, circle filtering, and zoom controls.
- Browser-local persistence, gracefully handling missing, malformed, or expired data. Signed-in accounts have separate sample-data caches; anonymous demo data stays separate. The anonymous demo can be reset from its sample profile.
- Keyboard-operable controls, focus-trapped dialogs, Escape-to-close, and reduced-motion support.

## Account foundation

The optional account panel supports sign-up, sign-in, email confirmation, password recovery, profile editing, and real friend requests/removal/blocking when connected to a Supabase project. Open **Set up your account** from Home. Without configuration, it shows a setup guide and makes no account-service requests.

Start with [the beginner connection guide](docs/CONNECT-SUPABASE.md). Copy `.env.example` to `.env.local` only when you have the public project configuration. Never place private/admin keys in browser variables. The SQL migration lives in `supabase/migrations/`, with database contracts in `supabase/README.md`.

Signed-in names, usernames, initial avatars, and profile controls use the authenticated profile throughout the app. Anonymous preview mode keeps the Mika sample identity. Real profiles and friendships use Supabase, while anonymous activity and the map/journey tools remain sample data. Signed-in Home and Plans use the separate real-data features described below. Initial hosted registration and email confirmation have been reported successful by the project owner; automated account browser tests still use intercepted fake responses. The main Friends screen shows real friends, incoming/outgoing requests, username search, and remove/block controls for signed-in users. Its state is shared with the account panel and incoming-request badges. Connections refresh on sign-in, window focus, and every 30 seconds while visible; a manual refresh is also available. Anonymous Friends stays a device-local demo. Friendship changes never enable sharing or change sample viewers.

Run `npm test` for PostgreSQL permission checks. The account browser suite is `python tests/accounts.py`, with separate configured/unconfigured servers and intercepted fake account responses; see that script for its settings. Existing sample-app browser checks remain in `tests/smoke.py`.

New signup usernames can use playful defaults such as `bouncy_taho_4821` after the separate [username-default upgrade](docs/USERNAME-DEFAULTS.md) is applied. Existing usernames are preserved. **Suggest a fun username** in the account profile fills an unsaved suggestion; **Save profile** adopts it if available. No existing setup needs to be rerun.

## Real feed and plans

Signed-in Home uses real text updates, likes, and comments. Each update starts private (**Only me**); select specific accepted friends to share it. Authors can delete their updates, and commenters can delete their own comments. Signed-in Plans supports private meetups, selected-friend invitations, attendee names, join/leave, and organizer cancellation. Creating a plan does not automatically publish a feed post. Audiences and invitations are selected at creation; delete/recreate to change them.

These features need the additive upgrade in [docs/REAL-DATA-SETUP.md](docs/REAL-DATA-SETUP.md), after the account foundation is already installed. **Do not rerun the old account setup.** Existing accounts, profiles, friendships, Supabase settings, and storage identifiers are preserved. The project owner reported that feed/plan upgrade applied successfully; authenticated two-account checks should follow deployment.

Posts and plan invitations share a searchable audience picker, with **Only me** as the default, one-tap **All current friends**, and private account-saved circles such as Pamilya, Barkada, and Close friends. Circle CRUD and the increased 500-recipient limit require the separate [saved-circle upgrade](docs/SAVED-CIRCLES.md). Applying a circle copies recipient IDs into the draft; new friends or later circle changes never alter older published audiences. Removing/blocking continues to revoke old access and now also clears saved-circle membership. No existing setup needs to be rerun.

Before publishing, an audience review shows the private audience or exact recipient count with expandable names. The signed-in bell opens an account-private activity inbox for requests, invitations, RSVPs, comments, and reactions, with saved read status and direct links. The inbox needs its separate [additive upgrade](docs/ACTIVITY-INBOX.md); audience review needs no new SQL. Existing setups and settings are preserved.

Home keeps the feed in one compact column. Choose **Share an update** to open the composer, then **Audience** to select existing friends or saved circles. Friend discovery stays in **Friends**. The composer starts with **Only me**, retains an unsent draft while you close and reopen it, and discards it when the account changes. See the [Home design notes and references](docs/COMPACT-HOME.md).

Signed-in Plans also supports **Find a time** availability polls: suggest 2–5 future times, let invited friends vote for every option that works, and let the organizer turn one option into a plan. Polls start with **Only me** and keep the selected audience fixed, including when converted to a plan. Votes do not count as RSVPs. This needs the separate [additive availability-poll upgrade](docs/AVAILABILITY-POLLS.md); existing setup must not be rerun.

Each signed-in plan also has **Add to calendar** and **Remind me** tools. Personal one-day/one-hour reminders start off and can be saved to the account for TARA's inbox; calendar downloads include only chosen future alerts. Imported calendar events are copies that users must remove after cancellation or revoked access. See [calendar/reminder behavior and the additive upgrade](docs/CALENDAR-REMINDERS.md).

Choose **Conversation** on a signed-in plan to coordinate with its existing selected people. Text messages keep a fixed recipient snapshot, unread markers are personal, and authors can delete their own messages. The inbox groups new messages by plan; removing or blocking revokes old access. See [private plan conversations and the additive upgrade](docs/PLAN-CONVERSATIONS.md).

Real social data is never saved in the local demo namespace or replaced by sample content on an error. Connection changes invalidate the displayed snapshot. Removing or blocking a friendship revokes its old post audiences and plan invitations/attendance; re-friending never restores them. No friendship, invitation, RSVP, post, or reaction grants location access. Lists refresh on focus, every 30 seconds while visible, and manually. The first release loads the latest 100 visible posts/plans and 100 latest comments per post without older-content pagination.

Run `node tests/social-database.test.mjs` for isolated PostgreSQL access-control tests of the new migration (no old setup or hosted database). Run `python tests/social.py` with the fake/unconfigured servers described in `tests/accounts.py` for real-data UI/API contract checks. These browser tests intercept all remote requests; they do not create real accounts or content.

## Prototype boundaries

The anonymous Home/Plans/Friends preview, illustrated map positions, and journey tools are fictional sample data. Signed-in identity, Friends, Home feed, Plans, and incoming friend-request notifications use Supabase. The map stays a clearly labelled demo, including for signed-in users. Previous local sample posts and plans stay in their existing `yeto-demo-v1` / `yeto-demo-v1:<user-id>` namespaces; they are never uploaded automatically. Account changes discard unsent drafts and end the departed account’s sample sharing.

This is a responsive web app, not a released iOS/Android app. Real accounts and a two-account friend-request workflow have been reported successful by the project owner. Per-viewer location authorization, GPS collection, push notifications, routing/ETA, background location, shared journey data, moderation/reporting, and account deletion still need implementation before real location sharing. Accepted friendship must never grant location access: any future location grants must be explicit, scoped to viewers, revocable, and expired server-side.

For reliable ongoing sharing on phones, use a native-capable iOS/Android client and validate permissions, background restrictions, accuracy, connectivity loss, and battery behavior on real devices.

## Invited-user pilot

The project owner has verified the deployed two-account flow: private and selected-friend posts, reactions/comments, plan invitations/RSVPs, and access revocation after removing or blocking a friend, including re-friending. These are user-reported hosted results; automated browser tests use intercepted responses.

Start with the [pilot guide and invitation draft](docs/PILOT.md) for a suggested 5–10 people, and the [feedback template](docs/PILOT-FEEDBACK.md). Testers can open **Pilot guide** in the app footer for account setup, a short task list, and a copyable feedback template. Feedback goes privately to the person who invited them; the app does not send or collect it. Recruiting by invitation does not restrict public signup automatically. Keep the existing accounts, Supabase settings, and website address; no database changes are needed for the pilot guide.

## Browser checks

The smoke suite uses Python Playwright and a local Chromium browser. In this cloud environment these are already installed. Elsewhere install the test requirements and provide Chromium:

```sh
python -m pip install -r requirements-test.txt
# With the development or preview server already running:
python tests/smoke.py
```

Set `YETO_TEST_URL` to test a different server. See the smoke script for browser configuration. Tests isolate browser storage and exercise actual user flows rather than only checking that a port is open.

## Reusable cloud startup

See `scripts/setup.sh` and `docs/environment-start.md` for installation and startup. The platform rejected the onboarding draft update as uneditable; those instructions are preserved on disk and in `docs/proposed-environment-config.json`, but have not been saved to the environment configuration or published.

## Code

- `src/App.tsx`: navigation, demo state, dialogs, and interactions.
- `src/screens/`: the four screens and their styles.
- `src/state.ts` and `src/useDemoState.ts`: validation, sharing expiry, and account-scoped sample storage.
- `src/account/useIdentity.ts`: signed-in display names, usernames, and Unicode-safe initials.
- `src/data.ts`: fictional profiles and initial plans.
- `src/components/ui.tsx`: original avatars, wordmark, and accessible dialog.
