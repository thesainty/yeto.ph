import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BarChart3, CalendarCheck, MapPin, RefreshCw, Trash2, Users } from "lucide-react";
import { Modal } from "../components/ui";
import { PersonAvatar } from "../social/SocialUi";
import { useSocial } from "../social/SocialProvider";
import { usePolls } from "./PollsProvider";
import { convertPoll, deletePoll, setPollVotes } from "./api";
import type { PlanPoll } from "./types";
import PollComposer from "./PollComposer";
import "./polls.css";

const dateFormat = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" });
const optionLabel = (startsAt: string) => `${dateFormat.format(new Date(startsAt))} (Philippines)`;

interface CardProps {
  poll: PlanPoll;
  userId: string | null;
  disabled: boolean;
  onVote: (poll: PlanPoll, ids: string[]) => Promise<boolean>;
  onConvert: (poll: PlanPoll) => void;
  onDelete: (poll: PlanPoll) => void;
  onOpenPlan: (id: string) => void;
}

function PollCard({ poll, userId, disabled, onVote, onConvert, onDelete, onOpenPlan }: CardProps) {
  const savedKey = JSON.stringify(poll.options.filter((option) => option.voted_by_me).map((option) => option.id).sort());
  const [selected, setSelected] = useState<string[]>(() => JSON.parse(savedKey) as string[]);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!dirty) setSelected(JSON.parse(savedKey) as string[]); }, [savedKey, dirty]);
  const hosting = poll.owner.id === userId;
  const closed = !!poll.closed_at;
  const hasFuture = poll.options.some((option) => new Date(option.starts_at).valueOf() > Date.now());

  async function save() {
    const futureIds = new Set(poll.options.filter((option) => new Date(option.starts_at).valueOf() > Date.now()).map((option) => option.id));
    if (await onVote(poll, selected.filter((id) => futureIds.has(id))) && mounted.current) {
      setDirty(false);
      setMessage("Your availability was saved.");
    }
  }

  return <article className="card poll-card" aria-label={`Poll: ${poll.title}`} id={`activity-poll-${poll.id}`} tabIndex={-1}>
    <div className="poll-card-heading"><div><span className="eyebrow">{closed ? "TIME CHOSEN" : hosting ? "YOUR POLL" : "YOU’RE INVITED"}</span><h3>{poll.title}</h3></div>{hosting && <button type="button" className="icon-button poll-delete" aria-label={`Delete poll: ${poll.title}`} disabled={disabled} onClick={() => onDelete(poll)}><Trash2 size={16} /></button>}</div>
    <div className="social-person"><PersonAvatar person={poll.owner} /><div><strong>{poll.owner.display_name}</strong><small>@{poll.owner.username} · Organizer</small></div></div>
    <p className="social-meta"><MapPin size={14} />{poll.place}</p>
    {poll.invitees.length ? <details className="poll-invitees"><summary><Users size={14} /> {poll.invitees.length} invited friend{poll.invitees.length === 1 ? "" : "s"}</summary><ul aria-label={`Invited friends for ${poll.title}`}>{poll.invitees.map((person) => <li key={person.id}>{person.display_name} <small>@{person.username}</small></li>)}</ul></details> : <p className="social-meta"><Users size={14} />Only me · private poll</p>}
    <fieldset className="poll-vote-options" disabled={disabled || closed || !hasFuture}>
      <legend>{closed ? "Availability results" : "Choose every time that works for you"}</legend>
      {poll.options.map((option) => {
        const expired = new Date(option.starts_at).valueOf() <= Date.now();
        return <label className={`poll-vote-option${selected.includes(option.id) ? " poll-vote-selected" : ""}`} key={option.id}>
          <input type="checkbox" checked={selected.includes(option.id)} disabled={disabled || closed || expired} aria-label={optionLabel(option.starts_at)} onChange={(event) => {
            setSelected((previous) => event.target.checked ? [...previous.filter((id) => id !== option.id), option.id] : previous.filter((id) => id !== option.id));
            setDirty(true);
            setMessage("");
          }} />
          <span><strong>{optionLabel(option.starts_at)}</strong><small>{option.vote_count} available{expired ? " · Time has passed" : ""}</small></span>
        </label>;
      })}
    </fieldset>
    {closed ? <div className="poll-closed-state"><CalendarCheck size={17} /><p>{poll.plan_id ? "A plan was created from this poll. Check the plan to RSVP." : "This poll is closed. The plan is no longer available."}</p>{poll.plan_id && <button type="button" className="button button-soft" disabled={disabled} onClick={() => onOpenPlan(poll.plan_id!)}>Open plan</button>}</div> : <>
      <p className="social-muted poll-vote-note">Voting shares your availability. It doesn’t RSVP to a plan.</p>
      {!hasFuture && <p className="social-muted">All suggested times have passed.</p>}
      <div className="poll-card-actions"><button type="button" className="button button-soft" disabled={disabled || !hasFuture || !dirty} onClick={() => void save()}>Save availability</button>{hosting && <button type="button" className="button button-primary" disabled={disabled || !hasFuture} onClick={() => onConvert(poll)}>Choose a time</button>}</div>
    </>}
    {message && <p className="social-message" role="status">{message}</p>}
  </article>;
}

