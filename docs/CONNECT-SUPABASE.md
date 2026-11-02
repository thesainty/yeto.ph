# Connect Yeto, one step at a time

You do not need an Expo account yet. Expo comes later when we build and test native iPhone/Android apps.

Supabase provides Yeto's sign-in service and database. The code is prepared, but **no hosted project is connected or verified yet**. The colorful sample app continues to work without it.

## Your first step

1. Open https://supabase.com/dashboard and create your own account (signing in with GitHub is also an option).
2. Create a new project named **Yeto** in an organization you own. A free plan is suitable for this development stage if offered.
3. Choose a region close to the Philippines, such as Singapore if available.
4. Generate a strong database password and save it in your own password manager. **Do not send that password in chat.**
5. Wait for the project's database to finish provisioning.

You can stop here and return to the chat. Say **“My Yeto project is created.”** We can go through the remaining steps together.

## Prepare the database

In your new project's SQL editor, run the entire contents of:

`supabase/migrations/202610310001_accounts_and_friends.sql`

This migration creates profiles, requests, friendships, and blocks, with database-enforced permissions. It does not store coordinates or grant any location access. Apply it once to a new project. It runs as a transaction: a failure rolls it back. Do not drop existing tables to fix a setup error; share the error text with any sensitive values removed so we can diagnose it.

Run the migration **before** signing up your test users. See `supabase/README.md` for the table/RPC contracts and local permission checks.

## Configure sign-in

In the project's Authentication settings:

- Enable email/password sign-in and keep email confirmation enabled.
- Set the minimum password length to at least 10 characters. The app also checks this, but the server must enforce it.
- Set the Site URL and allowed redirect URLs to the exact origin where you open TARA. For the current deployment, set Site URL to `https://tara-together.vercel.app` and add `https://tara-together.vercel.app/` to Redirect URLs. Save these settings and verify confirmation/password-reset links opened from the new site. Keep the Supabase project/API URL and publishable key unchanged; add development origins only when testing locally.
- Email confirmation and password recovery use the app's root URL as the callback. PKCE links should be opened in the same browser/device that requested them.
- Check the project's email delivery settings. Built-in development email services can have recipient and rate limits. Configure an email provider before inviting people outside the permitted test recipients. Do not disable confirmation to hide delivery failures.

A public HTTPS deployment is still needed for other people to test comfortably. The local cloud process has not been published as a public app.

## Add the two public connection values

Find the project's **Project URL** and **publishable API key** (starts with `sb_publishable_`) in its connection/API settings. Dashboard labels may vary.

For this Vite app, configure:

```text
VITE_SUPABASE_URL=https://your-project-reference.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Either enter these in the environment settings or copy `.env.example` to the ignored `.env.local` file and fill them there. These particular values are public browser configuration, not admin credentials. Never put a database password, `sb_secret_` key, service-role JWT, or any other private credential in a `VITE_` variable. The app deliberately accepts only the modern publishable-key format. Vite stops startup/build before bundling other key formats; never rely on that check as a substitute for keeping private credentials out of browser variables.

If cloud networking is restricted, add **your project's exact hostname** (for example, `your-project-reference.supabase.co`) to the environment's allowed domains. No wildcard or unrestricted network access is required for this feature. A browser outside the cloud environment may use its own network policy.

Restart the Vite server after setting values. For deployment, set them in the hosting provider's build environment and rebuild: Vite embeds public configuration during the build.

## Verify with two test accounts

1. Open **Set up your account** from Home, then **Create account**.
2. Sign up, confirm your email in the same browser, and sign in.
3. Choose a friendly username in the account panel and save the profile.
4. Have a second test account do the same in a separate browser profile.
5. Search by the other username, send a request, and use **Refresh your connections** in the recipient's account panel.
6. Accept the request and refresh both panels. Both should see the friendship.
7. Test cancelling, declining, removing, blocking, and unblocking. Blocked people should disappear from searches in both directions; a friendship should never grant location access.
8. Sign out, sign back in, and test a password reset email in the requesting browser. Do not consider email delivery or hosted permissions verified until these steps actually pass.

Connection lists currently refresh manually; they do not claim to be live notifications. Usernames and chosen display names are discoverable to signed-in users unless either person blocks the other. Email addresses are not in public profiles. A blocked account is intentionally shown without its hidden profile decoration.

## What this milestone does and does not connect

The account panel can use real Supabase accounts and friendships once configured. It is separate from the existing sample feed, illustrated map, sample Mika profile, plans, and journey timers. Those demo features remain browser-local and never send location data to real friends.

Real GPS collection, per-viewer sharing grants, server-side journey expiration, shared social posts/plans, notifications, account deletion, moderation, and native background location are later milestones. Keep this deployment private to invited development testers until those release requirements are implemented and reviewed.

## Checks available without an account

```sh
npm run build
npm test
# With the unconfigured development server running:
python tests/smoke.py
# Account UI tests use a separate configured test server and intercepted fake HTTP:
python tests/accounts.py
```

Database tests execute PostgreSQL via PGlite with a modeled Supabase auth boundary. Account browser tests intercept fake service responses. Neither substitutes for applying and testing this migration on your actual hosted project.
