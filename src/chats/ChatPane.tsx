import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, MessageCircle, RefreshCw, Send, ShieldCheck, Smile, Trash2 } from "lucide-react";
import { Modal } from "../components/ui";
import { PersonAvatar } from "../social/SocialUi";
import { deleteDirectMessage, fetchDirectChat, markDirectMessagesRead, sendDirectMessage } from "./api";
import { useDirectChats } from "./DirectChatsProvider";
import type { DirectChatSnapshot, DirectMessage, MessageCursor } from "./types";

export interface ChatDraft {
  body: string;
  nonce: { body: string; id: string } | null;
}
interface Props {
  chatId: string;
  paused: boolean;
  initialDraft: ChatDraft;
  onDraft: (draft: ChatDraft) => void;
  onBack: () => void;
}
interface Messages {
  chat: DirectChatSnapshot["chat"];
  items: DirectMessage[];
  hasMore: boolean;
  before: MessageCursor | null;
}
type ScrollIntent = "bottom" | "keep" | { top: number; height: number };
const dates = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" });
const times = new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const days = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Manila" });
const dayLabels = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });
const dayKey = (value: string | number) => days.format(new Date(value));
function dayLabel(value: string) {
  const key = dayKey(value);
  if (key === dayKey(Date.now())) return "Today";
  if (key === dayKey(Date.now() - 86_400_000)) return "Yesterday";
  return dayLabels.format(new Date(value));
}
function sameGroup(first: DirectMessage | undefined, second: DirectMessage | undefined) {
  return !!first && !!second && first.author.id === second.author.id
    && dayKey(first.created_at) === dayKey(second.created_at)
    && Math.abs(Date.parse(second.created_at) - Date.parse(first.created_at)) < 5 * 60_000;
}
const emojis = [{ value: "👋", name: "Wave" }, { value: "😊", name: "Smile" }, { value: "❤️", name: "Heart" }];
const readable = (cause: unknown) => cause instanceof Error ? cause.message : "We couldn’t load this chat. Please refresh and try again.";

