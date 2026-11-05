import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, CalendarPlus, Clock3, Download, MapPin, RefreshCw } from "lucide-react";
import { Modal } from "../components/ui";
import type { SocialPlan } from "../social/types";
import { downloadPlanCalendar, setPlanReminders } from "./api";
import { useReminders } from "./RemindersProvider";
import "./planning.css";

interface Props {
  plan: SocialPlan;
  disabled: boolean;
}

const reminderChoices = [
  { minutes: 1440, label: "1 day before" },
  { minutes: 60, label: "1 hour before" },
];
const planDate = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila",
});

function PlanToolsContents({ plan, disabled }: Props) {
  const reminders = useReminders();
  const saved = reminders.data?.reminders.find((item) => item.plan_id === plan.id)?.minutes_before ?? [];
  const savedKey = JSON.stringify([...saved].sort((a, b) => a - b));
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>(() => JSON.parse(savedKey) as number[]);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState<"saving" | "downloading" | null>(null);
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const mounted = useRef(true);
  const owner = useRef(reminders.userId);
  owner.current = reminders.userId;
  const available = !disabled && !!reminders.data && !reminders.error;
  const accessAvailable = useRef(available);
  accessAvailable.current = available;
  const pending = working !== null || reminders.busy;
  const editingDisabled = pending || disabled || reminders.refreshing || !reminders.data || !!reminders.error;
  const startsAt = new Date(plan.starts_at).valueOf();
  const started = startsAt <= Date.now();

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!dirty) setSelected(JSON.parse(savedKey) as number[]);
  }, [savedKey, dirty]);

  function show() {
    setSelected(JSON.parse(savedKey) as number[]);
    setDirty(false);
    setMessage("");
    setLocalError("");
    setOpen(true);
  }

  function close() {
    if (!pending) setOpen(false);
  }

  async function save() {
    if (editingDisabled || !dirty) return;
    setMessage("");
    setLocalError("");
    if (selected.some((minutes) => !saved.includes(minutes) && startsAt - minutes * 60_000 <= Date.now())) {
      setLocalError("That reminder time has already passed. Choose a later reminder or turn it off.");
      return;
    }
    const actor = reminders.userId;
    const current = () => mounted.current && owner.current === actor;
    setWorking("saving");
    try {
      await reminders.run(() => setPlanReminders(plan.id, [...selected]));
      if (!current()) return;
      setDirty(false);
      setMessage("Your reminder choices were saved.");
    } catch (cause) {
      if (current()) setLocalError(cause instanceof Error ? cause.message : "We couldn’t save your reminder choices. Please try again.");
    } finally {
      if (current()) setWorking(null);
    }
  }

  async function download() {
    if (editingDisabled || dirty) return;
    const actor = reminders.userId;
    const current = () => mounted.current && owner.current === actor;
    setMessage("");
    setLocalError("");
    setWorking("downloading");
    try {
      await downloadPlanCalendar(plan.id, () => current() && accessAvailable.current);
      if (current()) setMessage("Calendar file ready. Open it in your calendar app to add the event.");
    } catch (cause) {
      if (current()) setLocalError(cause instanceof Error ? cause.message : "We couldn’t create the calendar file. Please try again.");
    } finally {
      if (current()) setWorking(null);
    }
  }

  return <>
    <div className="plan-tools" role="group" aria-label={`Calendar and reminders for ${plan.title}`}>
      <button type="button" className="plan-tool-button" disabled={disabled || pending} onClick={show}><CalendarPlus size={15} />Add to calendar</button>
      <button type="button" className={`plan-tool-button${saved.length ? " plan-tool-enabled" : ""}`} disabled={disabled || pending} onClick={show}><Bell size={15} />{saved.length ? "Reminders on" : "Remind me"}</button>
    </div>
    {open && <Modal title="Calendar & reminders" onClose={close}>
      <div className="plan-tools-dialog">
        <section className="plan-tools-summary" aria-label="Selected plan">
          <h3>{plan.title}</h3>
          <p><MapPin size={14} />{plan.place}</p>
          <p><Clock3 size={14} />{planDate.format(new Date(plan.starts_at))} (Philippines)</p>
        </section>
        <section className="plan-reminder-settings" aria-label="Personal reminders">
          <h3><Bell size={17} />Remind me in TARA</h3>
          <p className="social-muted">Only you can see these choices. Reminders appear in your TARA inbox.</p>
          {reminders.error ? <div className="plan-tools-error" role="alert"><p>{reminders.error}</p><button type="button" className="button button-soft" disabled={pending || reminders.refreshing} onClick={() => { setLocalError(""); void reminders.refresh(); }}><RefreshCw size={14} />Refresh reminders</button></div>
            : !reminders.data ? <p className="social-muted" role="status">Loading your reminder choices…</p> : <>
              <fieldset className="plan-reminder-options" disabled={editingDisabled}>
                <legend className="sr-only">Choose personal reminder times</legend>
                {reminderChoices.map(({ minutes, label }) => {
                  const passed = startsAt - minutes * 60_000 <= Date.now();
                  const checked = selected.includes(minutes);
                  return <label className={`plan-reminder-option${checked ? " plan-reminder-selected" : ""}`} key={minutes}>
                    <input type="checkbox" checked={checked} aria-label={label} disabled={editingDisabled || (passed && !checked)} onChange={(event) => {
                      setSelected((previous) => event.target.checked ? [...previous.filter((value) => value !== minutes), minutes] : previous.filter((value) => value !== minutes));
                      setDirty(true);
                      setMessage("");
                      setLocalError("");
                    }} />
                    <span><strong>{label}</strong>{passed && <small>This reminder time has passed.</small>}</span>
                  </label>;
                })}
              </fieldset>
              {started && <p className="social-muted">This plan has started. You can turn off existing reminders.</p>}
              <div className="plan-tools-actions">
                {dirty && <button type="button" className="button button-soft" disabled={pending} onClick={() => { setSelected(JSON.parse(savedKey) as number[]); setDirty(false); setLocalError(""); }}>Discard changes</button>}
                <button type="button" className="button button-primary" disabled={editingDisabled || !dirty} onClick={() => void save()}>{working === "saving" ? "Saving…" : "Save reminders"}</button>
              </div>
            </>}
        </section>
        <section className="plan-calendar-export" aria-label="Calendar event">
          <h3><CalendarPlus size={17} />Your calendar</h3>
          <p className="social-muted">Download a calendar event for this plan. It includes your saved reminder choices as calendar alerts that are still in the future.</p>
          <button type="button" className="button button-soft" disabled={editingDisabled || dirty} onClick={() => void download()}><Download size={15} />{working === "downloading" ? "Preparing calendar…" : "Download calendar event"}</button>
          {dirty && <p className="plan-tools-note">Save or discard your reminder changes before downloading.</p>}
          <p className="plan-tools-note">Calendar events are copies and won’t update automatically. Remove the copy if the plan is cancelled.</p>
        </section>
        {localError && <p className="plan-tools-error" role="alert">{localError}</p>}
        {message && <p className="social-message" role="status">{message}</p>}
      </div>
    </Modal>}
  </>;
}

/** Account changes discard unsaved choices and invalidate pending UI feedback. */
export default function PlanTools(props: Props) {
  const { userId } = useReminders();
  return <PlanToolsContents key={`${userId ?? "anonymous"}:${props.plan.id}`} {...props} />;
}
