# Start Yeto in the cloud environment

Use the existing checkout at `/workspace/yeto.ph`. Each cloud task is already isolated; do not create another Git worktree unless the user explicitly requests one.

Node.js 22.12+ is required (validated with v24.19.0). Dependencies and the production output are prepared in the current instance. To refresh dependencies and the build, run `bash scripts/setup.sh` from the checkout. Keep the inherited proxy and TLS configuration.

Live processes do not survive snapshots. In a persistent terminal session:

```sh
cd /workspace/yeto.ph
npm run dev -- --port 5173
```

Use the platform's supported command permission if dependency downloads or binding the server socket are denied by the command sandbox.

For internal readiness checks, request `http://127.0.0.1:5173/` and use a browser to verify the Home heading **Tara, Mika!** and navigation to Map, Plans, and Friends. Do not present localhost addresses as user-facing onboarding preview links.

Run `npm run build` for TypeScript and the production build. With the development server running, `python tests/smoke.py` runs the 12 browser workflows (Python Playwright and `/usr/bin/chromium` are installed in this environment). Browser execution may need the platform's supported command permission.

To test the production bundle, start `npm run preview -- --port 4173` and run `YETO_TEST_URL=http://127.0.0.1:4173 python tests/smoke.py`.

All profiles, notifications, map locations, and journeys are samples. This responsive web prototype does not access GPS, send location data or notifications, or implement native background tracking. Demo changes are stored in the browser. Sample mode needs no API keys or external map providers. Optional real accounts require the public Supabase URL/publishable key and the database migration in `docs/CONNECT-SUPABASE.md`; no hosted project is connected or validated yet. Never use private/admin keys as VITE_ variables.

The onboarding configuration draft rejected install/start updates as uneditable. These files preserve the proposed instructions; their presence does not establish that environment configuration was saved or published.

The optional account foundation adds `npm test` for 2 build-configuration checks and 12 PostgreSQL permission checks. These may need subprocess permission in the command sandbox. `tests/accounts.py` covers 17 account UI flows with intercepted fake HTTP and requires the two local servers described in its header. Do not mistake mocked tests for a hosted-project or email-delivery check.
