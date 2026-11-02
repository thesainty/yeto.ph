import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Heart,
  House,
  MapPin,
  MessageCircle,
  Navigation,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { Avatar, AvatarStack } from "../components/ui";
import { useIdentity } from "../account/useIdentity";
import type { CheckIn, Plan, Sharing, Tab } from "../types";
import "./home.css";

interface Props {
  plans: Plan[];
  liked: boolean;
  comments: string[];
  sharing: Sharing | null;
  checkIns: CheckIn[];
  onJoin: (id: string) => void;
  onLike: () => void;
  onShare: () => void;
  onCheckIn: () => void;
  onComment: (message: string) => void;
  onNavigate: (tab: Tab) => void;
}


function CoffeeIllustration() {
  return (
    <svg
      className="coffee-art"
      viewBox="0 0 190 170"
      fill="none"
      role="img"
      aria-label="An illustrated latte on a café table"
    >
      <rect width="190" height="170" rx="19" fill="#D6B48D" />
      <path
        d="M0 25h190M0 100h190M50 0v170m100-170v170"
        stroke="#C5A27C"
        opacity=".5"
      />
      <path d="m0 159 190-44v55H0Z" fill="#A38C66" opacity=".23" />
      <rect
        x="115"
        y="21"
        width="60"
        height="84"
        rx="3"
        transform="rotate(13 115 21)"
        fill="#F8EBD2"
      />
      <path
        d="m124 38 31 7m-33 3 30 7m-33 3 21 5"
        stroke="#DFC9A6"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <ellipse cx="91" cy="99" rx="56" ry="45" fill="#A58460" opacity=".3" />
      <ellipse cx="84" cy="90" rx="53" ry="44" fill="#FFF7E4" />
      <ellipse cx="84" cy="91" rx="43" ry="35" fill="#E1D0AD" />
      <path
        d="M117 67c29-4 30 31 8 33l-6-9c12 0 14-16 0-14l-2-10Z"
        fill="#FFFCF3"
      />
      <ellipse cx="82" cy="83" rx="37" ry="31" fill="#FFFDF5" />
      <ellipse cx="82" cy="82" rx="30" ry="25" fill="#AD6F3E" />
      <ellipse cx="82" cy="81" rx="27" ry="22" fill="#BD844F" />
      <path
        d="M84 101c-2-9-19-8-21-18 5-1 11 1 16 5-9-8-12-12-11-18 7 2 11 8 15 17-5-13-6-19-2-24 5 5 5 11 4 23 2-9 7-15 12-15 0 7-5 13-11 20 5-4 10-5 14-4-3 6-10 7-16 14Z"
        fill="#FCE9C2"
      />
      <path
        d="M82 99c2-8 2-18 0-29"
        stroke="#FFF4D6"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M22 136c6-5 17-5 22 0m-17-6 8-17m-3 21-13-9"
        stroke="#6B8553"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <ellipse
        cx="36"
        cy="116"
        rx="4"
        ry="9"
        transform="rotate(25 36 116)"
        fill="#7C955D"
      />
      <ellipse
        cx="24"
        cy="124"
        rx="4"
        ry="9"
        transform="rotate(-49 24 124)"
        fill="#7C955D"
      />
      <path
        d="m132 140 34-14"
        stroke="#8D765D"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="m132 138 34-14"
        stroke="#E8DDCB"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Home({
  plans,
  liked,
  comments,
  sharing,
  checkIns,
  onJoin,
  onLike,
  onShare,
  onCheckIn,
  onComment,
  onNavigate,
}: Props) {
  const identity = useIdentity();
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState("");
  const [filter, setFilter] = useState<"all" | "check-ins">("all");
  const coffeePlan = plans.find((plan) => plan.id === "coffee-bgc") ?? plans[0];

  return (
    <div className="home-screen home-screen-compact">
      <section className="card demo-composer" aria-label="Share a demo update">
        <Avatar id="mika" size={36} />
        <button type="button" className="demo-compose-trigger" aria-label="Post a check-in" onClick={onCheckIn}>Share a little update…</button>
        <button type="button" className="icon-button demo-journey-trigger" aria-label="Share a journey" title="Share a demo journey" onClick={onShare}><Navigation size={20} /></button>
      </section>

      {sharing && <button
        className={`journey-status ${sharing ? "journey-status-active" : ""}`}
        onClick={() => (sharing ? onNavigate("map") : onShare)}
      >
        <span className="journey-status-icon">
          <Navigation size={17} fill="currentColor" />
        </span>
        <span>
          <strong>
            {sharing
              ? `Sharing with ${sharing.audience}`
              : "Your location is just yours"}
          </strong>
          <small>
            {sharing
              ? sharing.durationMinutes === null
                ? "Ongoing demo session · you’re in control"
                : "Demo journey active · you’re in control"
              : "Sharing is off. Turn it on when you choose."}
          </small>
        </span>
        <ChevronRight size={18} />
      </button>}

      <div className="home-feed-heading">
        <div>
          <h2>Latest updates</h2>
        </div>
      </div>
      <div className="home-feed-filters" aria-label="Feed filter">
        <button
          className={filter === "all" ? "selected" : ""}
          onClick={() => setFilter("all")}
          aria-pressed={filter === "all"}
        >
          Your circle
        </button>
        <button
          className={filter === "check-ins" ? "selected" : ""}
          onClick={() => setFilter("check-ins")}
          aria-pressed={filter === "check-ins"}
        >
          Check-ins
        </button>
        <span>
          <span /> All caught up with your people
        </span>
      </div>

      <div className="home-feed">
        {checkIns.map((checkIn) => (
          <article
            key={checkIn.id}
            className="card feed-card feed-new-check-in"
          >
            <div className="feed-author">
              <Avatar id="mika" size={43} />
              <div>
                <strong>
                  {identity.firstName} <span className="feed-you">you</span>
                </strong>
                <small>
                  <Users size={11} /> {checkIn.audience}
                </small>
              </div>
              <span className="feed-time">Just now</span>
            </div>
            <p className="feed-checkin-message">{checkIn.message}</p>
            <span className="feed-arrival-label">
              <Check size={13} /> Shared with your circle
            </span>
          </article>
        ))}

        {filter === "all" && coffeePlan && (
          <article className="card feed-card feed-meetup">
            <div className="feed-author">
              <Avatar id="bea" size={43} online />
              <div>
                <strong>
                  Bea <span className="feed-post-type">made a plan</span>
                </strong>
                <small>
                  <Users size={11} /> Close friends
                </small>
              </div>
              <span className="feed-time">2h ago</span>
            </div>
            <div className="feed-meetup-body">
              <div className="feed-meetup-copy">
                <span className="feed-plan-badge">TARA, COFFEE?</span>
                <h3>{coffeePlan.title}</h3>
                <p>Good coffee tastes better together. Who’s in?</p>
                <div className="feed-plan-date">
                  {coffeePlan.dateLabel}
                  <span>·</span>
                  {coffeePlan.time}
                </div>
                <div className="feed-plan-place">
                  <MapPin size={14} fill="#ff6a7c" />
                  {coffeePlan.place}
                </div>
              </div>
              <CoffeeIllustration />
            </div>
            <div className="feed-meetup-footer">
              <div className="feed-going">
                <AvatarStack
                  ids={
                    coffeePlan.joined
                      ? [
                          ...coffeePlan.attendees.filter((id) => id !== "mika"),
                          "mika",
                        ]
                      : coffeePlan.attendees
                  }
                  size={30}
                />
                <span>
                  {coffeePlan.attendees.filter((id) => id !== "mika").length +
                    (coffeePlan.joined ? 1 : 0)}{" "}
                  going{coffeePlan.joined ? ", including you" : ""}
                </span>
              </div>
              <button
                className={`button ${coffeePlan.joined ? "button-soft" : "button-coral"}`}
                onClick={() => onJoin(coffeePlan.id)}
                aria-pressed={coffeePlan.joined}
              >
                {coffeePlan.joined ? (
                  <>
                    <Check size={16} /> You’re going
                  </>
                ) : (
                  <>
                    Join plan <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>
          </article>
        )}

        <article className="card feed-card feed-arrival">
          <div className="feed-author">
            <Avatar id="paolo" size={43} />
            <div>
              <strong>
                Paolo <span className="feed-post-type">checked in</span>
              </strong>
              <small>
                <Users size={11} /> Close friends
              </small>
            </div>
            <span className="feed-time">5h ago</span>
          </div>
          <div className="feed-arrival-body">
            <div>
              <h3>Home safely!</h3>
              <p>
                Made it back. Good night, everyone.{" "}
                <span aria-label="moon">🌙</span>
              </p>
              <span className="feed-arrival-label">
                <ShieldCheck size={13} /> A little peace of mind
              </span>
            </div>
            <div className="feed-home-illustration">
              <House size={38} strokeWidth={1.8} fill="#b39be8" />
              <Sparkles size={20} />
            </div>
          </div>
          <div className="feed-reactions">
            <button
              className={`feed-like ${liked ? "feed-liked" : ""}`}
              aria-label={
                liked ? "Unlike Paolo’s check-in" : "Like Paolo’s check-in"
              }
              aria-pressed={liked}
              onClick={onLike}
            >
              <Heart size={18} fill={liked ? "currentColor" : "none"} />
              {4 + (liked ? 1 : 0)}
            </button>
            <button
              className="feed-comment-button"
              onClick={() => setShowComments(!showComments)}
              aria-expanded={showComments}
            >
              <MessageCircle size={18} />
              <span>
                {comments.length
                  ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
                  : "Say something nice"}
              </span>
            </button>
          </div>
          {showComments && (
            <div className="feed-comments">
              {comments.map((message, index) => (
                <div className="feed-comment" key={`${index}-${message}`}>
                  <Avatar id="mika" size={28} />
                  <p>
                    <strong>{identity.firstName}</strong>
                    {message}
                  </p>
                </div>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (comment.trim()) {
                    onComment(comment.trim());
                    setComment("");
                  }
                }}
              >
                <label className="sr-only" htmlFor="feed-comment">
                  Comment on Paolo’s check-in
                </label>
                <input
                  id="feed-comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Ingat, always!"
                  maxLength={240}
                />
                <button
                  className="icon-button"
                  aria-label="Send comment"
                  disabled={!comment.trim()}
                >
                  <Send size={17} />
                </button>
              </form>
            </div>
          )}
        </article>
      </div>

      <div className="home-feed-end">
        <span className="home-feed-end-spark">
          <Sparkles size={19} />
        </span>
        <strong>You’re in good company.</strong>
        <p>A little hello can go a long way.</p>
        <button onClick={() => onNavigate("friends")}>
          Find your people <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}
