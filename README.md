# TARA — Your people. A little closer.

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

## What works

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

Signed-in names, usernames, initial avatars, and profile controls use the authenticated profile throughout the app. Anonymous preview mode keeps the Mika sample identity. Real profiles and friendships use Supabase, while feed/map/journey activity is still sample data. Initial hosted registration and email confirmation have been reported successful by the project owner; automated account browser tests still use intercepted fake responses. The main Friends screen shows real friends, incoming/outgoing requests, username search, and remove/block controls for signed-in users. Its state is shared with the account panel and incoming-request badges. Connections refresh on sign-in, window focus, and every 30 seconds while visible; a manual refresh is also available. Anonymous Friends stays a device-local demo. Friendship changes never enable sharing or change sample viewers.

Run `npm test` for PostgreSQL permission checks. The account browser suite is `python tests/accounts.py`, with separate configured/unconfigured servers and intercepted fake account responses; see that script for its settings. Existing sample-app browser checks remain in `tests/smoke.py`.

## Prototype boundaries

The main feed, illustrated map positions, journeys, and anonymous demo requests/notifications are fictional sample data. Signed-in Friends and incoming-request notifications use real account connections. Mika is used only for anonymous preview mode; signed-in account identity comes from Supabase. Anonymous sample changes live under `yeto-demo-v1` and signed-in sample changes under `yeto-demo-v1:<user-id>`. Account changes discard unsent screen/form drafts and end the departed account’s demo sharing; previously saved sample content is kept in its own namespace; no demo feed or journey data is sent to another person or server. Authentication and real connection requests go only to the configured Supabase project; signed-in connection lists also refresh in the background while the page is visible. The app does not request device location permission. Friend activity labels and arrival posts are samples, not live observations.

This is a responsive web prototype, not a released iOS/Android app. Real account registration has been reported successful by the project owner; a two-account friend-request test was also reported successful. Hosted blocking and recovery workflows still need end-to-end validation. Per-viewer location authorization, shared feed/plans, push notifications, GPS collection, routing/ETA, background location, moderation/reporting, account deletion, and server-side journey expiry still need implementation before real location sharing. In particular, an accepted friendship must never grant location access: backend sharing grants must be explicit, scoped to viewers, revocable, and expired server-side.

For reliable ongoing sharing on phones, use a native-capable iOS/Android client and validate permissions, background restrictions, accuracy, connectivity loss, and battery behavior on real devices.

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
