import type { CalendarPlan } from "./calendar";

export interface PlanReminderPreference {
  plan_id: string;
  minutes_before: number[];
}

export interface RemindersSnapshot { reminders: PlanReminderPreference[] }

export interface PlanCalendarSnapshot {
  plan: CalendarPlan | null;
  reminder_minutes: number[];
}
