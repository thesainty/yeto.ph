import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  MapPin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Modal } from "../components/ui";
import { createPlan, deletePlan, setAttendance } from "./api";
import { useSocial } from "./SocialProvider";
import { PersonAvatar, SocialStatus } from "./SocialUi";
import RecipientPicker from "./RecipientPicker";
import AudienceReview from "./AudienceReview";
import { useConnections } from "../account/ConnectionsProvider";
import { MAX_RECIPIENTS } from "./circles";
import type { SocialPlan } from "./types";
import PollsPanel from "../polls/PollsPanel";
import PlanTools from "../planning/PlanTools";
import PlanConversation from "../conversations/PlanConversation";
import "./social.css";

const planDate = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

function todayInManila() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Manila",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function readableError(cause: unknown) {
  return cause instanceof Error ? cause.message : "We couldn’t save that change. Please try again.";
}

interface Props {
  conversationActivity?: { planId: string; token: number } | null;
  onConversationOpened?: () => void;
}

export default function RealPlans({ conversationActivity, onConversationOpened }: Props) {
  const { userId, data, refreshing, error, setupRequired, refresh, run, busy, activityTarget } = useSocial();
  const connections = useConnections();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [title, setTitle] = useState("");
  const [place, setPlace] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("15:00");
  const [kind, setKind] = useState<SocialPlan["kind"]>("coffee");
  const [invitees, setInvitees] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const [cancelPlan, setCancelPlan] = useState<SocialPlan | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (activityTarget?.planId) setFilter("all");
  }, [activityTarget?.planId, activityTarget?.revision]);

  useEffect(() => {
    generation.current += 1;
    setCreating(false);
    setFilter("all");
    setTitle("");
    setPlace("");
    setDate("");
    setTime("15:00");
    setKind("coffee");
    setInvitees([]);
    setMessage("");
    setLocalError("");
    setCancelPlan(null);
    return () => { generation.current += 1; };
  }, [userId]);

  const disabled = busy || refreshing || !data || !!error || setupRequired;
  const plans = data?.plans ?? [];
  const shown = filter === "mine"
    ? plans.filter((plan) => plan.owner.id === userId || plan.attendees.some((person) => person.id === userId))
    : plans;

  async function save() {
    if (disabled) return;
    setLocalError("");
    setMessage("");
    const startsAt = new Date(`${date}T${time}:00+08:00`);
    if (!title.trim() || !place.trim() || !Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      setLocalError("Add a title, meeting place, and a future date and time in the Philippines.");
      return;
    }
    if (invitees.length > MAX_RECIPIENTS) {
      setLocalError(`Choose up to ${MAX_RECIPIENTS} friends for this plan.`);
      return;
    }
    const knownFriends = new Set(connections.data?.friends.map((person) => person.id));
    if (invitees.some((id) => !knownFriends.has(id)) || (invitees.length && (connections.error || connections.refreshing))) {
      setLocalError("Your selected friends have changed. Refresh your friends list and choose again.");
      return;
    }
    const current = generation.current;
    const recipients = [...invitees];
    try {
      await run(() => createPlan({
        title: title.trim(),
        place: place.trim(),
        starts_at: startsAt.toISOString(),
        kind,
        invitee_ids: recipients,
      }));
      if (current !== generation.current) return;
      setTitle("");
      setPlace("");
      setDate("");
      setTime("15:00");
      setKind("coffee");
      setInvitees([]);
      setCreating(false);
      setMessage("Plan saved. Only you and the friends you selected can see it.");
    } catch (cause) {
      if (current === generation.current) setLocalError(readableError(cause));
    }
  }

  async function rsvp(plan: SocialPlan, going: boolean) {
    if (disabled) return;
    const current = generation.current;
    setLocalError("");
    setMessage("");
    try {
      await run(() => setAttendance(plan.id, going));
      if (current === generation.current) setMessage(going ? "You’re going. Your friends can see your RSVP." : "You’ve left this plan.");
    } catch (cause) {
      if (current === generation.current) setLocalError(readableError(cause));
    }
  }

  async function confirmCancel() {
    if (!cancelPlan || disabled) return;
    const current = generation.current;
    const plan = cancelPlan;
    setLocalError("");
    setMessage("");
    try {
      await run(() => deletePlan(plan.id));
      if (current !== generation.current) return;
      setCancelPlan(null);
      setMessage("Plan cancelled. It is no longer visible to invited friends.");
    } catch (cause) {
      if (current === generation.current) setLocalError(readableError(cause));
    }
  }

  return (
    <div className="social-screen real-plans">
      <section className="card social-card social-plans-intro">
        <div className="social-heading">
          <div>
            <span className="eyebrow">REAL PLANS · SELECTED FRIENDS</span>
            <h2>A little plan. A lot of memories.</h2>
          </div>
          <button className="icon-button" aria-label="Refresh plans" disabled={busy || refreshing} onClick={() => void refresh()}>
            <RefreshCw size={18} />
          </button>
        </div>
        <p className="social-muted">Invite the people you choose. Everyone invited can see the plan, the invitees, and who’s going.</p>
        <button
          className="button button-primary"
          disabled={disabled}
          aria-expanded={creating}
          onClick={() => { setCreating(!creating); setLocalError(""); }}
        >
          <Plus size={17} /> Make a plan
        </button>
      </section>

      <SocialStatus />
      <PollsPanel />
      {message && <p className="social-message" role="status">{message}</p>}
      {localError && !error && !cancelPlan && <p className="social-error" role="alert">{localError}</p>}

      {creating && (
        <form className="card social-card social-form" aria-label="Create a real plan" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <h3>Give your next good memory a time and place.</h3>
          <label className="social-field">
            Plan title
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={70} required disabled={disabled} placeholder="Coffee and a little catch-up" />
          </label>
          <label className="social-field">
            Meeting place
            <input value={place} onChange={(event) => setPlace(event.target.value)} maxLength={90} required disabled={disabled} placeholder="A place your people will love" />
          </label>
          <div className="social-row">
            <label className="social-field">
              Date
              <input type="date" min={todayInManila()} value={date} onChange={(event) => setDate(event.target.value)} required disabled={disabled} />
            </label>
            <label className="social-field">
              Time (Philippines)
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required disabled={disabled} />
            </label>
          </div>
          <label className="social-field">
            The vibe
            <select value={kind} onChange={(event) => setKind(event.target.value as SocialPlan["kind"])} disabled={disabled}>
              <option value="coffee">Coffee & catch-up</option>
              <option value="food">Good food</option>
              <option value="trip">A little adventure</option>
            </select>
          </label>
          <RecipientPicker label="Invite friends" selected={invitees} onChange={setInvitees} disabled={disabled} />
          <p className="social-muted">No friends selected means a private plan for you. Invites never include new friends automatically.</p>
          <AudienceReview selected={invitees} kind="plan" />
          <div className="social-actions">
            <button className="button button-primary" disabled={disabled || !title.trim() || !place.trim() || !date || !time}>
              {busy ? "Saving…" : "Save plan"}
            </button>
            <button type="button" className="button button-soft" disabled={busy} onClick={() => setCreating(false)}>Keep as draft</button>
          </div>
        </form>
      )}

      {data && !error && (
        <>
          <div className="social-plan-filters" role="group" aria-label="Filter real plans">
            <button className={`button ${filter === "all" ? "button-primary" : "button-soft"}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All plans</button>
            <button className={`button ${filter === "mine" ? "button-primary" : "button-soft"}`} aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>My plans</button>
          </div>
          {shown.length === 0 ? (
            <section className="card social-card social-empty">
              <CalendarDays size={30} />
              <h3>{filter === "mine" ? "No plans you’re going to yet." : "Your calendar has room for a little fun."}</h3>
              <p>Start a private plan or invite a few real friends. Plans shared with you will appear here.</p>
            </section>
          ) : shown.map((plan) => {
            const hosting = plan.owner.id === userId;
            const invited = plan.invitees.some((person) => person.id === userId);
            const going = plan.attendees.some((person) => person.id === userId);
            return (
              <article className={`card social-card social-plan-card social-plan-${plan.kind}`} id={`activity-plan-${plan.id}`} tabIndex={-1} key={plan.id}>
                <div className="social-heading">
                  <div>
                    <span className="eyebrow">{hosting ? "YOUR PLAN" : "YOU’RE INVITED"}</span>
                    <h3>{plan.title}</h3>
                  </div>
                  {going && <span className="social-plan-going"><Check size={14} /> Going</span>}
                </div>
                <div className="social-person">
                  <PersonAvatar person={plan.owner} />
                  <div><strong>{plan.owner.display_name}</strong><small>@{plan.owner.username} · Host</small></div>
                </div>
                <p className="social-meta"><MapPin size={15} /> {plan.place}</p>
                <p className="social-meta"><Clock3 size={15} /> {planDate.format(new Date(plan.starts_at))} (Philippines)</p>
                <p className="social-meta"><Users size={15} /> {plan.invitees.length ? `${plan.invitees.length} invited · ${plan.attendees.length} going` : "Private plan · only you"}</p>
                <div className="social-plan-attendees" aria-label={`People going to ${plan.title}`}>
                  <strong>Going</strong>
                  {plan.attendees.map((person) => (
                    <span className="social-plan-attendee" key={person.id}><PersonAvatar person={person} /> {person.display_name}</span>
                  ))}
                </div>
                {plan.invitees.length > 0 && (
                  <p className="social-muted">Invited: {plan.invitees.map((person) => person.display_name).join(", ")}</p>
                )}
                <div className="social-actions">
                  {hosting ? (
                    <button className="button button-soft" disabled={disabled} onClick={() => { setCancelPlan(plan); setLocalError(""); }}>Cancel plan</button>
                  ) : invited ? (
                    <button className={`button ${going ? "button-soft" : "button-coral"}`} disabled={disabled} aria-label={`${going ? "Leave" : "Join"} ${plan.title}`} onClick={() => void rsvp(plan, !going)}>
                      {going ? "Leave plan" : "Join plan"}
                    </button>
                  ) : null}
                  {hosting && <span className="social-muted">You’re hosting and counted as going.</span>}
                </div>
                <PlanTools plan={plan} disabled={disabled} />
                <PlanConversation plan={plan} disabled={disabled} activityToken={conversationActivity?.planId === plan.id ? conversationActivity.token : undefined} onOpened={onConversationOpened} />
              </article>
            );
          })}
        </>
      )}
      <div className="social-privacy"><ShieldCheck size={18} /><p>Plans share only the details you enter. They never turn on GPS or location sharing.</p></div>
      {cancelPlan && (
        <Modal title={`Cancel ${cancelPlan.title}?`} subtitle="This removes the plan and its invitations for everyone. This can’t be undone." onClose={() => { if (!busy) setCancelPlan(null); }}>
          {localError && <p className="social-error" role="alert">{localError}</p>}
          <div className="social-actions">
            <button className="button button-coral" disabled={disabled} onClick={() => void confirmCancel()}>{busy ? "Cancelling…" : "Yes, cancel plan"}</button>
            <button className="button button-soft" disabled={busy} onClick={() => setCancelPlan(null)}>Keep plan</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
