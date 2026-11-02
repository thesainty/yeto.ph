# Compact Home

Home prioritizes reading updates. A short greeting, one compact posting prompt, refresh, and the feed replace the long introduction, always-open publishing form, account banner for signed-in users, and unrelated map rail. The anonymous demo uses the same compact direction, with a small check-in prompt and optional demo journey action.

Choose **Share an update** to open a focused composer. Its audience button stays visible next to your identity, with **Only me** as the default. Choosing **Audience** opens the existing friend/circle selector as a second step in the same dialog. Return to the update to review exact recipients and publish. Recipient filtering belongs to this selection step; finding new people remains in **Friends**.

Closing the composer keeps the unsent draft in memory for the current account. Publishing clears it; switching accounts discards it. Audience UUID snapshots, the 500-recipient limit, private circles, and removal/blocking revocation keep their existing behavior. This interface change needs no migration or Supabase setting changes. Light and dark modes remain available.

## Research references

- [Meta: Making it Easier to Create, Discover, and Share Content on Facebook](https://about.fb.com/news/2025/12/making-it-easier-to-create-discover-and-share-content-on-facebook/) describes a cleaner feed and streamlined content creation, with audience controls prominent in the composer. TARA adopts the separation of reading and creating while keeping its own visual identity.
- [Nielsen Norman Group: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) recommends showing essential options first and deferring secondary controls until requested. TARA applies this to audience selection and circle management.

Validation covers compact default Home, explicit creation/audience steps, fixed recipient payloads, draft retention and account isolation, keyboard focus, friend discovery, inbox links, and mobile layouts in both themes. Existing account, social, circle, inbox, pilot, and demo workflows remain regression-tested with intercepted fake account requests.
