import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Coffee,
  Heart,
  Home as HomeIcon,
  Info,
  LockKeyhole,
  MapPin,
  Moon,
  Navigation,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  X,
} from "lucide-react";
import { Avatar, AvatarStack, Logo, Modal } from "./components/ui";
import PilotGuide from "./components/PilotGuide";
import Home from "./screens/Home";
import { useAccount } from "./account/AccountProvider";
import { useConnections } from "./account/ConnectionsProvider";
import { useSocial } from "./social/SocialProvider";
import { usePolls } from "./polls/PollsProvider";
import RealHome from "./social/RealHome";
import RealPlans from "./social/RealPlans";
import ActivityInbox from "./activity/ActivityInbox";
import { useActivityInbox } from "./activity/ActivityInboxProvider";
import type { ActivityItem } from "./activity/api";
import Friends from "./screens/Friends";
import Plans from "./screens/Plans";
import MapScreen, { MiniMap } from "./screens/Map";
import { initialState, people } from "./data";
import { useDemoState } from "./useDemoState";
import { useIdentity } from "./account/useIdentity";
import type { Circle, PersonId, Plan, Tab } from "./types";
import { useTheme } from "./theme/useTheme";
import "./home-layout.css";

const AccountPanel = lazy(() => import("./account/AccountPanel"));

const nav = [
  { id: "home" as const, label: "Home", icon: HomeIcon },
  { id: "map" as const, label: "Map", icon: MapPin },
  { id: "plans" as const, label: "Plans", icon: CalendarDays },
  { id: "friends" as const, label: "Friends", icon: Users },
];
const pageCopy: Record<
  Tab,
  { eyebrow: string; title: string; subtitle: string }
