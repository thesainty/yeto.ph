import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCalendar } from "../src/planning/calendar.ts";

const NOW = new Date("2026-11-04T04:00:00.000Z");
const PLAN = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Kape at kwentuhan",
  place: "Makati café",
  starts_at: "2026-11-07T15:00:00+08:00",
  created_at: "2026-11-03T01:02:03.456+00:00",
};

function unfold(value) {
  return value.replace(/\r\n[ \t]/g, "");
}

function parsed(value) {
  const logicalLines = unfold(value).split("\r\n").filter(Boolean);
  const stack = [];
  const components = [];
  for (const line of logicalLines) {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `Invalid content line: ${line}`);
    const name = line.slice(0, separator);
    const content = line.slice(separator + 1);
    if (name === "BEGIN") {
      const component = { name: content, properties: [], children: [] };
      if (stack.length) stack.at(-1).children.push(component);
      else components.push(component);
      stack.push(component);
    } else if (name === "END") {
      assert.equal(stack.pop()?.name, content, "Calendar components must be balanced");
    } else {
      assert.ok(stack.length, "Every property belongs to a component");
      stack.at(-1).properties.push([name, content]);
    }
  }
  assert.equal(stack.length, 0);
  return components;
}

const properties = (component) => Object.fromEntries(component.properties);
const event = (value) => parsed(value)[0].children[0];

test("one private event preserves the saved instant and stable identity without inventing an end time", () => {
  const first = buildPlanCalendar(PLAN, [], NOW);
  assert.ok(first.endsWith("\r\n"));
  assert.equal(first.replaceAll("\r\n", "").includes("\n"), false);
  const calendars = parsed(first);
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0].name, "VCALENDAR");
  assert.deepEqual(properties(calendars[0]), {
    VERSION: "2.0", PRODID: "-//TARA//Plans//EN", CALSCALE: "GREGORIAN", METHOD: "PUBLISH",
  });
  assert.equal(calendars[0].children.length, 1);
  const plan = event(first);
  assert.equal(plan.name, "VEVENT");
  assert.deepEqual(plan.children, []);
  const details = properties(plan);
  assert.equal(details.DTSTART, "20261107T070000Z", "Philippines time exports as the same UTC instant");
  assert.equal(details.DTSTAMP, "20261104T040000Z");
  assert.equal(details.CREATED, "20261103T010203Z");
  assert.equal(details.UID, `${PLAN.id}@tara-together.vercel.app`);
  assert.equal(details.CLASS, "PRIVATE");
  assert.equal(details.URL, "https://tara-together.vercel.app/#plans");
  assert.equal(details.DTEND, undefined);
  assert.equal(details.DURATION, undefined);
  assert.match(details.DESCRIPTION, /copies.*do not update automatically/);
  const later = buildPlanCalendar(PLAN, [], new Date("2026-11-05T04:00:00Z"));
  assert.equal(properties(event(later)).UID, details.UID);
  assert.notEqual(properties(event(later)).DTSTAMP, details.DTSTAMP);
});

test("export whitelists plan fields and does not leak invitations, attendees, email, or credentials", () => {
  const data = buildPlanCalendar({
    ...PLAN,
    owner: { display_name: "Private Host", email: "private@example.com" },
    invitees: [{ id: "private-recipient", display_name: "Secret Friend" }],
    attendees: [{ display_name: "Private Attendee" }],
    access_token: "secret-access-token",
  }, [], NOW);
  for (const privateValue of ["Private Host", "private@example.com", "private-recipient", "Secret Friend", "Private Attendee", "secret-access-token"]) {
    assert.equal(data.includes(privateValue), false);
  }
  assert.equal(properties(event(data)).ATTENDEE, undefined);
  assert.equal(properties(event(data)).ORGANIZER, undefined);
});

test("text escaping prevents injected properties or calendar components", () => {
  const title = "Coffee, family; friends\\home\r\nEND:VEVENT\nBEGIN:VEVENT\rSUMMARY:Injected";
  const place = "Café, BGC; entrance\\two\nATTENDEE:intruder@example.com";
  const data = buildPlanCalendar({ ...PLAN, title, place }, [60], NOW);
  const calendar = parsed(data)[0];
  assert.equal(calendar.children.length, 1);
  const details = properties(calendar.children[0]);
  assert.equal(details.SUMMARY, "Coffee\\, family\\; friends\\\\home\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Injected");
  assert.equal(details.LOCATION, "Café\\, BGC\\; entrance\\\\two\\nATTENDEE:intruder@example.com");
  assert.equal(details.ATTENDEE, undefined);
  assert.equal(calendar.children[0].children.length, 1);
  assert.equal(calendar.children[0].children[0].name, "VALARM");
  assert.equal(data.split("\r\n").filter((line) => line === "BEGIN:VEVENT").length, 1);
});

