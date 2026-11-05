import { useEffect, useRef, useState } from "react";
import { Bell, CalendarDays, CheckCheck, ChevronRight, Heart, MessageCircle, RefreshCw, Users } from "lucide-react";
import { Modal } from "../components/ui";
import { useActivityInbox } from "./ActivityInboxProvider";
import type { ActivityItem } from "./api";
import "./activity.css";

interface Props {
  onClose: () => void;
  onOpen: (item: ActivityItem) => void;
  onFriends?: () => void;
}

function activityText(item: ActivityItem) {
  const name = item.actor.display_name || "A TARA member";
  switch (item.kind) {
    case "friend_request": return `${name} sent you a friend request`;
    case "friend_accepted": return `${name} accepted your friend request`;
    case "plan_invite": return `${name} invited you to ${item.plan_title || "a plan"}`;
    case "plan_reminder": return `${item.reminder_minutes === 1440 ? "1-day" : "1-hour"} reminder for ${item.plan_title || "your plan"}`;
    case "poll_invite": return `${name} invited you to find a time for ${item.poll_title || "a get-together"}`;
    case "plan_rsvp": return `${name} ${item.rsvp_going ? "joined" : "left"} ${item.plan_title || "your plan"}`;
    case "post_comment": return `${name} commented on your update`;
    case "post_like": return `${name} liked your update`;
  }
}

function activityIcon(item: ActivityItem) {
  if (item.kind === "friend_request" || item.kind === "friend_accepted") return <Users size={20} />;
  if (item.kind === "post_like") return <Heart size={20} />;
  if (item.kind === "post_comment") return <MessageCircle size={20} />;
  return <CalendarDays size={20} />;
}

function activityDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila",
  }).format(date) + " · Philippines";
}

function InboxContents({ onClose, onOpen, onFriends }: Props) {
  const inbox = useActivityInbox();
  const [localError, setLocalError] = useState("");
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  const owner = useRef(inbox.userId);
  owner.current = inbox.userId;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const disabled = working || inbox.busy || inbox.refreshing;
  const items = inbox.data?.items ?? [];
  const visibleUnread = items.filter((item) => !item.read_at).map((item) => item.id).slice(0, 100);

  async function act(ids: string[], after?: () => void) {
    if (disabled || !inbox.userId) return;
    const actor = inbox.userId;
    const isCurrent = () => mounted.current && owner.current === actor;
    setLocalError("");
    setWorking(true);
    try {
      if (ids.length) await inbox.markRead([...ids]);
      if (isCurrent()) after?.();
    } catch (cause) {
      if (isCurrent()) setLocalError(cause instanceof Error ? cause.message : "We couldn’t update your activity. Please try again.");
    } finally {
      if (isCurrent()) setWorking(false);
    }
  }

  return (
    <Modal title="Activity inbox" subtitle="A little heads-up from your people." onClose={onClose}>
      <div className="activity-inbox">
        <div className="activity-toolbar">
          <p className="activity-count" aria-live="polite">
            {inbox.data ? `${inbox.data.unread_count} unread` : "Your recent activity"}
          </p>
          <button type="button" className="button button-soft" disabled={disabled} onClick={() => { setLocalError(""); void inbox.refresh(); }} aria-label="Refresh activity">
            <RefreshCw size={14} className={inbox.refreshing ? "activity-spinning" : ""} />
            {inbox.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {inbox.error ? (
          <div className="activity-state activity-error" role="alert">
            <strong>{inbox.setupRequired ? "Your activity inbox is coming soon" : "Your activity couldn’t load"}</strong>
            <p>{inbox.setupRequired ? "You can still find requests in Friends, updates in Home, and invitations in Plans." : inbox.error}</p>
            {onFriends && <button type="button" className="button button-soft" onClick={onFriends}>Open friend requests</button>}
          </div>
        ) : !inbox.data ? (
          <div className="activity-state" role="status"><Bell size={25} /><strong>Loading your activity…</strong></div>
        ) : items.length ? (
          <>
            <button type="button" className="activity-mark-read" disabled={disabled || !visibleUnread.length} onClick={() => void act(visibleUnread)}>
              <CheckCheck size={16} /> Mark visible as read
            </button>
            <ul className="activity-list" aria-label="Recent activity">
              {items.map((item) => {
                const text = activityText(item);
                const unread = !item.read_at;
                return (
                  <li key={item.id}>
                    <button type="button" className={`activity-item${unread ? " activity-unread" : ""}`} aria-label={`${unread ? "Unread" : "Read"}: ${text}`} disabled={disabled}
                      onClick={() => void act(unread ? [item.id] : [], () => onOpen(item))}>
                      <span className={`activity-icon activity-icon-${item.kind}`} aria-hidden="true">{activityIcon(item)}</span>
                      <span className="activity-item-copy">
                        <strong>{text}</strong>
                        <small>{item.kind === "plan_reminder" && item.plan_starts_at ? `Plan starts ${activityDate(item.plan_starts_at)}` : `@${item.actor.username} · ${activityDate(item.created_at)}`}</small>
                        <span className="activity-read-state">{unread ? "Unread" : "Read"}</span>
                      </span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {items.length >= 100 && <p className="activity-note">Showing the latest 100 items. Marking visible activity as read leaves other unread activity unchanged.</p>}
          </>
        ) : (
          <div className="activity-state" role="status">
            <span className="activity-empty-icon"><Bell size={25} /></span>
            <strong>You’re all caught up</strong>
            <p>Friend requests, plan invitations and reminders, availability polls, RSVPs, comments, and reactions will appear here.</p>
          </div>
        )}
        {localError && <p className="activity-action-error" role="alert">{localError}</p>}
        <p className="activity-note">Activity stays in your account. Opening this inbox doesn’t mark items as read. No push alerts are enabled.</p>
      </div>
    </Modal>
  );
}

export default function ActivityInbox(props: Props) {
  const { userId } = useActivityInbox();
  return <InboxContents key={userId ?? "anonymous"} {...props} />;
}
