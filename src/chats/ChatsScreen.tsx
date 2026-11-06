import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageCircle, Plus, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useConnections } from "../account/ConnectionsProvider";
import { Modal } from "../components/ui";
import { PersonAvatar } from "../social/SocialUi";
import { openDirectChat } from "./api";
import { useDirectChats } from "./DirectChatsProvider";
import ChatPane from "./ChatPane";
import type { ChatDraft } from "./ChatPane";
import "./chats.css";

interface Props {
  onSignIn: () => void;
  active?: boolean;
  directActivity?: { chatId: string; token: number } | null;
  onActivityOpened?: () => void;
}

function ChatsContents({ directActivity, onActivityOpened, active = true }: Omit<Props, "onSignIn">) {
  const chats = useDirectChats();
  const connections = useConnections();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [friendSearch, setFriendSearch] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const owner = useRef(chats.userId);
  owner.current = chats.userId;
  const scope = useRef(chats.scope);
  scope.current = chats.scope;
  const consumed = useRef<number | undefined>(undefined);
  const drafts = useRef(new Map<string, ChatDraft>());
  const selectedButton = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!directActivity || consumed.current === directActivity.token) return;
    consumed.current = directActivity.token;
    setCreating(false);
    setSelectedId(directActivity.chatId);
    onActivityOpened?.();
  }, [directActivity, onActivityOpened]);

  const searchText = search.trim().toLocaleLowerCase();
  const records = chats.data?.chats ?? [];
  const filtered = records.filter((chat) => `${chat.friend.display_name} ${chat.friend.username}`.toLocaleLowerCase().includes(searchText));
  const friendText = friendSearch.trim().toLocaleLowerCase();
  const friends = (connections.data?.friends ?? []).filter((friend) => `${friend.display_name} ${friend.username}`.toLocaleLowerCase().includes(friendText));
  const busy = opening || chats.busy;

  function draftFor(id: string) {
    let saved = drafts.current.get(id);
    if (!saved) { saved = { body: "", nonce: null }; drafts.current.set(id, saved); }
    return saved;
  }

  async function start(friendId: string) {
    if (busy || connections.refreshing || connections.error || !connections.data || !chats.userId) return;
    const actor = chats.userId;
    const originalScope = chats.scope;
    const current = () => mounted.current && owner.current === actor && scope.current === originalScope;
    setOpening(true);
    setError("");
    let id: string | null = null;
    try {
      await chats.run(async () => { id = await openDirectChat(friendId); });
      if (!current() || !id) return;
      setCreating(false);
      setFriendSearch("");
      setSelectedId(id);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "We couldn’t open this chat. Please try again.");
    } finally {
      if (current()) setOpening(false);
    }
  }

  function back() {
    setSelectedId(null);
    window.setTimeout(() => selectedButton.current?.focus(), 0);
  }

  return <section className={`chats-screen${selectedId ? " chats-has-selection" : ""}`} aria-label="Chats">
    <div className="chats-layout">
      <aside className="chats-sidebar" aria-label="Your chats">
        <header className="chats-list-heading"><div><span className="eyebrow">A LITTLE HELLO</span><h1>Chats</h1></div><div><button type="button" className="icon-button" aria-label="Refresh chats" disabled={busy || chats.refreshing} onClick={() => void chats.refresh()}><RefreshCw size={17} className={chats.refreshing ? "social-spinning" : ""} /></button><button type="button" className="icon-button chats-new" aria-label="New chat" title="New chat" disabled={busy} onClick={() => { setError(""); setFriendSearch(""); setCreating(true); }}><Plus size={20} /></button></div></header>
        <label className="chats-search"><Search size={16} /><span className="sr-only">Search chats</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats" /></label>
        {chats.error && <div className="chats-list-error" role="alert"><p>{chats.error}</p><button type="button" disabled={busy || chats.refreshing} onClick={() => void chats.refresh()}>Try refreshing chats</button></div>}
        {!chats.data && !chats.error && <p className="chats-list-state" role="status">Loading your chats…</p>}
        {chats.data && !chats.error && (filtered.length ? <ul className="chats-list" aria-label="Recent chats">{filtered.map((chat) => <li key={chat.id}><button ref={(node) => { if (selectedId === chat.id) selectedButton.current = node; }} type="button" className={`chat-list-item${selectedId === chat.id ? " chat-list-selected" : ""}`} aria-label={`Open chat with ${chat.friend.display_name}`} aria-current={selectedId === chat.id ? "true" : undefined} aria-describedby={`chat-unread-${chat.id}`} disabled={busy} onClick={() => { setSelectedId(chat.id); setError(""); }}>
          <PersonAvatar person={chat.friend} /><span className="chat-list-copy"><strong>{chat.friend.display_name}</strong><small>{chat.last_message ? `${chat.last_message.from_me ? "You: " : ""}${chat.last_message.body}` : "Say a little hello"}</small></span>{chat.unread_count > 0 && <span className="chat-list-unread" aria-hidden="true">{chat.unread_count > 99 ? "99+" : chat.unread_count}</span>}<span id={`chat-unread-${chat.id}`} className="sr-only">{chat.unread_count} unread message{chat.unread_count === 1 ? "" : "s"}</span>
        </button></li>)}</ul> : <div className="chats-list-empty"><MessageCircle size={24} /><strong>{searchText ? "No chats found" : "Your people are a hello away"}</strong><p>{searchText ? "Try your friend’s name or username." : "Start a private conversation with a current friend."}</p>{!searchText && <button type="button" className="button button-soft" onClick={() => { setError(""); setCreating(true); }}>Start a chat</button>}</div>)}
        <p className="chats-list-note"><ShieldCheck size={13} />Only current friends can message each other.</p>
      </aside>
      {selectedId ? <ChatPane key={`${chats.userId}:${chats.scope}:${selectedId}`} chatId={selectedId} paused={creating || !active} initialDraft={draftFor(selectedId)} onDraft={(saved) => drafts.current.set(selectedId, saved)} onBack={back} /> : <div className="chats-welcome"><span><MessageCircle size={34} /></span><h2>A little closer, one hello at a time.</h2><p>Choose a chat or start a conversation with a friend.</p><button type="button" className="button button-primary" disabled={busy} onClick={() => { setError(""); setFriendSearch(""); setCreating(true); }}><Plus size={16} />Choose a friend</button></div>}
    </div>
    {creating && <Modal title="New chat" subtitle="Choose a current friend. Opening a chat doesn’t send a message." onClose={() => { if (!busy) setCreating(false); }}>
      <div className="new-direct-chat">
        <label className="chats-search"><Search size={16} /><span className="sr-only">Search friends to message</span><input type="search" value={friendSearch} onChange={(event) => setFriendSearch(event.target.value)} placeholder="Name or username" disabled={busy} /></label>
        {connections.error ? <div className="chats-list-error" role="alert"><p>{connections.error}</p><button type="button" className="button button-soft" disabled={connections.refreshing} onClick={() => void connections.refresh()}>Refresh friends</button></div> : !connections.data ? <p className="social-muted" role="status">Loading your friends…</p> : friends.length ? <ul className="new-direct-friends" aria-label="Friends you can message">{friends.map((friend) => <li key={friend.id}><button type="button" aria-label={`Chat with ${friend.display_name}`} disabled={busy || connections.refreshing} onClick={() => void start(friend.id)}><PersonAvatar person={friend} /><span><strong>{friend.display_name}</strong><small>@{friend.username}</small></span><MessageCircle size={17} /></button></li>)}</ul> : <div className="chats-list-empty"><strong>{friendText ? "No matching friends" : "A chat starts with a friendship"}</strong><p>{friendText ? "Try another name or username." : "Accept a friend request in Friends, then come back to say hello."}</p>{!friendText && <a href="#friends" onClick={() => setCreating(false)}>Open Friends</a>}</div>}
        {error && <p className="chats-list-error" role="alert">{error}</p>}
        <p className="chats-list-note"><ShieldCheck size={13} />Private between current friends. Removing or blocking ends this chat.</p>
      </div>
    </Modal>}
  </section>;
}

export default function ChatsScreen(props: Props) {
  const { userId, scope } = useDirectChats();
  if (!userId) return <section className="card chats-sign-in" aria-label="Chats"><span><MessageCircle size={33} /></span><h1>A little hello, just for your people.</h1><p>Sign in to chat privately with your current friends.</p><button type="button" className="button button-primary" onClick={props.onSignIn}>Sign in to chat</button></section>;
  return <ChatsContents key={`${userId}:${scope}`} directActivity={props.directActivity} onActivityOpened={props.onActivityOpened} active={props.active} />;
}
