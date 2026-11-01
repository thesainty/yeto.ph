# Current Supabase connection status

- Project URL supplied by the user: https://vtuicyjkflyrvwjqfktz.supabase.co
- Project URL and user-supplied publishable key are present in ignored `.env.local`.
- Do not print the key or copy `.env.local` into source archives.
- Production build passed with this configuration.
- The active restricted cloud HTTP policy still excludes `vtuicyjkflyrvwjqfktz.supabase.co`.
- Add that exact hostname in environment Internet access settings before a hosted connection check; do not bypass the proxy or disable TLS verification.
- The same onboarding draft remains at revision 1 and previously rejected updates as uneditable. Proposed environment changes are preserved in `docs/proposed-environment-config.json`, not applied to the runtime.
- The user supplied a Success / No rows returned screenshot after running the complete setup script in Supabase. Migration success is user-reported; four-table/RLS and live API verification are still pending. Do not rerun the migration blindly.
- The Edit setup chat reported successful read-only Supabase checks. The project owner has reported successful hosted registration/email confirmation and supplied a signed-in screenshot. Automated tests here still use fake responses; live cross-user friendship, blocking, and recovery tests remain pending.

For future unconfigured UI tests on this machine, explicitly run the test server with `VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY=` so the real local project settings are overridden. Mocked account tests must continue using their deliberately fake project and intercepted HTTP.

- Current browser deployment reported by the user: https://yeto-ph.vercel.app/ . Site URL and the exact root Redirect URL were shown configured in Supabase. The initial registered-account screenshot exposed the shell’s hardcoded Mika identity; the identity fix binds that shell to the authenticated profile.
