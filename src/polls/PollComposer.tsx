import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, LockKeyhole, Plus, Users, X } from "lucide-react";
import { Modal } from "../components/ui";
import { useConnections } from "../account/ConnectionsProvider";
import AudienceReview from "../social/AudienceReview";
import RecipientPicker from "../social/RecipientPicker";
import { MAX_RECIPIENTS } from "../social/circles";
import { createPoll } from "./api";
import { usePolls } from "./PollsProvider";
import type { PollInput } from "./types";

interface TimeDraft { key: number; date: string; time: string }
interface Props { onPublished: () => void }

function todayInManila() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Manila",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

const initialOptions = (): TimeDraft[] => [
  { key: 1, date: "", time: "15:00" },
  { key: 2, date: "", time: "15:00" },
];

/** A local, account-scoped draft. Published audiences contain UUIDs, never circle IDs. */
export default function PollComposer({ onPublished }: Props) {
  const polls = usePolls();
  const connections = useConnections();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"details" | "audience">("details");
  const [title, setTitle] = useState("");
  const [place, setPlace] = useState("");
  const [kind, setKind] = useState<PollInput["kind"]>("coffee");
  const [options, setOptions] = useState(initialOptions);
  const [invitees, setInvitees] = useState<string[]>([]);
  const [error, setError] = useState("");
  const nextKey = useRef(3);
  const mounted = useRef(true);
  const owner = useRef(polls.userId);
  owner.current = polls.userId;
  const audienceButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const previousStep = useRef(step);
  const disabled = polls.busy || polls.refreshing || !polls.data || !!polls.error;
  const knownFriends = new Set(connections.data?.friends.map((person) => person.id));
  const selectionUnavailable = invitees.length > 0 && (
    invitees.length > MAX_RECIPIENTS || !connections.data || !!connections.error || connections.refreshing
    || invitees.some((id) => !knownFriends.has(id))
  );
  const audienceLabel = invitees.length ? `${invitees.length} friend${invitees.length === 1 ? "" : "s"}` : "Only me";
  const hasDraft = !!title.trim() || !!place.trim() || options.some((option) => option.date) || invitees.length > 0;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!connections.data || connections.error) return;
    const currentIds = new Set(connections.data.friends.map((person) => person.id));
    setInvitees((previous) => {
      const current = [...new Set(previous)].filter((id) => currentIds.has(id));
      return current.length === previous.length ? previous : current;
    });
  }, [connections.data, connections.error]);

  useEffect(() => {
    if (previousStep.current !== step) {
      if (step === "audience") backButton.current?.focus();
      else audienceButton.current?.focus();
      previousStep.current = step;
    }
  }, [step]);

  function close() {
    if (!polls.busy) setOpen(false);
  }

  function updateOption(key: number, field: "date" | "time", value: string) {
    setOptions((previous) => previous.map((option) => option.key === key ? { ...option, [field]: value } : option));
  }

  async function publish() {
    if (disabled) return;
    setError("");
    const times = options.map((option) => new Date(`${option.date}T${option.time}:00+08:00`));
    if (!title.trim() || !place.trim() || times.length < 2 || times.length > 5
      || times.some((date) => !Number.isFinite(date.valueOf()) || date.valueOf() <= Date.now())) {
      setError("Add a title, meeting place, and 2–5 future times in the Philippines.");
      return;
    }
    const optionTimes = times.map((date) => date.toISOString());
    if (new Set(optionTimes).size !== optionTimes.length) {
      setError("Choose a different date or time for each option.");
      return;
    }
    if (selectionUnavailable) {
      setError("Refresh your friends list and review the selected recipients before publishing.");
      return;
    }
    const actor = polls.userId;
    const current = () => mounted.current && owner.current === actor;
    const input: PollInput = { title: title.trim(), place: place.trim(), kind, option_times: optionTimes, invitee_ids: [...invitees] };
    try {
      await polls.run(() => createPoll(input));
      if (!current()) return;
      setTitle("");
      setPlace("");
      setKind("coffee");
      setOptions(initialOptions());
      nextKey.current = 3;
      setInvitees([]);
      setStep("details");
      setOpen(false);
      onPublished();
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "We couldn’t save this poll. Your draft is still here.");
    }
  }

  return <>
    <button type="button" className="button button-soft" disabled={disabled} onClick={() => { setOpen(true); setStep("details"); setError(""); }}>
      <Plus size={16} /> {hasDraft ? "Continue poll" : "Find a time"}
    </button>
    {open && <div className="poll-dialog-layer" onKeyDownCapture={(event) => {
      if (event.key === "Escape" && step === "audience") {
        event.preventDefault();
        event.stopPropagation();
        if (!polls.busy) setStep("details");
      }
    }}>
      <Modal title={step === "audience" ? "Choose poll audience" : "Create availability poll"} onClose={close}>
        {step === "audience" ? <div className="poll-composer-audience">
          <button ref={backButton} type="button" className="poll-back" disabled={polls.busy} onClick={() => setStep("details")}><ArrowLeft size={16} /> Back to poll</button>
          <RecipientPicker label="Invite friends" selected={invitees} onChange={setInvitees} disabled={disabled} />
          <button type="button" className="button button-primary" disabled={polls.busy} onClick={() => setStep("details")}>Done choosing audience</button>
        </div> : <form className="poll-composer" aria-label="Create an availability poll" onSubmit={(event) => { event.preventDefault(); void publish(); }}>
          <p className="social-muted">Suggest a few times. Your people can choose every option that works.</p>
          <button ref={audienceButton} type="button" className="poll-audience-button" disabled={disabled} aria-label={`Audience: ${audienceLabel}`} onClick={() => setStep("audience")}>
            {invitees.length ? <Users size={14} /> : <LockKeyhole size={14} />}{audienceLabel}<ChevronDown size={14} />
          </button>
          <label className="social-field">Poll title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={70} required disabled={disabled} placeholder="Coffee this weekend?" /></label>
          <label className="social-field">Meeting place<input value={place} onChange={(event) => setPlace(event.target.value)} maxLength={90} required disabled={disabled} placeholder="Where would you like to meet?" /></label>
          <fieldset className="poll-time-options" disabled={disabled}>
            <legend>Time options · Philippines</legend>
            {options.map((option, index) => <div className="poll-time-option" key={option.key}>
              <div className="poll-time-option-heading"><strong>Option {index + 1}</strong><button type="button" className="icon-button" aria-label={`Remove option ${index + 1}`} disabled={disabled || options.length <= 2} onClick={() => setOptions((previous) => previous.filter((item) => item.key !== option.key))}><X size={15} /></button></div>
              <div className="poll-time-fields">
                <label className="social-field">Date<input aria-label={`Option ${index + 1} date`} type="date" min={todayInManila()} value={option.date} onChange={(event) => updateOption(option.key, "date", event.target.value)} required /></label>
                <label className="social-field">Time<input aria-label={`Option ${index + 1} time (Philippines)`} type="time" value={option.time} onChange={(event) => updateOption(option.key, "time", event.target.value)} required /></label>
              </div>
            </div>)}
            <button type="button" className="button button-soft" disabled={disabled || options.length >= 5} onClick={() => {
              const option = { key: nextKey.current++, date: "", time: "15:00" };
              setOptions((previous) => [...previous, option]);
            }}><Plus size={14} /> Add time option</button>
            <p className="social-muted">Choose 2–5 different future times.</p>
          </fieldset>
          <label className="social-field">The vibe<select value={kind} onChange={(event) => setKind(event.target.value as PollInput["kind"])} disabled={disabled}><option value="coffee">Coffee & catch-up</option><option value="food">Good food</option><option value="trip">A little adventure</option></select></label>
          <AudienceReview selected={invitees} kind="poll" />
          {error && <p className="social-inline-error" role="alert">{error}</p>}
          <div className="poll-composer-actions"><button type="button" className="button button-soft" disabled={polls.busy} onClick={close}>Keep as draft</button><button type="submit" className="button button-primary" disabled={disabled || selectionUnavailable || !title.trim() || !place.trim() || options.some((option) => !option.date || !option.time)}>{polls.busy ? "Publishing…" : "Publish poll"}</button></div>
        </form>}
      </Modal>
    </div>}
  </>;
}
