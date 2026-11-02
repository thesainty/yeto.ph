import { useEffect, useState } from "react";
import { Heart, MessageCircle, RefreshCw, Send, ShieldCheck, Trash2, Users } from "lucide-react";
import { Modal } from "../components/ui";
import { useSocial } from "./SocialProvider";
import { addComment, deleteComment, deletePost, setLike } from "./api";
import type { SocialPost } from "./types";
import PostComposer from "./PostComposer";
import { PersonAvatar, socialDate } from "./SocialUi";
import "./social.css";
import "./compact-feed.css";

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
    <article className="card social-post" id={`activity-post-${post.id}`} tabIndex={-1} aria-label={`Update by ${post.author.display_name}`}>
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
  const { data, userId, busy, refreshing, error, setupRequired, refresh } = useSocial();
  const [message, setMessage] = useState("");

  useEffect(() => { setMessage(""); }, [userId]);

  return (
    <section className="social-screen compact-real-feed" aria-label="Real feed">
      <PostComposer key={userId ?? "anonymous"} onPublished={() => setMessage("Your update was saved.")} />
      <div className="compact-feed-toolbar">
        <h2>Your feed</h2>
        <button type="button" className="icon-button" onClick={() => void refresh()} disabled={refreshing || busy} aria-label="Refresh feed and plans" title="Refresh feed">
          <RefreshCw size={17} className={refreshing ? "social-spinning" : ""} />
        </button>
      </div>
      {error && (
        <div className="social-error" role="alert">
          <ShieldCheck size={19} />
          <div>{setupRequired && <strong>Feed and Plans setup is pending</strong>}<p>{error}</p></div>
        </div>
      )}
      {!data && !error && <div className="card social-empty compact-feed-empty" role="status"><strong>Loading your feed and plans…</strong></div>}
      {message && <p className="social-message" role="status">{message}</p>}
      {data && (
        <div className="social-feed-list">
          {data.posts.length ? data.posts.map((post) => <PostCard post={post} key={post.id} />) : (
            <div className="card social-empty compact-feed-empty">
              <Heart size={24} />
              <h3>Your feed starts here.</h3>
              <p>Share a little update, or <a href="#friends">find your friends</a>.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