function PollsContents() {
  const polls = usePolls();
  const social = useSocial();
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const [conversion, setConversion] = useState<{ id: string; optionId: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const owner = useRef(polls.userId);
  owner.current = polls.userId;
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const disabled = polls.busy || polls.refreshing || !polls.data || !!polls.error;
  const visibleSnapshot = polls.error ? polls.activityTarget?.data : polls.data;
  const convertingPoll = polls.data?.polls.find((poll) => poll.id === conversion?.id);
  const deletingPoll = polls.data?.polls.find((poll) => poll.id === deletingId);

  async function act(action: () => Promise<unknown>, success: () => void) {
    if (disabled) return false;
    const actor = polls.userId;
    const current = () => mounted.current && owner.current === actor;
    setLocalError("");
    setMessage("");
    try {
      await polls.run(action);
      if (!current()) return false;
      success();
      return true;
    } catch (cause) {
      if (current()) setLocalError(cause instanceof Error ? cause.message : "We couldn’t save your poll change. Please try again.");
      return false;
    }
  }

  async function createPlan() {
    if (!conversion || !convertingPoll || !conversion.optionId) return;
    const { id, optionId } = conversion;
    const actor = polls.userId;
    let planId: string | null = null;
    if (await act(async () => { planId = await convertPoll(id, optionId); }, () => {
      setConversion(null);
      setMessage("Plan created with this poll’s remaining original audience. Friends can now RSVP.");
    })) {
      await social.refresh(true);
      if (planId && mounted.current && owner.current === actor) {
        polls.clearActivityTarget();
        await social.openActivityTarget(null, planId);
      }
    }
  }

  return <section className="polls-panel" aria-label="Availability polls">
    <div className="polls-heading"><div><h2><BarChart3 size={19} />When are we free?</h2><p className="social-muted">Find a time together, then make it a plan.</p></div><div className="polls-toolbar"><button type="button" className="icon-button" aria-label="Refresh polls" disabled={polls.busy || polls.refreshing} onClick={() => { setLocalError(""); void polls.refresh(); }}><RefreshCw size={16} className={polls.refreshing ? "social-spinning" : ""} /></button><PollComposer onPublished={() => { setLocalError(""); setMessage("Poll published with the audience you selected."); }} /></div></div>
    {polls.activityTarget && <div className="activity-target-status">
      {polls.activityTarget.loading ? <p role="status">Opening your poll…</p> : polls.activityTarget.error ? <p role="alert">{polls.activityTarget.error}</p> : <p>Poll opened from your inbox.</p>}
      {polls.activityTarget.error && <button type="button" className="button button-soft" onClick={() => void polls.openActivityTarget(polls.activityTarget!.pollId)}>Try opening again</button>}
      <button type="button" className="button button-soft" onClick={polls.clearActivityTarget}>Close opened item</button>
    </div>}
    {polls.error && <div className="social-inline-error" role="alert"><strong>{polls.setupRequired ? "Availability polls aren’t ready yet" : "Your polls couldn’t load"}</strong><p>{polls.error}</p></div>}
    {!polls.data && !polls.error && <p className="social-muted" role="status">Loading your polls…</p>}
    {localError && <p className="social-inline-error" role="alert">{localError}</p>}
    {message && <p className="social-message" role="status">{message}</p>}
    {visibleSnapshot && <div className="polls-list">{visibleSnapshot.polls.length ? visibleSnapshot.polls.map((poll) => <PollCard key={poll.id} poll={poll} userId={polls.userId} disabled={disabled} onVote={(item, ids) => act(() => setPollVotes(item.id, [...ids]), () => {})} onConvert={(item) => { setLocalError(""); setConversion({ id: item.id, optionId: "" }); }} onDelete={(item) => { setLocalError(""); setDeletingId(item.id); }} onOpenPlan={(id) => { polls.clearActivityTarget(); void social.openActivityTarget(null, id); }} />) : <p className="polls-empty social-muted">Not sure when to meet? Suggest a few times for yourself or selected friends.</p>}</div>}
    {conversion && <Modal title="Create plan from poll" onClose={() => { if (!polls.busy) setConversion(null); }}>
      {convertingPoll ? <div className="poll-conversion"><h3>{convertingPoll.title}</h3><p className="social-muted"><MapPin size={14} /> {convertingPoll.place}</p><p className="social-muted">Choose the time to use. The plan keeps this poll’s original audience, excluding friends whose access was revoked. Votes don’t count as RSVPs.</p><fieldset className="poll-convert-options" disabled={disabled || !!convertingPoll.closed_at}><legend>Choose a time for the plan</legend>{convertingPoll.options.map((option) => <label className="poll-vote-option" key={option.id}><input type="radio" name="plan-poll-time" value={option.id} checked={conversion.optionId === option.id} disabled={disabled || new Date(option.starts_at).valueOf() <= Date.now()} onChange={() => setConversion({ id: convertingPoll.id, optionId: option.id })} /><span><strong>{optionLabel(option.starts_at)}</strong><small>{option.vote_count} available</small></span></label>)}</fieldset>{localError && <p className="social-inline-error" role="alert">{localError}</p>}<div className="poll-card-actions"><button type="button" className="button button-soft" disabled={polls.busy} onClick={() => setConversion(null)}>Keep voting</button><button type="button" className="button button-primary" disabled={disabled || !conversion.optionId || !!convertingPoll.closed_at} onClick={() => void createPlan()}><CalendarCheck size={15} />{polls.busy ? "Creating…" : "Create plan"}</button></div></div> : <p role="status" className="social-muted">This poll is unavailable. Close this dialog and refresh your polls.</p>}
    </Modal>}
    {deletingId && <Modal title="Delete this poll?" subtitle="This removes the poll and its votes for everyone. A plan already created from it will stay in Plans." onClose={() => { if (!polls.busy) setDeletingId(null); }}>
      {deletingPoll ? <div className="poll-delete-confirm"><strong>{deletingPoll.title}</strong>{localError && <p className="social-inline-error" role="alert">{localError}</p>}<div className="poll-card-actions"><button type="button" className="button button-soft" disabled={polls.busy} onClick={() => setDeletingId(null)}>Keep poll</button><button type="button" className="button button-coral" disabled={disabled} onClick={() => void act(() => deletePoll(deletingPoll.id), () => { setDeletingId(null); setMessage("Poll deleted. Any plan you created from it is unchanged."); })}>{polls.busy ? "Deleting…" : "Yes, delete poll"}</button></div></div> : <p role="status" className="social-muted">This poll is unavailable. Close this dialog and refresh your polls.</p>}
    </Modal>}
  </section>;
}

/** Immediately discard private drafts and modal state when account ownership changes. */
export default function PollsPanel() {
  const { userId } = usePolls();
  return <PollsContents key={userId ?? "anonymous"} />;
}