test("long Filipino and emoji content folds to 75 UTF-8 octets and unfolds without losing characters", () => {
  const title = "Pamilya 👨‍👩‍👧‍👦 — Kwentuhan sa café, sama-sama; ".repeat(5);
  const place = "Bahay nina Nanay 🏠 at Tatay, Quezon City; tabi ng café ".repeat(4);
  const data = buildPlanCalendar({ ...PLAN, title, place }, [1440, 60], NOW);
  const lines = data.split("\r\n").filter(Boolean);
  assert.ok(lines.some((line) => line.startsWith(" ")), "Long lines use continuation whitespace");
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `A physical line is too long: ${Buffer.byteLength(line, "utf8")}`);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line)), line);
  }
  const details = properties(event(data));
  assert.equal(details.SUMMARY, title.replaceAll(",", "\\,").replaceAll(";", "\\;"));
  assert.equal(details.LOCATION, place.replaceAll(",", "\\,").replaceAll(";", "\\;"));
});

test("only explicitly chosen supported alarms are exported once at future trigger times", () => {
  const data = buildPlanCalendar(PLAN, [60, 1440, 60, 1440], NOW);
  const alarms = event(data).children;
  assert.equal(alarms.length, 2);
  assert.deepEqual(alarms.map((alarm) => properties(alarm).TRIGGER), ["-P1D", "-PT1H"]);
  for (const alarm of alarms) {
    assert.equal(alarm.name, "VALARM");
    assert.deepEqual(properties(alarm), { ACTION: "DISPLAY", DESCRIPTION: `TARA: ${PLAN.title}`, TRIGGER: properties(alarm).TRIGGER });
  }
  assert.deepEqual(event(buildPlanCalendar(PLAN, [], NOW)).children, []);
});

test("passed reminder deadlines are omitted without dropping the event", () => {
  const starts = new Date("2026-11-07T07:00:00Z");
  const oneDayBefore = new Date(starts.valueOf() - 1440 * 60_000);
  assert.deepEqual(event(buildPlanCalendar(PLAN, [1440, 60], oneDayBefore)).children.map((alarm) => properties(alarm).TRIGGER), ["-PT1H"]);
  const oneHourBefore = new Date(starts.valueOf() - 60 * 60_000);
  assert.deepEqual(event(buildPlanCalendar(PLAN, [1440, 60], oneHourBefore)).children, []);
  assert.equal(properties(event(buildPlanCalendar(PLAN, [60], starts))).DTSTART, "20261107T070000Z");
  const fraction = { ...PLAN, starts_at: "2026-11-07T07:00:00.999Z" };
  assert.deepEqual(event(buildPlanCalendar(fraction, [60], new Date("2026-11-07T06:00:00.100Z"))).children, []);
});

test("invalid identifiers, timestamps, reminder choices and unsupported control characters never produce a file", () => {
  for (const id of ["", "two words", "a@other-domain.test", "ok\r\nBEGIN:VEVENT", "a".repeat(129), null]) {
    assert.throws(() => buildPlanCalendar({ ...PLAN, id }, [], NOW), /identifier/);
  }
  for (const starts_at of ["not-a-time", "2026-11-07T15:00:00", "2026-02-30T07:00:00Z", "2026-11-07T24:00:00Z", "0000-11-07T07:00:00Z", "9999-12-31T23:59:59-23:59", null]) {
    assert.throws(() => buildPlanCalendar({ ...PLAN, starts_at }, [], NOW), /time/);
  }
  assert.throws(() => buildPlanCalendar({ ...PLAN, created_at: "Infinity" }, [], NOW), /time/);
  assert.throws(() => buildPlanCalendar(PLAN, [], new Date("invalid")), /time/);
  for (const reminders of [[0], [-60], [30], [60.5], ["60"], [NaN], null]) {
    assert.throws(() => buildPlanCalendar(PLAN, reminders, NOW), /reminder/);
  }
  for (const title of ["", "   ", "Bad\u0000text", "Bad\ud800text"]) {
    assert.throws(() => buildPlanCalendar({ ...PLAN, title }, [], NOW), /details/);
  }
});
