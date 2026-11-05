export interface CalendarPlan {
  id: string;
  title: string;
  place: string;
  starts_at: string;
  created_at: string;
}

const encoder = new TextEncoder();
const calendarDescription = "A TARA plan. Calendar events are copies and do not update automatically. Remove this copy if the plan is cancelled or you no longer have access.";

function calendarDate(value: string): Date {
  // Require an explicit zone; a phone's local zone must never reinterpret the
  // saved Philippines time. PostgreSQL returns these ISO timestamps with a zone.
  const parts = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw new Error("This plan has an invalid calendar time.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const date = new Date(value);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(date.valueOf())
    || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new Error("This plan has an invalid calendar time.");
  }
  return date;
}

function utc(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function text(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error("This plan has invalid calendar details.");
  }
  for (const character of value) {
    if (character.length === 1 && /[\ud800-\udfff]/.test(character)) throw new Error("This plan has invalid calendar details.");
  }
  return value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

/** RFC 5545 content lines fold at 75 octets, including continuation whitespace. */
function fold(line: string): string {
  const lines: string[] = [];
  let current = "";
  let size = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > 75) {
      lines.push(current);
      current = " ";
      size = 1;
    }
    current += character;
    size += bytes;
  }
  lines.push(current);
  return lines.join("\r\n");
}

/** Export one authorized plan, with no account credentials or audience data. */
export function buildPlanCalendar(plan: CalendarPlan, reminderMinutes: number[], now = new Date()): string {
  if (!plan || typeof plan.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(plan.id)) {
    throw new Error("This plan has an invalid calendar identifier.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || now.getUTCFullYear() < 1 || now.getUTCFullYear() > 9999) {
    throw new Error("The calendar export time is invalid.");
  }
  if (!Array.isArray(reminderMinutes) || reminderMinutes.some((minutes) => minutes !== 60 && minutes !== 1440)) {
    throw new Error("Choose a one-day or one-hour calendar reminder.");
  }
  const startsAt = calendarDate(plan.starts_at);
  const createdAt = calendarDate(plan.created_at);
  const summary = text(plan.title);
  const location = text(plan.place);
  const alarmDescription = text(`TARA: ${plan.title}`);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TARA//Plans//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${plan.id}@tara-together.vercel.app`, `DTSTAMP:${utc(now)}`,
    `CREATED:${utc(createdAt)}`, `DTSTART:${utc(startsAt)}`, `SUMMARY:${summary}`, `LOCATION:${location}`,
    `DESCRIPTION:${text(calendarDescription)}`, "CLASS:PRIVATE", "URL:https://tara-together.vercel.app/#plans",
  ];
  // iCalendar has second precision. Do not export a reminder whose serialized
  // trigger is already due, even if the source timestamp had fractional seconds.
  const serializedStart = Math.floor(startsAt.valueOf() / 1000) * 1000;
  for (const minutes of [...new Set(reminderMinutes)].sort((a, b) => b - a)) {
    if (serializedStart - minutes * 60_000 <= now.valueOf()) continue;
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${alarmDescription}`,
      `TRIGGER:${minutes === 1440 ? "-P1D" : "-PT1H"}`, "END:VALARM");
  }
  // The app has no end time; inventing a duration would misrepresent the plan.
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
