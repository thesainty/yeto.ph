import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, MessageCircle, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import { Modal } from "../components/ui";
import type { SocialPlan } from "../social/types";
import { fetchConversation, deleteMessage, markMessagesRead, sendMessage } from "./api";
import { useConversations } from "./ConversationsProvider";
import type { ConversationCursor, PlanMessage } from "./types";
import "./conversation.css";

interface Props {
  plan: SocialPlan;
  disabled: boolean;
  activityToken?: number;
  onOpened?: () => void;
}

interface Messages {
  items: PlanMessage[];
  hasMore: boolean;
  before: ConversationCursor | null;
}

type ScrollIntent = "bottom" | "keep" | { top: number; height: number };
const dateFormat = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila",
});

function messageDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? dateFormat.format(date) : "Time unavailable";
}

function readable(cause: unknown) {
  return cause instanceof Error ? cause.message : "We couldn’t load this conversation. Please refresh and try again.";
}

function ConversationContents({ plan, disabled, activityToken, onOpened }: Props) {
  const conversations = useConversations();
  const { userId, scope } = conversations;
  const unread = conversations.data?.conversations.find((item) => item.plan_id === plan.id)?.unread_count ?? 0;
  const unreadId = useId();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Messages | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fetching, setFetching] = useState(false);
  const [working, setWorking] = useState<"sending" | "deleting" | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const mounted = useRef(true);
  const owner = useRef(userId);
  owner.current = userId;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const opened = useRef(open);
  opened.current = open;
  const deleteStep = useRef(deletingId);
  deleteStep.current = deletingId;
  const access = useRef(!disabled);
  access.current = !disabled;
  const generation = useRef(0);
  const request = useRef<symbol | null>(null);
  const mutation = useRef<symbol | null>(null);
  const acknowledged = useRef(new Set<string>());
  const pageCount = useRef(1);
  const snapshot = useRef(messages);
  snapshot.current = messages;
  const latestRun = useRef(conversations.run);
  latestRun.current = conversations.run;
  const latestRefresh = useRef(conversations.refresh);
  latestRefresh.current = conversations.refresh;
  const nonce = useRef<{ body: string; id: string } | null>(null);
  const consumedActivity = useRef<number | undefined>(undefined);
  const messageWindow = useRef<HTMLDivElement>(null);
  const scrollIntent = useRef<ScrollIntent>("bottom");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const deleteConfirm = useRef<HTMLButtonElement>(null);
  const previousDeleting = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; request.current = null; mutation.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (!conversations.error) return;
    // A rejected background read cannot validate an older open conversation.
    // Invalidate pending reads before paint without abandoning an active send
    // or delete, which must still finish its ownership checks and unlock.
    request.current = null;
    setMessages(null);
    setDeletingId(null);
    setFetching(false);
    setError(conversations.error);
  }, [conversations.error]);

  useLayoutEffect(() => {
    const area = messageWindow.current;
    if (!area) return;
    const intent = scrollIntent.current;
    if (intent === "bottom") area.scrollTop = area.scrollHeight;
    else if (typeof intent === "object") area.scrollTop = intent.top + area.scrollHeight - intent.height;
    scrollIntent.current = "keep";
  }, [messages]);

  useEffect(() => {
    if (!!deletingId !== previousDeleting.current) {
      if (deletingId) deleteConfirm.current?.focus();
      else textarea.current?.focus();
      previousDeleting.current = !!deletingId;
    }
  }, [deletingId]);

  const load = useCallback(async (mode: "latest" | "earlier" | "poll" = "latest") => {
    if (!mounted.current || !opened.current || !userId || !access.current || request.current || mutation.current) return;
    if (mode === "poll" && (document.visibilityState !== "visible" || deleteStep.current)) return;
    const current = generation.current;
    const token = Symbol("read conversation");
    request.current = token;
    const matches = () => mounted.current && opened.current && owner.current === userId
      && activeScope.current === scope && generation.current === current && request.current === token;
    const area = messageWindow.current;
    const nearBottom = !area || area.scrollHeight - area.scrollTop - area.clientHeight < 65;
    setFetching(true);
    if (mode !== "poll") setError("");
    try {
      let loaded: PlanMessage[];
      let hasMore: boolean;
      let before: ConversationCursor | null;
      if (mode === "earlier" && snapshot.current?.before) {
        const next = await fetchConversation(plan.id, snapshot.current.before);
        if (!matches()) return;
        const known = new Set(next.messages.map((item) => item.id));
        loaded = [...next.messages, ...snapshot.current.items.filter((item) => !known.has(item.id))];
        hasMore = next.has_more;
        before = next.next_before;
        pageCount.current += 1;
        scrollIntent.current = area ? { top: area.scrollTop, height: area.scrollHeight } : "keep";
      } else {
        // Revalidate all pages currently on screen so deleted messages do not
        // remain cached when a person has browsed further back in the history.
        let next = await fetchConversation(plan.id);
        if (!matches()) return;
        loaded = next.messages;
        let pages = 1;
        while (pages < pageCount.current && next.has_more && next.next_before) {
          next = await fetchConversation(plan.id, next.next_before);
          if (!matches()) return;
          const known = new Set(next.messages.map((item) => item.id));
          loaded = [...next.messages, ...loaded.filter((item) => !known.has(item.id))];
          pages += 1;
        }
        hasMore = next.has_more;
        before = next.next_before;
        pageCount.current = pages;
        scrollIntent.current = mode === "latest" || nearBottom ? "bottom" : "keep";
      }
      if (!matches()) return;
      setMessages({ items: loaded, hasMore, before });
      setError("");
      const ids = loaded.filter((item) => item.author.id !== userId && !acknowledged.current.has(item.id)).map((item) => item.id);
      // Read only the exact messages just loaded. A message arriving during this
      // request remains unread until a subsequent visible fetch includes it.
      for (let index = 0; index < ids.length; index += 100) {
        if (!matches() || document.visibilityState !== "visible") return;
        const batch = ids.slice(index, index + 100);
        await latestRun.current(() => markMessagesRead(plan.id, batch));
        if (!matches()) return;
        for (const id of batch) acknowledged.current.add(id);
      }
      if (!ids.length) void latestRefresh.current();
    } catch (cause) {
      if (!matches()) return;
      generation.current += 1;
      request.current = null;
      setMessages(null);
      setDeletingId(null);
      setError(readable(cause));
    } finally {
      if (mounted.current && owner.current === userId && activeScope.current === scope && request.current === token) {
        request.current = null;
        setFetching(false);
      } else if (mounted.current && owner.current === userId && activeScope.current === scope && generation.current === current + 1 && request.current === null) {
        setFetching(false);
      }
    }
  }, [plan.id, userId, scope]);

  const show = useCallback(() => {
    if (disabled || !userId || mutation.current) return;
    generation.current += 1;
    request.current = null;
    acknowledged.current.clear();
    pageCount.current = 1;
    setMessages(null);
    setFetching(false);
    setDeletingId(null);
    setError("");
    setNotice("");
    setOpen(true);
  }, [disabled, userId]);

  function close() {
    if (mutation.current) return;
    generation.current += 1;
    request.current = null;
    opened.current = false;
    setOpen(false);
    setMessages(null);
    setFetching(false);
    setDeletingId(null);
  }

  useEffect(() => {
    if (activityToken === undefined || consumedActivity.current === activityToken || disabled || !userId) return;
    consumedActivity.current = activityToken;
    show();
    onOpened?.();
  }, [activityToken, disabled, userId, show, onOpened]);

  useEffect(() => {
    if (!open) return;
    void load();
    const visible = () => { if (document.visibilityState === "visible") void load("poll"); };
    const interval = window.setInterval(visible, 5_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, load]);

  async function mutate(action: () => Promise<unknown>, success: () => void) {
    if (disabled || !userId || mutation.current || !snapshot.current) return false;
    generation.current += 1;
    request.current = null;
    const current = generation.current;
    const token = Symbol("conversation mutation");
    mutation.current = token;
    const matches = () => mounted.current && opened.current && owner.current === userId
      && activeScope.current === scope && generation.current === current && mutation.current === token;
    setFetching(false);
    setError("");
    setNotice("");
    try {
      await conversations.run(action);
      if (!matches()) return false;
      success();
      return true;
    } catch (cause) {
      if (matches()) {
        setMessages(null);
        setDeletingId(null);
        setError(readable(cause));
      }
      return false;
    } finally {
      if (matches()) { mutation.current = null; setWorking(null); }
    }
  }

  async function send() {
    const body = draft.trim();
    if (!body || body.length > 1000 || working || !messages || disabled || conversations.busy) return;
    if (!nonce.current || nonce.current.body !== body) nonce.current = { body, id: crypto.randomUUID() };
    const id = nonce.current.id;
    setWorking("sending");
    if (await mutate(() => sendMessage(plan.id, body, id), () => {
      setDraft("");
      nonce.current = null;
      setNotice("Message sent.");
    })) await load();
  }

  async function confirmDelete() {
    const item = messages?.items.find((message) => message.id === deletingId);
    if (!item || item.author.id !== userId || working || disabled || conversations.busy) return;
    setWorking("deleting");
    if (await mutate(() => deleteMessage(item.id), () => {
      setDeletingId(null);
      setNotice("Your message was deleted.");
    })) await load();
  }

  const deleting = messages?.items.find((item) => item.id === deletingId);
  const pending = working !== null || conversations.busy;
  return <>
    <div className="plan-conversation-entry">
      <button type="button" className="conversation-open" aria-label={`Open conversation for ${plan.title}`} aria-describedby={unreadId} disabled={disabled || pending} onClick={show}>
        <MessageCircle size={16} />Conversation{unread > 0 && <span className="conversation-unread" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
      </button>
      <span id={unreadId} className="sr-only">{unread} unread message{unread === 1 ? "" : "s"}</span>
    </div>
    {open && <div className="conversation-layer" onKeyDownCapture={(event) => {
      if (event.key === "Escape" && deletingId) {
        event.preventDefault(); event.stopPropagation();
        if (!pending) setDeletingId(null);
      }
    }}>
      <Modal title="Conversation" onClose={close}>
        <div className="plan-conversation">
          <div className="conversation-plan"><h3>{plan.title}</h3><p><ShieldCheck size={14} />{plan.invitees.length ? "Private to this plan’s selected people." : "Only you can see this private plan’s conversation."}</p></div>
          {deletingId ? <div className="conversation-delete-step">
            <button type="button" className="conversation-back" disabled={pending} onClick={() => setDeletingId(null)}><ArrowLeft size={16} />Back to conversation</button>
            <h3>Delete this message?</h3><p className="social-muted">This removes your message for everyone in this conversation.</p>
            {deleting ? <p className="conversation-delete-preview">{deleting.body}</p> : <p className="social-muted">This message is no longer available.</p>}
            <div className="conversation-actions"><button type="button" className="button button-soft" disabled={pending} onClick={() => setDeletingId(null)}>Keep message</button><button ref={deleteConfirm} type="button" className="button button-coral" disabled={pending || !deleting} onClick={() => void confirmDelete()}>{working === "deleting" ? "Deleting…" : "Yes, delete message"}</button></div>
          </div> : <>
            <div className="conversation-toolbar"><p className="social-muted">Opening this conversation marks the loaded messages as read.</p><button type="button" className="icon-button" aria-label="Refresh conversation" title="Refresh conversation" disabled={disabled || pending || fetching} onClick={() => void load()}><RefreshCw size={16} className={fetching ? "social-spinning" : ""} /></button></div>
            {error && <div className="conversation-error" role="alert"><p>{error}</p><button type="button" className="button button-soft" disabled={disabled || pending || fetching} onClick={() => void load()}>Try loading conversation again</button></div>}
            {!messages && !error && <p className="social-muted" role="status">Loading conversation…</p>}
            {messages && <>
              {messages.hasMore && <button type="button" className="conversation-earlier" disabled={disabled || pending || fetching} onClick={() => void load("earlier")}>Load earlier messages</button>}
              <div className="conversation-message-window" ref={messageWindow} tabIndex={0} aria-label="Conversation history">
                {messages.items.length ? <ol className="conversation-messages" aria-label="Plan messages">{messages.items.map((item) => <li key={item.id}><article className={`conversation-message${item.author.id === userId ? " conversation-message-own" : ""}`} aria-label={`Message by ${item.author.display_name}`} id={`plan-message-${item.id}`}>
                  <div className="conversation-message-heading"><strong>{item.author.id === userId ? "You" : item.author.display_name}</strong><time dateTime={item.created_at}>{messageDate(item.created_at)}</time>{item.author.id === userId && <button type="button" className="icon-button" aria-label={`Delete message: ${item.body}`} disabled={disabled || pending} onClick={() => {
                    request.current = null;
                    setFetching(false);
                    deleteStep.current = item.id;
                    setNotice("");
                    setDeletingId(item.id);
                  }}><Trash2 size={14} /></button>}</div>
                  <p>{item.body}</p>
                </article></li>)}</ol> : <p className="conversation-empty">A little hello starts here.</p>}
              </div>
              <form className="conversation-compose" aria-label="Send a plan message" onSubmit={(event) => { event.preventDefault(); void send(); }}>
                <label className="social-field">Message<textarea ref={textarea} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1000} rows={3} placeholder="A quick hello or a little plan detail…" disabled={disabled || pending} required /></label>
                <div className="conversation-actions"><small className="social-muted">{draft.length}/1000</small><button type="submit" className="button button-primary" disabled={disabled || pending || !draft.trim()}><Send size={15} />{working === "sending" ? "Sending…" : "Send message"}</button></div>
              </form>
            </>}
          </>}
          {notice && <p className="social-message" role="status">{notice}</p>}
        </div>
      </Modal>
    </div>}
  </>;
}

/** Private contents and pending work belong to one account and relationship scope. */
export default function PlanConversation(props: Props) {
  const { userId, scope } = useConversations();
  return <ConversationContents key={`${userId ?? "anonymous"}:${scope}:${props.plan.id}`} {...props} />;
}
