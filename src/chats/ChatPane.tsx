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
  const deleting = messages?.items.find((item) => item.id === deletingId);
  return <section className="direct-chat-pane" aria-label="Direct conversation" aria-busy={fetching}>
    <header className="direct-chat-header">
      <button type="button" className="icon-button direct-back" aria-label="Back to chats" disabled={pending} onClick={onBack}><ArrowLeft size={20} /></button>
      {messages ? <><PersonAvatar person={messages.chat.friend} /><div><h2 ref={heading} tabIndex={-1}>{messages.chat.friend.display_name}</h2><p>@{messages.chat.friend.username}</p></div></> : <div><h2 ref={heading} tabIndex={-1}>Your conversation</h2><p>Private between friends</p></div>}
      <button type="button" className="icon-button direct-refresh" aria-label="Refresh chat" title="Refresh chat" disabled={pending || fetching || paused} onClick={() => void load()}><RefreshCw size={17} className={fetching ? "social-spinning" : ""} /></button>
    </header>
    <p className="direct-chat-privacy"><ShieldCheck size={13} />Private between current friends. Removing or blocking ends this chat.</p>
    {error && <div className="direct-chat-error" role="alert"><p>{error}</p><button type="button" className="button button-soft" disabled={pending || fetching || paused} onClick={() => void load()}>Try loading chat again</button></div>}
    {!messages && !error && <div className="direct-chat-placeholder" role="status"><MessageCircle size={28} /><p>Loading your conversation…</p></div>}
    {messages && <>
      {messages.hasMore && <button type="button" className="direct-earlier" disabled={pending || fetching || paused} onClick={() => void load("earlier")}>Load earlier messages</button>}
      <div className="direct-message-window" ref={history} tabIndex={0} aria-label="Chat history">
        {messages.items.length ? <ol className="direct-messages" aria-label="Direct messages">{messages.items.map((item) => <li key={item.id} className={item.author.id === userId ? "direct-message-own" : ""}><article className="direct-message" aria-label={`Message by ${item.author.display_name}`} id={`direct-message-${item.id}`}>
          <p>{item.body}</p>
          <footer><time dateTime={item.created_at}>{dates.format(new Date(item.created_at))}</time>{item.author.id === userId && <button type="button" className="icon-button" aria-label={`Delete message: ${item.body}`} disabled={pending || paused} onClick={() => { request.current = null; setFetching(false); covered.current = true; setEmojiOpen(false); setNotice(""); setDeletingId(item.id); }}><Trash2 size={13} /></button>}</footer>
        </article></li>)}</ol> : <div className="direct-empty-thread"><PersonAvatar person={messages.chat.friend} /><strong>A little hello starts here.</strong><p>Send a message to {messages.chat.friend.display_name}.</p></div>}
      </div>
      <form className="direct-compose" aria-label="Send a direct message" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor={`direct-compose-${chatId}`}>Message</label>
        <textarea id={`direct-compose-${chatId}`} ref={textarea} value={draft} onChange={(event) => changeDraft(event.target.value)} maxLength={1000} rows={2} placeholder="Send a little hello…" required disabled={pending || paused} />
        <div className="direct-compose-toolbar">
          <div className="direct-emoji"><button ref={emojiButton} type="button" className="icon-button" aria-label="Add emoji" aria-expanded={emojiOpen} disabled={pending || paused} onClick={() => setEmojiOpen(!emojiOpen)}><Smile size={20} /></button>{emojiOpen && <div className="direct-emoji-choices" role="group" aria-label="Choose an emoji" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEmojiOpen(false); emojiButton.current?.focus(); } }}>{emojis.map((emoji) => <button key={emoji.name} type="button" aria-label={emoji.name} onClick={() => { if (draft.length + emoji.value.length <= 1000) changeDraft(draft + emoji.value); setEmojiOpen(false); textarea.current?.focus(); }}>{emoji.value}</button>)}</div>}</div>
          <small>{draft.length}/1000</small>
          <button className="button button-primary" type="submit" disabled={pending || paused || !draft.trim()}><Send size={15} />{working === "sending" ? "Sending…" : "Send message"}</button>
        </div>
      </form>
    </>}
    {notice && <p className="direct-chat-notice" role="status">{notice}</p>}
    {deletingId && <Modal title="Delete this message?" subtitle="This removes your message for both people in this chat." onClose={() => { if (!pending) setDeletingId(null); }}>
      {deleting ? <p className="direct-delete-preview">{deleting.body}</p> : <p className="social-muted">This message is no longer available.</p>}
      <div className="direct-delete-actions"><button type="button" className="button button-soft" disabled={pending} onClick={() => setDeletingId(null)}>Keep message</button><button type="button" className="button button-coral" disabled={pending || !deleting} onClick={() => void confirmDelete()}>{working === "deleting" ? "Deleting…" : "Yes, delete message"}</button></div>
    </Modal>}
  </section>;
}
