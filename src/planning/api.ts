import { supabase } from "../lib/supabase";
import { buildPlanCalendar } from "./calendar";
import type { PlanCalendarSnapshot, RemindersSnapshot } from "./types";

export class ReminderError extends Error {
  constructor(message: string, readonly setupRequired = false) {
    super(message);
    this.name = "ReminderError";
  }
}

export function reminderError(cause: unknown): ReminderError {
  if (cause instanceof ReminderError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new ReminderError("Calendar and reminder tools aren’t available yet. You can still use your plans.", true);
  }
  if (["42501", "P0001"].includes(code)) {
    return new ReminderError("This plan is no longer available or your access has changed. Refresh your plans and try again.");
  }
  if (["22023", "23514", "23503", "23505"].includes(code)) {
    return new ReminderError("Choose one-day or one-hour reminders whose time hasn’t passed, or turn your reminders off.");
  }
  if (["PGRST301", "PGRST302", "invalid_jwt"].includes(code)) {
    return new ReminderError("Please sign in again to load your personal reminders.");
  }
  return new ReminderError("We couldn’t reach your calendar and reminder tools. Please refresh and try again.");
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new ReminderError("Sign in to use calendar and reminder tools.");
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) { throw reminderError(cause); }
}

function validMinutes(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length
    && value.every((minutes) => minutes === 60 || minutes === 1440);
}

export async function fetchReminders(): Promise<RemindersSnapshot> {
  const data = await rpc<RemindersSnapshot>("plan_reminders_snapshot");
  if (!data || !Array.isArray(data.reminders) || data.reminders.some((item) => !item
    || typeof item.plan_id !== "string" || !validMinutes(item.minutes_before))) {
    throw new ReminderError("We couldn’t read your personal reminders. Please refresh.");
  }
  return data;
}

export const setPlanReminders = (id: string, minutes: number[]) =>
  rpc<void>("set_plan_reminders", { plan_id: id, reminder_minutes: [...minutes] });

/** Fetch current authorization and details for every export, never a cached card. */
export async function downloadPlanCalendar(id: string, canDownload: () => boolean): Promise<void> {
  const cancelled = () => new ReminderError("Your account or plan changed. Open the current plan before downloading.");
  if (!canDownload()) throw cancelled();
  const data = await rpc<PlanCalendarSnapshot>("plan_calendar_snapshot", { plan_id: id });
  if (!canDownload()) throw cancelled();
  if (!data || !data.plan) throw new ReminderError("This plan is no longer available. Refresh your plans before downloading.");
  if (data.plan.id !== id || !validMinutes(data.reminder_minutes)) throw new ReminderError("We couldn’t read this calendar event. Please refresh.");
  const contents = buildPlanCalendar(data.plan, data.reminder_minutes);
  // No asynchronous step may separate this final ownership/access check from
  // the file side effect. Old account responses must never export on a new one.
  if (!canDownload()) throw cancelled();
  const url = URL.createObjectURL(new Blob([contents], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `tara-plan-${data.plan.id}.ics`;
  link.hidden = true;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Keep the Blob alive long enough for mobile browsers to start the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
