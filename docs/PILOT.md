# TARA invited-user pilot

**Stay connected. A little closer.**

Start with 5–10 people you know for a suggested 2–3 days at [tara-together.vercel.app](https://tara-together.vercel.app/). The aim is to learn whether people can connect, share an update, and make a plan without help.

The project owner has reported successful two-account checks for friends, private and selected-friend posts, comments, plans, RSVPs, and access revocation. Those reports are separate from the automated browser tests, which use mocked responses. The pilot gathers feedback from more people and devices; it is not a public-release certification.

## Invite your first group

Send the message below yourself to a small group. Pair people who already know one another so everyone has a friend to connect with. Ask them to return feedback to you through the same conversation.

Start with one pair. Confirm their sign-in and any confirmation email work before expanding to the rest of the group.

The website has a public URL and signup. This pilot limits whom you invite; the app does not enforce an invitation-only signup gate. Keep the pilot link within your chosen group.

> I’m trying a small pilot of TARA — Stay connected. A little closer.
>
> Would you try https://tara-together.vercel.app/ over the next couple of days? Sign in or create your own account, connect with someone you know, share a small update, and try a plan together. Open **Pilot guide** in the app for the steps.
>
> Friends, posts, comments, and plans are real. The map and journey tools are demos; no GPS or real location sharing is enabled.
>
> Tell me what felt easy, confusing, or broken by replying here. Thanks for helping me test it.

## First visit

1. Open the website. Without signing in, you will see fictional sample people and content.
2. Choose **Set up your account**. Use your existing account, or create your own account and follow the email confirmation instructions before signing in. If confirmation does not arrive, tell the person who invited you instead of creating duplicate accounts.
3. Open your profile, choose a recognizable display name and username, and save it. Exchange usernames with your partner directly.
4. Open **Friends**, search for your partner’s username, send a request, and have them accept it. They can use **Requests** to respond.

Connection lists and social content refresh on focus and every 30 seconds while the page is visible. Use **Refresh** if you are waiting for a request, post, or RSVP.

The audience picker starts with **Only me** for each new post or plan. Search friends, tap **All current friends**, or create a private saved circle such as Pamilya or Barkada. A circle is a shortcut for selecting current recipients; its name and members stay private to you. Circle changes and new friendships never update older audiences. Saved circles and the 500-recipient limit need the separate [circle upgrade](SAVED-CIRCLES.md) before hosted testing.

Check **Audience review** before publishing and expand its recipient names to confirm your selection. When the separate [inbox upgrade](ACTIVITY-INBOX.md) is enabled, the bell shows requests, invitations, RSVPs, comments, and reactions. Opening it leaves unread items unchanged until you open an item or choose **Mark visible as read**.

## Try together

Use disposable content such as “Pilot hello” and “Pilot coffee” so you can remove it afterward.

| Try | What should happen |
| --- | --- |
| Publish a post with **Only me** | You can see it; your partner cannot. |
| Publish a new post selecting your partner | Your partner can see it after refresh. They can like it and add a comment; you see those changes. |
| Create a plan and select your partner | Your partner sees the invitation in **Plans** and can join or leave. You see the attendee change. |
| Refresh or reopen the app | Your real posts, comments, plans, and RSVPs remain available to their permitted accounts. |
| Delete your disposable post or cancel your plan | It disappears for the people who could see it. |

If both people agree, also try removing or blocking the friendship using disposable shared content. The other person should lose access after refresh. Unblocking or re-friending must not restore access to the old post or plan automatically. Send a new request and create newly shared content if you want to keep testing together.

## What is real and what is a demo

- Signed-in **Friends**, **Home** posts/reactions/comments, and **Plans** use saved account data.
- The anonymous preview, illustrated **Map**, and journey controls use sample content. A friendship, post, invitation, or RSVP never enables location sharing.
- A new plan does not create a feed post automatically. Open **Plans** to see it.
- Choose post viewers and plan invitees when creating the item. To change them in this version, delete/cancel it and create a new one. New friends are never added to old audiences automatically.
- The current lists show up to 100 recent visible posts/plans and up to 100 latest comments per post; older-content pagination is not available yet.
- There is no self-service account deletion yet. Bring account or content concerns privately to the person who invited you; do not assume deleting a post deletes an account.

## Gather feedback and choose the next change

Ask each person to return [the short feedback template](PILOT-FEEDBACK.md), including their device/browser and the step where they needed help. Track responses using tester codes rather than publishing people’s names or private content.

At the end, check whether participants could sign in, connect with their partner, choose the right post audience, and join a plan without step-by-step help. Count where assistance was needed and identify the most repeated problem before inviting more people.

If signup fails, permitted content disappears, or someone can see content they were not selected to receive, pause additional invitations, collect the reproduction steps privately, and fix the issue first. Keep ordinary wording and layout suggestions in the feedback list for the next iteration.
