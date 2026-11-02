import { useEffect, useState } from "react";
import { Heart, MessageCircle, Plus, Send, Trash2, Users } from "lucide-react";
import { Modal } from "../components/ui";
import { useConnections } from "../account/ConnectionsProvider";
import { useSocial } from "./SocialProvider";
import { addComment, createPost, deleteComment, deletePost, setLike } from "./api";
import type { SocialPost } from "./types";
import RecipientPicker from "./RecipientPicker";
import { PersonAvatar, SocialStatus, socialDate } from "./SocialUi";
import "./social.css";

function readableError(cause: unknown) {
  return cause instanceof Error ? cause.message : "We couldn’t save your change. Please try again.";
}

function PostCard({ post }: { post: SocialPost }) {
  const { userId, run, busy, refreshing } = useSocial();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ type: "post" | "comment"; id: string } | null>(null);
  const disabled = busy || refreshing;

  async function act(action: () => Promise<unknown>, onSuccess?: () => void) {
    setError("");
    try {
      await run(action);
      onSuccess?.();
    } catch (cause) {
      setError(readableError(cause));
    }
  }

  return (
    <article className="card social-post" aria-label={`Update by ${post.author.display_name}`}>
      <div className="social-person">
        <PersonAvatar person={post.author} />
        <div className="social-person-copy">
          <strong>{post.author.display_name}{post.author.id === userId && <span className="social-you">you</span>}</strong>
          <small>@{post.author.username}</small>
        </div>
        {post.author.id === userId && (
          <button className="icon-button social-delete" type="button" aria-label="Delete your update" title="Delete update" disabled={disabled} onClick={() => setConfirmation({ type: "post", id: post.id })}>
            <Trash2 size={17} />
          </button>
        )}
      </div>
      <p className="social-meta"><Users size={13} /> {post.audience_count ? `Shared with ${post.audience_count} selected friend${post.audience_count === 1 ? "" : "s"}` : "Only me"} · {socialDate(post.created_at)}</p>
      <p className="social-post-body">{post.body}</p>
      <div className="social-post-actions">
        <button
          type="button"
          className={`social-reaction ${post.liked_by_me ? "social-liked" : ""}`}
          aria-label={`${post.liked_by_me ? "Unlike" : "Like"} update by ${post.author.display_name}`}
          aria-pressed={post.liked_by_me}
          disabled={disabled}
          onClick={() => void act(() => setLike(post.id, !post.liked_by_me))}
        >
          <Heart size={18} fill={post.liked_by_me ? "currentColor" : "none"} /> {post.like_count}
        </button>
        <button type="button" className="social-reaction" aria-label={`Comments on update by ${post.author.display_name}`} aria-expanded={commentsOpen} onClick={() => setCommentsOpen(!commentsOpen)}>
          <MessageCircle size={18} /> {post.comments.length} comment{post.comments.length === 1 ? "" : "s"}
        </button>
      </div>
      {commentsOpen && (
        <div className="social-comments">
          {post.comments.map((entry) => (
            <div className="social-comment" key={entry.id}>
              <PersonAvatar person={entry.author} />
              <div className="social-comment-copy">
                <strong>{entry.author.display_name}</strong>
                <p>{entry.body}</p>
                <small>{socialDate(entry.created_at)}</small>
              </div>
              {entry.author.id === userId && (
                <button type="button" className="icon-button social-delete" disabled={disabled} aria-label={`Delete your comment: ${entry.body}`} onClick={() => setConfirmation({ type: "comment", id: entry.id })}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
          <form className="social-comment-form" onSubmit={(event) => {
            event.preventDefault();
            if (!comment.trim() || disabled) return;
            void act(() => addComment(post.id, comment.trim()), () => setComment(""));
          }}>
            <label className="sr-only" htmlFor={`comment-${post.id}`}>Comment on update by {post.author.display_name}</label>
            <input id={`comment-${post.id}`} value={comment} onChange={(event) => setComment(event.target.value)} maxLength={240} placeholder="Say something kind…" disabled={disabled} />
            <button type="submit" className="icon-button" aria-label="Send comment" disabled={disabled || !comment.trim()}><Send size={17} /></button>
          </form>
        </div>
      )}
      {error && <p className="social-inline-error" role="alert">{error}</p>}
      {confirmation && (
        <Modal title={confirmation.type === "post" ? "Delete this update?" : "Delete this comment?"} subtitle="This removes it for everyone who could see it." onClose={() => !busy && setConfirmation(null)}>
          <div className="social-confirm">
            <p>{confirmation.type === "post" ? "The update and its reactions and comments will be removed." : "Your comment will be removed."}</p>
            <div className="social-actions">
              <button type="button" className="button button-soft" disabled={busy} onClick={() => setConfirmation(null)}>Keep it</button>
              <button type="button" className="button button-coral" disabled={disabled} onClick={() => {
                const chosen = confirmation;
                void act(() => chosen.type === "post" ? deletePost(chosen.id) : deleteComment(chosen.id), () => setConfirmation(null));
              }}>{busy ? "Deleting…" : confirmation.type === "post" ? "Delete update" : "Delete comment"}</button>
            </div>
          </div>
        </Modal>
      )}
    </article>
  );
}

export default function RealHome() {
  const { data, userId, run, busy, refreshing, error } = useSocial();
  const connections = useConnections();
  const [body, setBody] = useState("");
  const [viewers, setViewers] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const disabled = busy || refreshing || !data || !!error;

  useEffect(() => {
    setBody("");
    setViewers([]);
    setMessage("");
    setFormError("");
  }, [userId]);

  async function publish() {
    if (disabled || !body.trim()) return;
    setMessage("");
    setFormError("");
    const knownFriends = new Set(connections.data?.friends.map((person) => person.id));
    if (viewers.some((id) => !knownFriends.has(id)) || (viewers.length && connections.error)) {
      setFormError("Your selected friends have changed. Refresh your friends list and choose again.");
      return;
    }
    try {
      await run(() => createPost(body.trim(), viewers));
      setBody("");
      setViewers([]);
      setMessage("Your update was saved.");
    } catch (cause) {
      setFormError(readableError(cause));
    }
  }

  return (
    <section className="social-screen" aria-label="Real feed">
      <div className="social-heading">
        <span className="eyebrow">YOUR REAL FEED</span>
        <h2>Stay connected. A little closer.</h2>
        <p>Updates from you and the friends who chose to share with you. Your private audience applies to each post.</p>
      </div>
      <SocialStatus />
      {message && <p className="social-message" role="status">{message}</p>}
      {data && (
        <>
          <form className="card social-form" aria-label="Post a check-in" onSubmit={(event) => { event.preventDefault(); void publish(); }}>
            <div className="social-heading"><h3><Plus size={17} /> A little update for your people</h3></div>
            <label className="social-field">
              Your update
              <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={240} rows={3} placeholder="Home safely, a small win, a little hello…" required disabled={disabled} />
            </label>
            <RecipientPicker selected={viewers} onChange={setViewers} disabled={disabled} />
            {formError && <p className="social-inline-error" role="alert">{formError}</p>}
            <div className="social-actions">
              <small className="social-muted">{body.length}/240 · A text update, never your GPS location.</small>
              <button className="button button-coral" type="submit" disabled={disabled || !body.trim() || (viewers.length > 0 && (connections.refreshing || !!connections.error))}>
                <Send size={15} /> {busy ? "Saving…" : "Publish update"}
              </button>
            </div>
          </form>
          <div className="social-feed-list">
            {data.posts.length ? data.posts.map((post) => <PostCard post={post} key={post.id} />) : (
              <div className="card social-empty">
                <Heart size={26} />
                <h3>Your feed starts with a little hello.</h3>
                <p>Post a private update, or choose specific friends to share it with. Their updates appear here only when they include you.</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