export default function ChatPane({ chatId, paused, initialDraft, onDraft, onBack }: Props) {
  const chats = useDirectChats();
  const { userId, scope } = chats;
  const [messages, setMessages] = useState<Messages | null>(null);
  const [draft, setDraft] = useState(initialDraft.body);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fetching, setFetching] = useState(false);
  const [working, setWorking] = useState<"sending" | "deleting" | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const mounted = useRef(true);
  const owner = useRef(userId);
  owner.current = userId;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const covered = useRef(paused || !!deletingId);
  covered.current = paused || !!deletingId;
  const generation = useRef(0);
  const request = useRef<symbol | null>(null);
  const mutation = useRef<symbol | null>(null);
  const acknowledged = useRef(new Set<string>());
  const pageCount = useRef(1);
  const snapshot = useRef(messages);
  snapshot.current = messages;
  const latestRun = useRef(chats.run);
  latestRun.current = chats.run;
  const latestRefresh = useRef(chats.refresh);
  latestRefresh.current = chats.refresh;
  const remember = useRef(onDraft);
  remember.current = onDraft;
  const nonce = useRef(initialDraft.nonce);
  const history = useRef<HTMLDivElement>(null);
  const scrollIntent = useRef<ScrollIntent>("bottom");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const previousDeleting = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; request.current = null; mutation.current = null; };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }, [draft, messages !== null]);

  useLayoutEffect(() => {
    if (!paused && !deletingId) return;
    request.current = null;
    setFetching(false);
  }, [paused, deletingId]);
  useLayoutEffect(() => {
    if (!chats.error) return;
    // Invalidate only reads. A confirmed send must still unlock after a failed
    // unread-summary refresh, and the next fresh authorized read may recover.
    request.current = null;
    setMessages(null);
    setDeletingId(null);
    setFetching(false);
    setError(chats.error);
  }, [chats.error]);
  useLayoutEffect(() => {
    const area = history.current;
    if (!area) return;
    const intent = scrollIntent.current;
    if (intent === "bottom") area.scrollTop = area.scrollHeight;
    else if (typeof intent === "object") area.scrollTop = intent.top + area.scrollHeight - intent.height;
    scrollIntent.current = "keep";
  }, [messages]);
  useEffect(() => {
    const wasDeleting = previousDeleting.current;
    previousDeleting.current = !!deletingId;
    if (!wasDeleting || deletingId) return;
    const timer = window.setTimeout(() => textarea.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [deletingId]);

  const load = useCallback(async (mode: "latest" | "earlier" | "poll" = "latest") => {
    if (!mounted.current || !userId || covered.current || request.current || mutation.current) return;
    if (document.visibilityState !== "visible") return;
    const current = generation.current;
    const token = Symbol("read direct chat");
    request.current = token;
    const matches = () => mounted.current && owner.current === userId && activeScope.current === scope
      && generation.current === current && request.current === token && !covered.current;
    const area = history.current;
    const nearBottom = !area || area.scrollHeight - area.scrollTop - area.clientHeight < 65;
    setFetching(true);
    if (mode !== "poll") setError("");
    try {
      let loaded: DirectMessage[];
      let next: DirectChatSnapshot;
      if (mode === "earlier" && snapshot.current?.before) {
        next = await fetchDirectChat(chatId, snapshot.current.before);
        if (!matches()) return;
        const known = new Set(next.messages.map((item) => item.id));
        loaded = [...next.messages, ...snapshot.current.items.filter((item) => !known.has(item.id))];
        pageCount.current += 1;
        scrollIntent.current = area ? { top: area.scrollTop, height: area.scrollHeight } : "keep";
      } else {
        next = await fetchDirectChat(chatId);
        if (!matches()) return;
        loaded = next.messages;
        let pages = 1;
        // Refresh every loaded page so an older deleted message is not retained.
        while (pages < pageCount.current && next.has_more && next.next_before) {
          next = await fetchDirectChat(chatId, next.next_before);
          if (!matches()) return;
          const known = new Set(next.messages.map((item) => item.id));
          loaded = [...next.messages, ...loaded.filter((item) => !known.has(item.id))];
          pages += 1;
        }
        pageCount.current = pages;
        scrollIntent.current = mode === "latest" || nearBottom ? "bottom" : "keep";
      }
      if (!matches()) return;
      setMessages({ chat: next.chat, items: loaded, hasMore: next.has_more, before: next.next_before });
      setError("");
      const ids = loaded.filter((item) => item.author.id !== userId && !acknowledged.current.has(item.id)).map((item) => item.id);
      for (let index = 0; index < ids.length; index += 100) {
        if (!matches() || document.visibilityState !== "visible") return;
        const batch = ids.slice(index, index + 100);
        await latestRun.current(() => markDirectMessagesRead(chatId, batch));
        if (!matches()) return;
        for (const id of batch) acknowledged.current.add(id);
      }
      if (!ids.length) void latestRefresh.current();
    } catch (cause) {
      if (!matches()) return;
      request.current = null;
      setMessages(null);
      setDeletingId(null);
      setError(readable(cause));
    } finally {
      if (mounted.current && owner.current === userId && activeScope.current === scope && request.current === token) {
        request.current = null;
        setFetching(false);
      } else if (mounted.current && owner.current === userId && activeScope.current === scope && request.current === null) setFetching(false);
    }
  }, [chatId, userId, scope]);

  useEffect(() => {
    if (paused || deletingId) return;
    void load(snapshot.current ? "poll" : "latest");
    const visible = () => { if (document.visibilityState === "visible") void load("poll"); };
    const interval = window.setInterval(visible, 5_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load, paused, deletingId]);

  async function mutate(action: () => Promise<unknown>, success: () => void) {
    if (!userId || mutation.current || !snapshot.current) return false;
    generation.current += 1;
    request.current = null;
    const current = generation.current;
    const token = Symbol("direct message mutation");
    mutation.current = token;
    const matches = () => mounted.current && owner.current === userId && activeScope.current === scope
      && generation.current === current && mutation.current === token;
    setFetching(false);
    setError("");
    setNotice("");
    try {
      await chats.run(action);
      if (!matches()) return false;
      success();
      return true;
    } catch (cause) {
      if (matches()) { setMessages(null); setDeletingId(null); setError(readable(cause)); }
      return false;
    } finally {
      if (matches()) { mutation.current = null; setWorking(null); }
    }
  }

  function changeDraft(value: string) {
    if (nonce.current && nonce.current.body !== value.trim()) nonce.current = null;
    setDraft(value);
    remember.current({ body: value, nonce: nonce.current });
  }
  async function send() {
    const body = draft.trim();
    if (!body || body.length > 1000 || working || chats.busy || !messages || covered.current) return;
    if (!nonce.current || nonce.current.body !== body) nonce.current = { body, id: crypto.randomUUID() };
    remember.current({ body: draft, nonce: nonce.current });
    const id = nonce.current.id;
    setEmojiOpen(false);
    setWorking("sending");
    if (await mutate(() => sendDirectMessage(chatId, body, id), () => {
      nonce.current = null;
      setDraft("");
      remember.current({ body: "", nonce: null });
      setNotice("Message sent.");
    })) await load();
  }
  async function confirmDelete() {
    const item = messages?.items.find((message) => message.id === deletingId);
    if (!item || item.author.id !== userId || working || chats.busy) return;
    setWorking("deleting");
    if (await mutate(() => deleteDirectMessage(item.id), () => {
      setDeletingId(null);
      covered.current = paused;
      setNotice("Your message was deleted.");
    })) await load();
  }

  const pending = working !== null || chats.busy;
  const draftLocked = working !== null || paused;
  const deleting = messages?.items.find((item) => item.id === deletingId);
  return <section className="direct-chat-pane" aria-label="Direct conversation" aria-busy={fetching}>
    <header className="direct-chat-header">
      <button type="button" className="icon-button direct-back" aria-label="Back to chats" disabled={pending} onClick={onBack}><ArrowLeft size={20} /></button>
      {messages ? <><PersonAvatar person={messages.chat.friend} /><div><h2 ref={heading} tabIndex={-1}>{messages.chat.friend.display_name}</h2><p>@{messages.chat.friend.username}<span className="direct-header-dot" aria-hidden="true">·</span><span className="direct-header-private">Friends only</span></p></div></> : <div><h2 ref={heading} tabIndex={-1}>Your conversation</h2><p>Private between friends</p></div>}
      <button type="button" className="icon-button direct-refresh" aria-label="Refresh chat" title="Refresh chat" disabled={pending || fetching || paused} onClick={() => void load()}><RefreshCw size={17} className={fetching ? "social-spinning" : ""} /></button>
      <button type="button" className="icon-button direct-privacy-toggle" aria-label="Chat privacy" title="Chat privacy" aria-expanded={privacyOpen} aria-controls={`direct-privacy-${chatId}`} disabled={paused} onClick={() => setPrivacyOpen(!privacyOpen)}><ShieldCheck size={17} /></button>
    </header>
    {privacyOpen && <p id={`direct-privacy-${chatId}`} className="direct-chat-privacy"><ShieldCheck size={15} /><span>Private between current friends. Removing or blocking permanently deletes this chat for both people. Re-friending starts a new chat.</span></p>}
    {error && <div className="direct-chat-error" role="alert"><p>{error}</p><button type="button" className="button button-soft" disabled={pending || fetching || paused} onClick={() => void load()}>Try loading chat again</button></div>}
    {!messages && !error && <div className="direct-chat-placeholder" role="status"><MessageCircle size={28} /><p>Loading your conversation…</p></div>}
    {messages && <>
      {messages.hasMore && <button type="button" className="direct-earlier" disabled={pending || fetching || paused} onClick={() => void load("earlier")}>Load earlier messages</button>}
      <div className="direct-message-window" ref={history} tabIndex={0} aria-label="Chat history">
        {messages.items.length ? <ol className="direct-messages" aria-label="Direct messages">{messages.items.map((item, index) => {
          const previous = messages.items[index - 1];
          const grouped = sameGroup(previous, item);
          const groupEnd = !sameGroup(item, messages.items[index + 1]);
          const newDay = !previous || dayKey(previous.created_at) !== dayKey(item.created_at);
          const own = item.author.id === userId;
          return <li key={item.id} className={`${own ? "direct-message-own" : ""}${grouped ? " direct-message-grouped" : ""}${newDay ? " direct-message-day" : ""}`}>
            {newDay && <div className="direct-day-separator"><span>{dayLabel(item.created_at)}</span></div>}
            <div className="direct-message-row"><article className="direct-message" aria-label={`Message by ${item.author.display_name}`} id={`direct-message-${item.id}`}>
              <p>{item.body}</p>
              <footer className={groupEnd ? undefined : "sr-only"}><time dateTime={item.created_at} title={dates.format(new Date(item.created_at))}>{groupEnd ? times.format(new Date(item.created_at)) : dates.format(new Date(item.created_at))}</time></footer>
            </article>{own && <button type="button" className="icon-button direct-message-action" aria-label={`Delete message: ${item.body}`} title="Delete message" disabled={pending || paused} onClick={() => { request.current = null; setFetching(false); covered.current = true; setEmojiOpen(false); setNotice(""); setDeletingId(item.id); }}><Trash2 size={14} /></button>}</div>
          </li>;
        })}</ol> : <div className="direct-empty-thread"><PersonAvatar person={messages.chat.friend} /><strong>A little hello starts here.</strong><p>Send a message to {messages.chat.friend.display_name}.</p></div>}
      </div>
      <form className="direct-compose" aria-label="Send a direct message" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor={`direct-compose-${chatId}`}>Message</label>
        <div className="direct-compose-bar">
          <div className="direct-emoji"><button ref={emojiButton} type="button" className="icon-button" aria-label="Add emoji" aria-expanded={emojiOpen} disabled={draftLocked} onClick={() => setEmojiOpen(!emojiOpen)}><Smile size={20} /></button>{emojiOpen && <div className="direct-emoji-choices" role="group" aria-label="Choose an emoji" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEmojiOpen(false); emojiButton.current?.focus(); } }}>{emojis.map((emoji) => <button key={emoji.name} type="button" aria-label={emoji.name} disabled={draftLocked} onClick={() => { if (draft.length + emoji.value.length <= 1000) changeDraft(draft + emoji.value); setEmojiOpen(false); textarea.current?.focus(); }}>{emoji.value}</button>)}</div>}</div>
          <textarea id={`direct-compose-${chatId}`} ref={textarea} value={draft} onChange={(event) => changeDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
              event.preventDefault();
              void send();
            }
          }} maxLength={1000} rows={1} placeholder="A little hello…" aria-describedby={draft.length >= 900 ? `direct-count-${chatId}` : undefined} required disabled={draftLocked} />
          <button className="direct-send" type="submit" aria-label="Send message" title={working === "sending" ? "Sending…" : "Send message"} disabled={pending || paused || !draft.trim()}>{working === "sending" ? <RefreshCw size={18} className="social-spinning" /> : <Send size={18} />}</button>
        </div>
        <div className="direct-compose-meta"><span>Enter to send <i aria-hidden="true">·</i> Shift + Enter for a new line</span>{draft.length >= 900 && <small id={`direct-count-${chatId}`}>{draft.length}/1000</small>}</div>
      </form>
    </>}
    {notice && <p className="direct-chat-notice" role="status">{notice}</p>}
    {deletingId && <Modal title="Delete this message?" subtitle="This removes your message for both people in this chat." onClose={() => { if (!pending) setDeletingId(null); }}>
      {deleting ? <p className="direct-delete-preview">{deleting.body}</p> : <p className="social-muted">This message is no longer available.</p>}
      <div className="direct-delete-actions"><button type="button" className="button button-soft" disabled={pending} onClick={() => setDeletingId(null)}>Keep message</button><button type="button" className="button button-coral" disabled={pending || !deleting} onClick={() => void confirmDelete()}>{working === "deleting" ? "Deleting…" : "Yes, delete message"}</button></div>
    </Modal>}
  </section>;
}
