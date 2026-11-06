# Compact Chats

Chats now prioritizes the conversation: a smaller header, denser recent-chat rows, grouped message bubbles, and an inline composer replace the taller panels and repeated metadata. TARA keeps its mango, coral, and lilac identity, with playful shapes and restrained accents in both themes.

## Layout and interaction

- Recent chats show the friend’s name, one-line preview, compact last-activity time, and unread count. Search and **New chat** stay close to the list heading.
- Desktop uses a bounded two-column conversation window. Mobile opens one conversation at a time, with **Back to chats** and the composer within reach.
- Consecutive messages from the same author within five minutes share a visual group. Day markers separate dates, while quieter group-end times reduce repetition. Full timestamps remain available for individual messages.
- Message actions sit beside the bubble and timestamps are subdued so the message itself stays easy to read. Own-message deletion remains available to touch and keyboard users; it does not depend on hover alone.
- The composer starts as one compact row and expands for longer drafts. Desktop **Enter** sends, **Shift+Enter** adds a line, and mobile **Enter** keeps adding lines. IME composition does not trigger a send.
- Background read acknowledgements leave draft entry and focus active. Sending and deletion still guard against overlapping changes.
- A header privacy control reveals the friendship and removal/blocking explanation when needed. The same warning remains in friendship-removal confirmations.

This is a presentation update. Existing friend-only access, unread acknowledgements, retry nonces, message deletion, polling, and account isolation retain their behavior. Accounts, messages, drafts’ memory-only handling, storage identifiers, and Supabase settings are unchanged. No migration, new dependency, or copied external component is needed.

## Web research

- [shadcn/ui: Bubble](https://ui.shadcn.com/docs/components/base/bubble) demonstrates grouping consecutive bubbles, content-sized surfaces, and separating message metadata from bubble content. TARA applies those patterns using its existing components and colors. The [chat-card source](https://github.com/shadcn-ui/ui/blob/main/apps/v4/components/cards/chat.tsx) also informed the compact header and inline send control.
- [daisyUI: Chat bubble](https://daisyui.com/components/chat/) presents distinct incoming/outgoing alignment and optional headers and footers. TARA uses this hierarchy to reduce repeated names and timestamps while keeping each speaker clear.
- [Signal: Delete for everyone](https://support.signal.org/hc/en-us/articles/360050426432-Delete-for-everyone) places deletion in message-level contextual actions followed by an explicit choice. TARA adopts the deliberate interaction pattern while retaining its own deletion rules and accessible touch/keyboard controls.

The final layout is an original TARA design inspired by these interaction patterns. It does not add the references’ reactions, attachments, read receipts, encryption claims, or deletion time limits.

## Validation

The production build passed, including TypeScript checks. All 26 chat browser checks and 12 app smoke checks passed. Coverage includes grouped-message identities and individual deletion, keyboard/IME behavior, privacy disclosure, long drafts, read-acknowledgement focus, search, retry nonces, account changes, and the existing privacy guards.

Visual review covered desktop at 1440px and mobile at 320/375px in both themes. Touch emulation at 320×480 and 375×500 verified that history and the expanding composer fit together, including a 1,000-character draft and accessible touch actions. Browser tests used intercepted fictional accounts and messages; no hosted writes or database migration were performed for this update.
