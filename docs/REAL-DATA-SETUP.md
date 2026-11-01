# Activate TARA's real feed and plans

This is a separate, additive upgrade for the existing Supabase project. It does not replace the account/friendship setup, recreate accounts, import sample content, or grant location access.

## Apply the new migration once

1. Open the existing project's Supabase dashboard and its SQL Editor.
2. Open a new query and paste the complete contents of `supabase/migrations/202611010001_social_feed_and_plans.sql`.
3. Run that query once. The transaction adds seven social tables, their access rules, authenticated RPCs, and a trigger that revokes shared content access when a friendship is removed. It also requests a PostgREST schema refresh.

Do not rerun `202610310001_accounts_and_friends.sql`. Keep the existing project, accounts, website address, redirect settings, and `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` settings. No service-role key or database password belongs in the app.

The current app connection has public browser credentials, which cannot install SQL. A project administrator must apply this one migration in the dashboard or through their normal migration process. Local tests do not establish that it has been applied to the hosted project.

## Application behavior

- Signed-in Home and Plans use Supabase. Empty lists and connection/setup errors never substitute fictional friends or sample posts.
- Posts default to **Only me**. Select specific current friends to share a new post. Future friendships never silently gain access.
- Plans default to a private plan with the organizer attending. Select specific current friends to invite. Invited people can see the plan's attendee and invitee names and join or leave; only the organizer cancels it.
- Posts support likes, comments, and author deletion. Comment authors can delete their comments. Deleting a post or cancelling a plan removes its dependent social records.
- Removing or blocking a friendship permanently removes that pair's existing post audiences, plan invitations/attendance, and reactions/comments on one another's posts. Re-friending does not restore old grants; create a new explicitly shared post or plan.
- Lists refresh manually, on focus, and every 30 seconds while visible. Social content is kept in memory, not browser-local demo storage.
- Anonymous mode remains a device-local demo. Previous signed-in sample content remains in its existing local storage namespace and is never uploaded automatically.
- The map and journey tools remain explicitly labelled demos. A post, invitation, RSVP, or friendship never collects GPS or grants location access.

The first version loads the latest 100 visible posts and plans and up to 100 latest visible comments per post; there is no older-content pagination yet. Plans and text posts are separate; creating a plan does not automatically publish a feed post. Invitees and audiences are selected at creation; delete/recreate to change them.

## Validation and activation

Before deploying the application changes, confirm the new SQL succeeded, then deploy the tested source to the existing Vercel project. If the app reports **Feed and Plans setup is pending**, check that this exact new migration was applied to the same Supabase project configured in Vercel and refresh the page. Do not rerun the original setup.

Use the two existing accounts to verify: a private post stays private, an explicitly shared post appears for the selected friend, likes/comments persist after refresh, an invited plan appears in the other account, and its RSVP appears for the organizer. Neither account should gain location sharing. Delete only your own disposable posts/plans when finished.

For local verification without touching hosted data:

```sh
cd /workspace/yeto.ph
npm run build
node tests/social-database.test.mjs
# Run tests/accounts.py and tests/social.py with the two fake/unconfigured
# development servers described in tests/accounts.py; all remote calls are intercepted.
```

The social database test uses an isolated in-memory PostgreSQL instance with a minimal friendship/auth scaffold. It does not execute the original account setup or contact Supabase. Browser mocks test UI/API contracts; the two-account hosted checks above remain necessary after activation.
