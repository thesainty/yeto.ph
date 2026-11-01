import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
import Home from "./screens/Home";
import { useAccount } from "./account/AccountProvider";
import Friends from "./screens/Friends";
import Plans from "./screens/Plans";
import MapScreen, { MiniMap } from "./screens/Map";
import { initialState, people } from "./data";
import { loadState, STORAGE_KEY } from "./state";
import type { Circle, PersonId, Plan, Tab } from "./types";

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
    title: "Tara, Mika!",
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
  const account = useAccount();
  const [state, setState] = useState(loadState);
  const [tab, setTab] = useState<Tab>(readTab);
  const [modal, setModal] = useState<
    | "share"
    | "plan"
    | "friend"
    | "checkin"
    | "notifications"
    | "profile"
    | "account"
    | null
  >(null);
  const [toast, setToast] = useState("");
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
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

  useEffect(() => {
    if (account.recovery || (account.profileError && !account.session))
      setModal("account");
  }, [account.recovery, account.profileError, account.session]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      setStorageUnavailable(true);
    }
  }, [state]);
  useEffect(() => {
    const handle = () => setTab(readTab());
    window.addEventListener("popstate", handle);
    window.addEventListener("hashchange", handle);
    return () => {
      window.removeEventListener("popstate", handle);
      window.removeEventListener("hashchange", handle);
    };
  }, []);
  useEffect(() => {
    document.title = `Yeto — ${nav.find((item) => item.id === tab)?.label} | Tara, together.`;
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
      <div className="app-shell">
        <aside className="sidebar">
          <button
            className="brand-button"
            onClick={() => navigate("home")}
            aria-label="Yeto home"
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
                className={tab === id ? "nav-active" : ""}
                aria-current={tab === id ? "page" : undefined}
              >
                <Icon size={21} strokeWidth={tab === id ? 2.4 : 1.8} />
                <span>{label}</span>
                {id === "friends" && state.requestStatus === "pending" ? (
                  <i className="nav-badge">1</i>
                ) : id === "plans" && joinedPlans.length ? (
                  <i className="nav-count">{joinedPlans.length}</i>
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
            <Navigation size={16} fill="currentColor" /> Share a journey
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
              setModal("profile");
            }}
            aria-label="Open Mika’s profile"
          >
            <Avatar id="mika" size={41} />
            <span>
              <strong>Mika Reyes</strong>
              <small>@mikareyes</small>
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
              aria-label="Yeto home"
            >
              <Logo compact />
            </button>
            <div className="topbar-actions">
              <span className="demo-badge">
                <span /> Interactive demo
              </span>
              <button
                className="icon-button notification-button"
                onClick={() => setModal("notifications")}
                aria-label="Open notifications"
              >
                <Bell size={21} />
                {state.requestStatus === "pending" && <i />}
              </button>
              <button
                className="topbar-profile"
                onClick={() => {
                  setResetConfirmed(false);
                  setModal("profile");
                }}
                aria-label="Open your profile"
              >
                <Avatar id="mika" size={34} />
              </button>
            </div>
          </header>
          <div className="content-grid">
            <main
              id="main-content"
              ref={mainRef}
              tabIndex={-1}
              className="main-content"
            >
              <div className="page-heading">
                <span className="eyebrow">{copy.eyebrow}</span>
                <h1>
                  {copy.title}
                  {tab === "home" && (
                    <Sun className="heading-sun" size={34} strokeWidth={2.7} />
                  )}
                </h1>
                <p>{copy.subtitle}</p>
              </div>
              {storageUnavailable && (
                <div className="storage-notice" role="status">
                  <Info size={16} /> Your browser can’t save this demo. Changes
                  last until you refresh.
                </div>
              )}
              {tab === "home" && (
                <section
                  className="account-preview-callout"
                  aria-label="Real account setup"
                >
                  <span>
                    <Users size={20} />
                  </span>
                  <div>
                    <strong>
                      {account.session
                        ? `Connected as ${account.profile?.display_name ?? "your Yeto account"}`
                        : "Your people, for real."}
                    </strong>
                    <p>
                      {account.session
                        ? "Manage your real connections. This feed and its journeys remain samples."
                        : "Create your own account. The sample feed and journeys stay separate."}
                    </p>
                  </div>
                  <button
                    className="button button-soft"
                    onClick={() => setModal("account")}
                  >
                    {account.session ? "Manage account" : "Set up your account"}
                    <ArrowRight size={14} />
                  </button>
                </section>
              )}
              {tab === "home" && (
                <Home
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
                  sharing={state.sharing}
                  friendIds={state.friendIds}
                  onShare={openShare}
                  onStop={() => {
                    setState((previous) => ({ ...previous, sharing: null }));
                    notify("Sharing stopped. Your location is just yours.");
                  }}
                />
              )}
              {tab === "plans" && (
                <Plans
                  plans={state.plans}
                  onJoin={toggleJoin}
                  onCreate={() => setModal("plan")}
                />
              )}
              {tab === "friends" && (
                <Friends
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
                <span>A little closer, wherever life takes you.</span>
                <Heart size={12} fill="currentColor" />
              </footer>
            </main>

            <aside className="right-rail" aria-label="Your circle at a glance">
              <section className="card circle-overview">
                <div className="rail-heading">
                  <h2>Your circle, nearby</h2>
                  <span className="rail-live-label">Demo</span>
                </div>
                <p className="rail-description">
                  A small world, filled with your people.
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
              {upcomingPlan && (
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
                    setModal("profile");
                  }}
                >
                  A little peace of mind <ArrowRight size={12} />
                </button>
              </div>
              <div className="rail-footer">
                <span>Built with a little Filipino heart.</span>
                <span>Private by choice. Together by Yeto.</span>
              </div>
            </aside>
          </div>
        </div>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => navigate(id)}
            aria-current={tab === id ? "page" : undefined}
            className={tab === id ? "nav-active" : ""}
          >
            <span>
              <Icon size={22} strokeWidth={tab === id ? 2.5 : 1.8} />
              {id === "friends" && state.requestStatus === "pending" && <i />}
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
                This is a sample journey. Yeto isn’t accessing or sending your
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

      {modal === "plan" && (
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

      {modal === "checkin" && (
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
                <strong>Mika Reyes</strong>
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

      {modal === "notifications" && (
        <Modal
          title="A little heads-up."
          subtitle="Good things from your little world."
          onClose={() => setModal(null)}
        >
          <div className="notifications-list">
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
            <div className="notifications-note">
              <ShieldCheck size={19} />
              <p>
                Just the good stuff. These are sample notifications; no push
                alerts are enabled.
              </p>
            </div>
          </div>
        </Modal>
      )}

      {modal === "account" && (
        <Modal
          title="Your Yeto account"
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
            <AccountPanel />
          </Suspense>
        </Modal>
      )}
      {modal === "profile" && (
        <Modal
          title="Hey, Mika!"
          subtitle="Your little space in Yeto."
          onClose={() => setModal(null)}
        >
          <div className="profile-summary">
            <Avatar id="mika" size={78} />
            <h3>Mika Reyes</h3>
            <p>@mikareyes · Philippines</p>
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
                  ? "Your real Yeto account"
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
                This prototype uses fictional profiles and an illustrated map.
                It doesn’t request GPS access, create real accounts, or contact
                other people. Demo changes are saved in this browser.
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