> = {
  home: {
    eyebrow: "YOUR PEOPLE. YOUR LITTLE WORLD.",
    title: "Tara!",
    subtitle: "Good things happen when we’re together.",
  },
  map: {
    eyebrow: "A LITTLE CLOSER, WHEREVER.",
    title: "Around your circle",
    subtitle: "Find your people. Leave the guesswork behind.",
  },
  plans: {
    eyebrow: "LESS “DRAWING.” MORE DOING.",
    title: "Tara, let’s make plans.",
    subtitle: "The best moments start with “who’s in?”",
  },
  friends: {
    eyebrow: "LIFE’S BETTER WITH YOUR PEOPLE.",
    title: "Your people",
    subtitle: "A little family. A little barkada. A lot of good company.",
  },
};
const circles: Circle[] = ["Close friends", "Pamilya", "Barkada"];
function readTab(): Tab {
  const value = window.location.hash.slice(1);
  return nav.some((item) => item.id === value) ? (value as Tab) : "home";
}
function uniqueId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
function formatDuration(minutes: number | null) {
  return minutes === null
    ? "Until you stop"
    : minutes < 60
      ? `${minutes} minutes`
      : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const account = useAccount();
  const connections = useConnections();
  const social = useSocial();
  const polls = usePolls();
  const inbox = useActivityInbox();
  const identity = useIdentity();
  const ownerId = account.session?.user.id ?? null;
  const activityOwner = account.loading ? "restoring" : (ownerId ?? "demo");
  const { state, setState, storageUnavailable } = useDemoState(
    ownerId,
    account.loading,
  );
  const pendingRequests = account.loading
    ? 0
    : account.session
      ? (connections.error ? 0 : connections.data?.incoming.length ?? 0)
      : state.requestStatus === "pending" ? 1 : 0;
  const [tab, setTab] = useState<Tab>(readTab);
  const [friendActivity, setFriendActivity] = useState<{ requestId: string | null; token: number } | null>(null);
  const [conversationActivity, setConversationActivity] = useState<{ planId: string; token: number } | null>(null);
  const [modal, setModal] = useState<
    | "share"
    | "plan"
    | "friend"
    | "checkin"
    | "notifications"
    | "profile"
    | "account"
    | "pilot"
    | null
  >(null);
  const [toast, setToast] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  const focusedActivity = useRef<string | null>(null);
  const unreadActivity = account.loading ? 0 : account.session
    ? (inbox.data?.unread_count ?? (inbox.setupRequired ? pendingRequests : 0)) : pendingRequests;
  const [audience, setAudience] = useState<Circle>("Close friends");
  const [duration, setDuration] = useState<number | null>(60);
  const [destination, setDestination] = useState("");
  const [friendSearch, setFriendSearch] = useState("");
  const [checkInText, setCheckInText] = useState(
    "Home safely! Ingat, everyone.",
  );
  const [checkInAudience, setCheckInAudience] =
    useState<Circle>("Close friends");
  const [planTitle, setPlanTitle] = useState("");
  const [planPlace, setPlanPlace] = useState("");
  const [planDate, setPlanDate] = useState("");
  const [planTime, setPlanTime] = useState("15:00");
  const [planKind, setPlanKind] = useState<Plan["kind"]>("coffee");
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  useLayoutEffect(() => {
    // Account changes also discard unsent local form drafts before paint.
    setToast("");
    setFriendActivity(null);
    setConversationActivity(null);
    setAudience("Close friends");
    setDuration(60);
    setDestination("");
    setFriendSearch("");
    setCheckInText("Home safely! Ingat, everyone.");
    setCheckInAudience("Close friends");
    setPlanTitle("");
    setPlanPlace("");
    setPlanDate("");
    setPlanTime("15:00");
    setPlanKind("coffee");
    setResetConfirmed(false);
    setModal((current) => (current === "account" ? current : null));
  }, [account.session?.user.id]);

  useEffect(() => {
    if (account.recovery || (account.profileError && !account.session))
      setModal("account");
  }, [account.recovery, account.profileError, account.session]);

  useEffect(() => {
    if (account.session && modal === "profile") setModal("account");
  }, [account.session, modal]);

  useEffect(() => {
    const handle = () => { social.clearActivityTarget(); polls.clearActivityTarget(); focusedActivity.current = null; setConversationActivity(null); setTab(readTab()); };
    window.addEventListener("popstate", handle);
    window.addEventListener("hashchange", handle);
    return () => {
      window.removeEventListener("popstate", handle);
      window.removeEventListener("hashchange", handle);
    };
  }, [social.clearActivityTarget, polls.clearActivityTarget]);
  useEffect(() => {
    const target = social.activityTarget;
    if (!target || target.loading || target.error) return;
    const id = target.postId ? `activity-post-${target.postId}` : `activity-plan-${target.planId}`;
    if (focusedActivity.current === id) return;
    const element = document.getElementById(id);
    if (!element) return;
    focusedActivity.current = id;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus({ preventScroll: true });
  }, [social.activityTarget, social.data, tab]);
  useEffect(() => {
    if (social.activityTarget?.error && social.activityTarget.planId === conversationActivity?.planId) setConversationActivity(null);
  }, [social.activityTarget, conversationActivity]);
  useEffect(() => {
    const target = polls.activityTarget;
    if (!target || target.loading || target.error) return;
    const id = `activity-poll-${target.pollId}`;
    if (focusedActivity.current === id) return;
    const element = document.getElementById(id);
    if (!element) return;
    focusedActivity.current = id;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus({ preventScroll: true });
  }, [polls.activityTarget, polls.data, tab]);
  useEffect(() => {
    document.title = `TARA — ${nav.find((item) => item.id === tab)?.label} | Stay connected. A little closer.`;
  }, [tab]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const sharing = state.sharing;
    if (!sharing || sharing.durationMinutes === null) return;
    const remaining =
      sharing.startedAt + sharing.durationMinutes * 60000 - Date.now();
    const timer = window.setTimeout(
      () => {
        setState((previous) => ({ ...previous, sharing: null }));
        setToast(
          "Your sharing timer ended. Your location is just yours again.",
        );
      },
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(timer);
  }, [state.sharing]);

  function navigate(next: Tab) {
    social.clearActivityTarget();
    polls.clearActivityTarget();
    focusedActivity.current = null;
    setFriendActivity(null);
    setConversationActivity(null);
    if (next !== tab) {
      setTab(next);
      window.history.pushState({}, "", `#${next}`);
      window.scrollTo({ top: 0, behavior: "instant" });
      window.setTimeout(
        () => mainRef.current?.focus({ preventScroll: true }),
        0,
      );
    }
  }
  function openActivity(item: ActivityItem) {
    setModal(null);
    navigate(item.poll_id || item.plan_id ? "plans" : item.post_id ? "home" : "friends");
    if (item.kind === "friend_request") setFriendActivity({ requestId: item.request_id, token: performance.now() });
    if (item.kind === "plan_message" && item.plan_id) setConversationActivity({ planId: item.plan_id, token: performance.now() });
    if (item.post_id || item.plan_id) void social.openActivityTarget(item.post_id, item.plan_id);
    if (item.poll_id) void polls.openActivityTarget(item.poll_id);
  }
  function notify(message: string) {
    setToast(message);
  }
  function toggleJoin(id: string) {
    const plan = state.plans.find((item) => item.id === id);
    if (!plan) return;
    setState((previous) => ({
      ...previous,
      plans: previous.plans.map((item) =>
        item.id === id
          ? {
              ...item,
              joined: !item.joined,
              attendees: item.joined
                ? item.attendees.filter((person) => person !== "mika")
                : [
                    ...item.attendees.filter((person) => person !== "mika"),
                    "mika",
                  ],
            }
          : item,
      ),
    }));
    notify(
      plan.joined
        ? "You left the plan. There’s always next time."
        : "You’re in! Find this meetup in Plans.",
    );
  }
  function acceptRequest() {
    setState((previous) => ({
      ...previous,
      requestStatus: "accepted",
      friendIds: [...new Set([...previous.friendIds, "ana" as const])],
      sharing: null,
    }));
    notify(
      state.sharing
        ? "Ana is now a friend. Your demo journey stopped so you can choose who to share with again."
        : "You and Ana are now friends. Location sharing stays off.",
    );
  }
  function removeFriend(id: PersonId) {
    setState((previous) => ({
      ...previous,
      friendIds: previous.friendIds.filter((friend) => friend !== id),
      requestStatus: id === "ana" ? "declined" : previous.requestStatus,
      sharing: null,
    }));
    notify(`${people[id].name} removed. Any demo sharing session has stopped.`);
  }
  function openShare() {
    setAudience(state.sharing?.audience ?? "Close friends");
    setDuration(
      state.sharing?.durationMinutes === undefined
        ? 60
        : state.sharing.durationMinutes,
    );
    setDestination(state.sharing?.destination ?? "");
    setModal("share");
  }
  function createPlan() {
    const date = new Date(`${planDate}T12:00:00+08:00`);
    if (
      !planTitle.trim() ||
      !planPlace.trim() ||
      !planDate ||
      !planTime ||
      Number.isNaN(date.getTime())
    )
      return;
    const label = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(date);
    const time = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(`${planDate}T${planTime}:00+08:00`));
    const plan: Plan = {
      id: uniqueId(),
      title: planTitle.trim(),
      place: planPlace.trim(),
      dateLabel: label,
      time,
      kind: planKind,
      joined: true,
      attendees: ["mika"],
    };
    setState((previous) => ({ ...previous, plans: [plan, ...previous.plans] }));
    setModal(null);
    setPlanTitle("");
    setPlanPlace("");
    setPlanDate("");
    navigate("plans");
    notify("Plan created in your demo. Tara, let’s go!");
  }
  const joinedPlans = state.plans.filter((plan) => plan.joined);
  const upcomingPlan = joinedPlans[0] ?? state.plans[0];
  const joinedPlanCount = account.session
    ? social.data?.plans.filter((plan) =>
        plan.attendees.some((person) => person.id === ownerId),
      ).length ?? 0
    : joinedPlans.length;
  const friendResults = (["ana", "nico"] as PersonId[]).filter((id) =>
    `${people[id].fullName} ${people[id].handle}`
      .toLowerCase()
      .includes(friendSearch.toLowerCase().replace(/^@/, "")),
  );
  const audienceMembers = state.friendIds.filter(
    (id) => audience !== "Pamilya" || id === "paolo" || id === "ana",
  );
  const copy = pageCopy[tab];

  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <div className={`app-shell${tab === "home" ? " app-shell-home" : ""}`}>
        <aside className="sidebar">
          <button
            className="brand-button"
            onClick={() => navigate("home")}
            aria-label="TARA home"
          >
            <Logo />
          </button>
          <div className="sidebar-divider" />
          <span className="sidebar-label">YOUR LITTLE WORLD</span>
          <nav className="desktop-nav" aria-label="Main navigation">
            {nav.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => navigate(id)}
                aria-label={
                  id === "friends" && pendingRequests > 0
                    ? `Friends (${pendingRequests} pending requests)`
                    : undefined
                }
                className={tab === id ? "nav-active" : ""}
                aria-current={tab === id ? "page" : undefined}
              >
                <Icon size={21} strokeWidth={tab === id ? 2.4 : 1.8} />
                <span>{label}</span>
                {id === "friends" && pendingRequests > 0 ? (
                  <i className="nav-badge" aria-hidden="true">
                    {pendingRequests}
                  </i>
                ) : id === "plans" && joinedPlanCount ? (
                  <i className="nav-count">{joinedPlanCount}</i>
                ) : tab === id ? (
                  <span className="nav-active-dot" />
                ) : null}
              </button>
            ))}
          </nav>
          <button
            className="button button-primary sidebar-share"
            onClick={openShare}
          >
            <Navigation size={16} fill="currentColor" />{" "}
            {account.session ? "Try a demo journey" : "Share a journey"}
          </button>
          <div className="sidebar-note">
            <span className="sidebar-note-art" aria-hidden="true">
              <Heart size={22} fill="#ffb8b1" />
              <Sparkles size={18} />
            </span>
            <strong>Closer feels good.</strong>
            <p>
              A little hello. A safe arrival.
              <br />
              The people who matter.
            </p>
            <span>Made for moments like these.</span>
          </div>
          <button
            className="sidebar-profile"
            onClick={() => {
              setResetConfirmed(false);
              setModal(account.session ? "account" : "profile");
            }}
            aria-label={
              identity.isDemo
                ? "Open Mika’s profile"
                : "Open your account profile"
            }
          >
            <Avatar id="mika" size={41} />
            <span>
              <strong>{identity.displayName}</strong>
              <small>
                {identity.username
                  ? `@${identity.username}`
                  : "Your TARA account"}
              </small>
            </span>
            <ChevronDown size={16} />
          </button>
        </aside>

        <div className="workspace">
          <header className="topbar">
            <div className="topbar-desktop">
              <span className="topbar-sun">
                <Sun size={16} />
              </span>{" "}
              Your little corner of the world.
            </div>
            <button
              className="brand-button mobile-brand"
              onClick={() => navigate("home")}
              aria-label="TARA home"
            >
              <Logo />
            </button>
            <div className="topbar-actions">
              <span className="demo-badge">
                <span />{" "}
                {account.session
                  ? tab === "map" ? "Sample map" : tab === "friends" ? "Real connections" : "Real activity"
                  : "Interactive demo"}
              </span>
              <button
                type="button"
                className="icon-button theme-toggle"
                role="switch"
                aria-label="Dark mode"
                aria-checked={theme === "dark"}
                title={theme === "dark" ? "Turn dark mode off" : "Turn dark mode on"}
                onClick={toggleTheme}
              >
                {theme === "dark" ? <Sun size={19} aria-hidden="true" /> : <Moon size={19} aria-hidden="true" />}
              </button>
              <button
                className="icon-button notification-button"
                onClick={() => { setModal("notifications"); if (account.session) void inbox.refresh(); }}
                aria-label="Open notifications"
                aria-describedby="activity-unread-count"
              >
                <Bell size={21} />
                {unreadActivity > 0 && (account.session ? <span className="activity-badge" aria-hidden="true">{unreadActivity > 99 ? "99+" : unreadActivity}</span> : <i />)}
                <span id="activity-unread-count" className="sr-only">{unreadActivity} unread activities</span>
              </button>
              <button
                className="topbar-profile"
                onClick={() => {
                  setResetConfirmed(false);
                  setModal(account.session ? "account" : "profile");
                }}
                aria-label="Open your profile"
              >
                <Avatar id="mika" size={34} />
              </button>
            </div>
          </header>
          <div className={`content-grid${tab === "home" ? " content-grid-home" : ""}`}>
            <main
              id="main-content"
              ref={mainRef}
              tabIndex={-1}
              className="main-content"
            >
              <div className={`page-heading${tab === "home" ? " page-heading-home" : ""}`}>
                {tab !== "home" && <span className="eyebrow">{copy.eyebrow}</span>}
                <h1>
                  <span>
                    {tab === "home"
                      ? `Tara, ${identity.firstName}!`
                      : copy.title}
                  </span>
                  {tab === "home" && (
                    <Sun className="heading-sun" size={34} strokeWidth={2.7} />
                  )}
                </h1>
                {tab !== "home" && <p>{copy.subtitle}</p>}
              </div>
              {storageUnavailable && (
                <div className="storage-notice" role="status">
                  <Info size={16} /> Your browser can’t save this demo. Changes
                  last until you refresh.
                </div>
              )}
              {tab === "home" && !account.session && !account.loading && (
                <section
                  className="account-preview-callout"
                  aria-label="Real account setup"
                >
                  <span>
                    <Users size={20} />
                  </span>
                  <div>
                    <strong>
                      You’re viewing the demo
                    </strong>
                  </div>
                  <button
                    className="button button-soft"
                    onClick={() => setModal("account")}
                  >
                    Set up your account
                    <ArrowRight size={14} />
                  </button>
                </section>
              )}
              {tab === "home" && account.loading && (
                <div className="card account-loading" role="status">Loading your account…</div>
              )}
              {tab === "home" && !account.loading && account.session && (
                <>
                  {social.activityTarget?.postId && <div className="activity-target-status">
                    {social.activityTarget.loading ? <p role="status">Opening your update…</p> : social.activityTarget.error ? <p role="alert">{social.activityTarget.error}</p> : <p>Update opened from your inbox.</p>}
                    {social.activityTarget.error && <button type="button" className="button button-soft" onClick={() => void social.openActivityTarget(social.activityTarget!.postId, null)}>Try opening again</button>}
                    <button type="button" className="button button-soft" onClick={social.clearActivityTarget}>Close opened item</button>
                  </div>}
                  <RealHome key={ownerId} />
                </>
              )}
              {tab === "home" && !account.loading && !account.session && (
                <Home
                  key={activityOwner}
                  plans={state.plans}
                  liked={state.liked}
                  comments={state.comments}
                  sharing={state.sharing}
                  checkIns={state.checkIns}
                  onJoin={toggleJoin}
                  onLike={() =>
                    setState((previous) => ({
                      ...previous,
                      liked: !previous.liked,
                    }))
                  }
                  onShare={openShare}
                  onCheckIn={() => setModal("checkin")}
                  onComment={(message) =>
                    setState((previous) => ({
                      ...previous,
                      comments: [...previous.comments, message],
                    }))
                  }
                  onNavigate={navigate}
                />
              )}
              {tab === "map" && (
                <MapScreen
                  key={activityOwner}
                  sharing={state.sharing}
                  friendIds={state.friendIds}
                  onShare={openShare}
                  onStop={() => {
                    setState((previous) => ({ ...previous, sharing: null }));
                    notify("Sharing stopped. Your location is just yours.");
                  }}
                />
              )}
              {tab === "plans" && account.loading && (
                <div className="card account-loading" role="status">Loading your account…</div>
              )}
              {tab === "plans" && !account.loading && account.session && (
                <>
                  {social.activityTarget?.planId && <div className="activity-target-status">
                    {social.activityTarget.loading ? <p role="status">Opening your plan…</p> : social.activityTarget.error ? <p role="alert">{social.activityTarget.error}</p> : <p>Plan opened from your inbox.</p>}
                    {social.activityTarget.error && <button type="button" className="button button-soft" onClick={() => void social.openActivityTarget(null, social.activityTarget!.planId)}>Try opening again</button>}
                    <button type="button" className="button button-soft" onClick={social.clearActivityTarget}>Close opened item</button>
                  </div>}
                  <RealPlans key={ownerId} conversationActivity={conversationActivity} onConversationOpened={() => setConversationActivity(null)} />
                </>
              )}
              {tab === "plans" && !account.loading && !account.session && (
                <Plans
                  key={activityOwner}
                  plans={state.plans}
                  onJoin={toggleJoin}
                  onCreate={() => setModal("plan")}
                />
              )}
              {tab === "friends" && (
                <Friends
                  key={`${activityOwner}:${friendActivity?.token ?? "default"}`}
                  openRequests={Boolean(friendActivity)}
                  focusRequestId={friendActivity?.requestId}
                  friendIds={state.friendIds}
                  requestStatus={state.requestStatus}
                  onAccept={acceptRequest}
                  onDecline={() => {
                    setState((previous) => ({
                      ...previous,
                      requestStatus: "declined",
                    }));
                    notify("Friend request declined.");
                  }}
                  onAddFriend={() => {
                    setFriendSearch("");
                    setModal("friend");
                  }}
                  onRemoveFriend={removeFriend}
                  onShare={openShare}
                />
              )}
              <footer className="main-footer">
                <Logo compact />
                <span>Stay connected. A little closer.</span>
                <Heart size={12} fill="currentColor" />
                <button className="pilot-guide-link" onClick={() => setModal("pilot")}>Pilot guide</button>
              </footer>
            </main>

            {tab !== "home" && <aside className="right-rail" aria-label="Your circle at a glance">
              <section className="card circle-overview">
                <div className="rail-heading">
                  <h2>
                    {account.session ? "Sample circle, nearby" : "Your circle, nearby"}
                  </h2>
                  <span className="rail-live-label">Demo</span>
                </div>
                <p className="rail-description">
                  {account.session
                    ? "Fictional people and locations, separate from real friends."
                    : "A small world, filled with your people."}
                </p>
                <MiniMap
                  friendIds={state.friendIds}
                  onOpen={() => navigate("map")}
                />
                <div className="rail-people">
                  {state.friendIds.slice(0, 3).map((id, index) => (
                    <div key={id}>
                      <Avatar id={id} size={36} />
                      <span>
                        <strong>{people[id].name}</strong>
                        <small>
                          {index === 0
                            ? "Coffee & a little catch-up"
                            : index === 1
                              ? "Out and about"
                              : "Home, sweet home"}
                        </small>
                      </span>
                      <i className={`rail-status-dot rail-status-${index}`} />
                    </div>
                  ))}
                  {!state.friendIds.length && (
                    <p className="muted">Your circle starts with a hello.</p>
                  )}
                </div>
                <button className="rail-link" onClick={() => navigate("map")}>
                  Open circle map <ArrowRight size={15} />
                </button>
              </section>
              {!account.session && upcomingPlan && (
                <section className="card rail-plan">
                  <div className="rail-heading">
                    <h2>Something to look forward to</h2>
                    <CalendarDays size={17} />
                  </div>
                  <div className="rail-plan-icon">
                    <Coffee size={25} />
                  </div>
                  <span className="eyebrow">
                    {upcomingPlan.dateLabel} · {upcomingPlan.time}
                  </span>
                  <h3>{upcomingPlan.title}</h3>
                  <p>
                    <MapPin size={13} />
                    {upcomingPlan.place}
                  </p>
                  <div className="rail-plan-bottom">
                    <AvatarStack ids={upcomingPlan.attendees} size={26} />
                    <button
                      onClick={() => navigate("plans")}
                      aria-label="View plans"
                    >
                      <ArrowRight size={19} />
                    </button>
                  </div>
                </section>
              )}
              <div className="rail-privacy">
                <span>
                  <ShieldCheck size={20} />
                </span>
                <strong>Your location. Your choice.</strong>
                <p>
                  Share a moment, not your whole life.
                  <br />
                  You’re always in control.
                </p>
                <button
                  onClick={() => {
                    setResetConfirmed(false);
                    setModal(account.session ? "account" : "profile");
                  }}
                >
                  A little peace of mind <ArrowRight size={12} />
                </button>
              </div>
              <div className="rail-footer">
                <span>Built with a little Filipino heart.</span>
                <span>Private by choice. Together by TARA.</span>
              </div>
            </aside>}
          </div>
        </div>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => navigate(id)}
            aria-label={
              id === "friends" && pendingRequests > 0
                ? `Friends (${pendingRequests} pending requests)`
                : undefined
            }
            aria-current={tab === id ? "page" : undefined}
            className={tab === id ? "nav-active" : ""}
          >
            <span>
              <Icon size={22} strokeWidth={tab === id ? 2.5 : 1.8} />
              {id === "friends" && pendingRequests > 0 && (
                <i className="nav-badge" aria-hidden="true">
                  {pendingRequests}
                </i>
              )}
            </span>
            {label}
          </button>
        ))}
      </nav>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={17} />
          </span>
          <p>{toast}</p>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {modal === "share" && (
        <Modal
          title={
            state.sharing ? "Your journey, your rules." : "Let’s go, together."
          }
          subtitle="Choose your people and how long to share."
          onClose={() => setModal(null)}
        >
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!audienceMembers.length) return;
              setState((previous) => ({
                ...previous,
                sharing: {
                  audience,
                  durationMinutes: duration,
                  startedAt: Date.now(),
                  destination: destination.trim(),
                },
              }));
              setModal(null);
              navigate("map");
              notify("Demo journey started. You can stop sharing anytime.");
            }}
          >
            <div className="dialog-demo-note">
              <Info size={18} />
              <p>
                This is a sample journey. TARA isn’t accessing or sending your
                real location.
              </p>
            </div>
            <fieldset>
              <legend>Who’s coming along?</legend>
              <div className="audience-options">
                {circles.map((circle) => (
                  <button
                    type="button"
                    className={audience === circle ? "audience-selected" : ""}
                    key={circle}
                    aria-pressed={audience === circle}
                    onClick={() => setAudience(circle)}
                  >
                    {circle === "Pamilya" ? (
                      <Heart size={17} />
                    ) : (
                      <Users size={17} />
                    )}
                    {circle}
                    {audience === circle && <Check size={15} />}
                  </button>
                ))}
              </div>
              <div className="share-viewers">
                <AvatarStack ids={audienceMembers} size={28} />
                <span>
                  {audienceMembers.length
                    ? `${audienceMembers.length} ${audienceMembers.length === 1 ? "friend" : "friends"} in this sample circle`
                    : "No friends in this circle yet. Add a friend first."}
                </span>
              </div>
            </fieldset>
            <fieldset>
              <legend>For how long?</legend>
              <div className="duration-options">
                {[30, 60, 180, null].map((minutes) => (
                  <button
                    key={String(minutes)}
                    type="button"
                    onClick={() => setDuration(minutes)}
                    aria-pressed={duration === minutes}
                    className={duration === minutes ? "duration-selected" : ""}
                  >
                    {formatDuration(minutes)}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="form-field">
              Where are you headed? <span>(optional)</span>
              <input
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="Home, a café, a little adventure…"
                maxLength={80}
              />
            </label>
            <div className="dialog-privacy">
              <LockKeyhole size={17} />
              <p>
                {duration === null
                  ? "Ongoing sharing stays on until you stop it. You can end it from the map at any time."
                  : "Sharing ends automatically when your timer runs out. You can stop it sooner, anytime."}
              </p>
            </div>
            <button
              className="button button-primary button-full"
              disabled={!audienceMembers.length}
            >
              <Navigation size={17} fill="currentColor" />{" "}
              {state.sharing ? "Update demo journey" : "Start demo journey"}
            </button>
          </form>
        </Modal>
      )}

      {!account.session && modal === "plan" && (
        <Modal
          title="The group chat has a plan."
          subtitle="Give your next good memory a time and place."
          onClose={() => setModal(null)}
        >
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              createPlan();
            }}
          >
            <label className="form-field">
              What’s the plan?
              <input
                autoComplete="off"
                value={planTitle}
                onChange={(event) => setPlanTitle(event.target.value)}
                placeholder="Coffee, kwentuhan, and a little catch-up"
                maxLength={70}
                pattern={".*\\S.*"}
                title="Enter a name with at least one non-space character"
                required
              />
            </label>
            <label className="form-field">
              Where are we meeting?
              <input
                value={planPlace}
                onChange={(event) => setPlanPlace(event.target.value)}
                placeholder="A place your people will love"
                maxLength={90}
                pattern={".*\\S.*"}
                title="Enter a place with at least one non-space character"
                required
              />
            </label>
            <div className="form-row">
              <label className="form-field">
                Date
                <input
                  type="date"
                  min={today}
                  value={planDate}
                  onChange={(event) => setPlanDate(event.target.value)}
                  required
                />
              </label>
              <label className="form-field">
                Time <span>(Philippines)</span>
                <input
                  type="time"
                  value={planTime}
                  onChange={(event) => setPlanTime(event.target.value)}
                  required
                />
              </label>
            </div>
            <fieldset>
              <legend>The vibe</legend>
              <div className="duration-options">
                {(["coffee", "food", "trip"] as const).map((kind) => (
                  <button
                    type="button"
                    className={planKind === kind ? "duration-selected" : ""}
                    key={kind}
                    aria-pressed={planKind === kind}
                    onClick={() => setPlanKind(kind)}
                  >
                    {kind === "coffee"
                      ? "Coffee & catch-up"
                      : kind === "food"
                        ? "Good food"
                        : "A little adventure"}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="dialog-privacy">
              <Users size={17} />
              <p>
                Plans are saved on this device in the demo. Invitations aren’t
                sent to other people yet.
              </p>
            </div>
            <button className="button button-primary button-full">
              <Plus size={18} /> Make it a plan
            </button>
          </form>
        </Modal>
      )}

      {modal === "friend" && (
        <Modal
          title="Your people are out there."
          subtitle="Find a friend. Start with a little hello."
          onClose={() => setModal(null)}
        >
          <div className="dialog-form">
            <label className="form-field">
              Name or username
              <div className="input-with-icon">
                <Search size={18} />
                <input
                  placeholder="Try Ana or Nico"
                  value={friendSearch}
                  onChange={(event) => setFriendSearch(event.target.value)}
                />
              </div>
            </label>
            <p className="form-helper">
              Explore sample profiles. Requests stay in this demo.
            </p>
            <div className="friend-results">
              {friendResults.map((id) => (
                <div className="friend-result" key={id}>
                  <Avatar id={id} size={47} />
                  <div>
                    <strong>{people[id].fullName}</strong>
                    <small>@{people[id].handle}</small>
                  </div>
                  {state.friendIds.includes(id) ? (
                    <span className="friend-request-sent">
                      <Check size={14} /> Friends
                    </span>
                  ) : id === "ana" && state.requestStatus === "pending" ? (
                    <button
                      className="button button-coral"
                      onClick={acceptRequest}
                    >
                      Accept
                    </button>
                  ) : (
                    <button
                      className="button button-soft"
                      disabled={state.outgoingRequests.includes(id)}
                      onClick={() => {
                        setState((previous) => ({
                          ...previous,
                          outgoingRequests: [...previous.outgoingRequests, id],
                        }));
                        notify(
                          `Demo friend request sent to ${people[id].name}.`,
                        );
                      }}
                    >
                      {state.outgoingRequests.includes(id)
                        ? "Request sent"
                        : "Add friend"}
                    </button>
                  )}
                </div>
              ))}
              {!friendResults.length && (
                <div className="dialog-empty">
                  <Search size={28} />
                  <strong>No sample profiles found</strong>
                  <p>Try searching for Ana or Nico.</p>
                </div>
              )}
            </div>
            <div className="dialog-privacy">
              <ShieldCheck size={18} />
              <p>Making a connection never turns on location sharing.</p>
            </div>
          </div>
        </Modal>
      )}

      {!account.session && modal === "checkin" && (
        <Modal
          title="A little hello goes a long way."
          subtitle="Let your people know how you’re doing."
          onClose={() => setModal(null)}
        >
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!checkInText.trim()) return;
              setState((previous) => ({
                ...previous,
                checkIns: [
                  {
                    id: uniqueId(),
                    message: checkInText.trim(),
                    audience: checkInAudience,
                  },
                  ...previous.checkIns,
                ],
              }));
              setModal(null);
              navigate("home");
              notify("Your check-in is on the feed. Ingat, always!");
            }}
          >
            <div className="checkin-author">
              <Avatar id="mika" size={44} />
              <div>
                <strong>{identity.displayName}</strong>
                <small>Checking in with your people</small>
              </div>
            </div>
            <label className="form-field">
              What’s your little update?
              <textarea
                value={checkInText}
                onChange={(event) => setCheckInText(event.target.value)}
                maxLength={240}
                required
                rows={4}
                placeholder="Home safely! How’s everyone doing?"
              />
            </label>
            <label className="form-field">
              Who can see this?
              <select
                value={checkInAudience}
                onChange={(event) =>
                  setCheckInAudience(event.target.value as Circle)
                }
              >
                {circles.map((circle) => (
                  <option key={circle}>{circle}</option>
                ))}
              </select>
            </label>
            <p className="form-helper">
              A check-in shares your message, not your precise location.
            </p>
            <button
              className="button button-coral button-full"
              disabled={!checkInText.trim()}
            >
              <Heart size={17} /> Post a check-in
            </button>
          </form>
        </Modal>
      )}

      {modal === "notifications" && account.session && (
        <ActivityInbox onClose={() => setModal(null)} onOpen={openActivity} onFriends={() => { setModal(null); navigate("friends"); setFriendActivity({ requestId: null, token: performance.now() }); }} />
      )}
      {modal === "notifications" && !account.session && (
        <Modal
          title="A little heads-up."
          subtitle="Good things from your little world."
          onClose={() => setModal(null)}
        >
          <div className="notifications-list">
              <>
                {state.requestStatus === "pending" && (
                  <button
                    onClick={() => {
                      setModal(null);
                      navigate("friends");
                    }}
                  >
                    <Avatar id="ana" size={45} />
                    <span>
                      <strong>Ana wants to connect</strong>
                      <small>A new friend, a little closer. · 2h ago</small>
                    </span>
                    <ChevronRight size={18} />
                  </button>
                )}
                <button
                  onClick={() => {
                    setModal(null);
                    navigate("plans");
                  }}
                >
                  <span className="notification-icon">
                    <Coffee size={22} />
                  </span>
                  <span>
                    <strong>Bea’s making coffee plans</strong>
                    <small>Tomorrow at 3:00 PM. Are you in?</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
              </>
            <div className="notifications-note">
              <ShieldCheck size={19} />
              <p>
                Just the good stuff. These are sample notifications; no push alerts are enabled.
              </p>
            </div>
          </div>
        </Modal>
      )}

      {modal === "pilot" && (
        <PilotGuide onClose={() => setModal(null)} onAccount={() => setModal("account")} />
      )}
      {modal === "account" && (
        <Modal
          title="Your TARA account"
          subtitle="Real connections start with a little hello."
          onClose={() => setModal(null)}
        >
          <Suspense
            fallback={
              <div className="account-loading" role="status">
                Opening your account…
              </div>
            }
          >
            <AccountPanel key={ownerId ?? "demo"} />
          </Suspense>
        </Modal>
      )}
      {modal === "profile" && !account.session && (
        <Modal
          title={`Hey, ${identity.firstName}!`}
          subtitle="Your little space in TARA."
          onClose={() => setModal(null)}
        >
          <div className="profile-summary">
            <Avatar id="mika" size={78} />
            <h3>{identity.displayName}</h3>
            <p>
              {identity.username ? `@${identity.username} · ` : ""}Philippines
            </p>
            <span className="pill">
              <Sparkles size={13} /> Demo profile
            </span>
          </div>
          <div className="profile-stats">
            <div>
              <strong>{state.friendIds.length}</strong>
              <span>friends</span>
            </div>
            <div>
              <strong>{joinedPlans.length}</strong>
              <span>plans joined</span>
            </div>
            <div>
              <strong>{state.checkIns.length}</strong>
              <span>check-ins</span>
            </div>
          </div>
          <div className="profile-account-link">
            <Users size={19} />
            <div>
              <strong>
                {account.session
                  ? "Your real TARA account"
                  : "Ready to make it yours?"}
              </strong>
              <p>
                This Mika profile is a demo. Your real account and connections
                live separately.
              </p>
            </div>
            <button
              className="button button-primary"
              onClick={() => setModal("account")}
            >
              {account.session ? "Manage account" : "Set up your account"}
            </button>
          </div>
          <div className="profile-privacy">
            <ShieldCheck size={22} />
            <div>
              <strong>You’re in control.</strong>
              <p>
                The sample feed and illustrated map don’t request GPS access or
                contact other people. Sample changes are saved in this browser.
                Your real account and connections are managed through Set up
                your account.
              </p>
            </div>
          </div>
          <button
            className="button button-soft button-full"
            onClick={() => {
              setModal(null);
              navigate("map");
            }}
          >
            {state.sharing
              ? "Manage your demo sharing"
              : "See your sharing controls"}
            <ArrowRight size={16} />
          </button>
          {resetConfirmed ? (
            <div className="reset-confirm">
              <p>Reset friends, plans, and check-ins on this device?</p>
              <button
                className="button button-coral"
                onClick={() => {
                  setState(structuredClone(initialState));
                  setModal(null);
                  navigate("home");
                  notify("A fresh start. Your demo has been reset.");
                }}
              >
                Yes, reset demo
              </button>
              <button
                className="button button-soft"
                onClick={() => setResetConfirmed(false)}
              >
                Keep my changes
              </button>
            </div>
          ) : (
            <button
              className="reset-link"
              onClick={() => setResetConfirmed(true)}
            >
              <ArrowDownLeft size={13} /> Reset demo
            </button>
          )}
        </Modal>
      )}
    </>
  );
}
