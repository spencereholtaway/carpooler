import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Member = {
  id: string;
  name: string;
  seats: number;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
  street: string;
  zip: string;
  coparentId?: string | null;
};
type Car = { driverId: string; kids: string[] };
type Leg = { time: string; cars: Car[] };
type Address = { street: string; zip: string };
type Carpool = {
  code: string;
  name: string;
  day: string;
  destination: Address;
  dropOff: Leg;
  pickUp: Leg;
  members: Member[];
  createdAt: number;
  timezone?: string;
};

const DEFAULT_TIMEZONE = "America/Los_Angeles";

// Monday = 0 .. Sunday = 6, matching src/types.ts's DAYS_OF_WEEK order.
const DAY_TO_MON0: Record<string, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
};

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// Same "own your kid by default" resolution CarpoolDetail/summarizeCarpool
// use client-side — duplicated here since netlify functions in this repo
// don't share modules with src/ (see carpools.mts for the same pattern).
function computeKidDefaults(members: Member[]): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const m of members) {
    for (const k of m.kids) {
      if (!defaults.has(k)) defaults.set(k, m.id);
    }
  }
  return defaults;
}

function resolveKidDrivers(
  cars: Car[],
  members: Member[],
  kidDefaults: Map<string, string>
): Map<string, string> {
  const kidToDriver = new Map<string, string>();
  for (const car of cars) for (const k of car.kids) kidToDriver.set(k, car.driverId);

  const assignedElsewhere = new Set(kidToDriver.keys());
  for (const m of members) {
    if (cars.some((c) => c.driverId === m.id)) continue;
    for (const k of m.kids) {
      if (!assignedElsewhere.has(k) && kidDefaults.get(k) === m.id) kidToDriver.set(k, m.id);
    }
  }
  return kidToDriver;
}

function groupKidsByDriver(kidToDriver: Map<string, string>): Map<string, string[]> {
  const byDriver = new Map<string, string[]>();
  for (const [kid, driverId] of kidToDriver) {
    if (!byDriver.has(driverId)) byDriver.set(driverId, []);
    byDriver.get(driverId)!.push(kid);
  }
  return byDriver;
}

// RFC 5545 TEXT escaping.
function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// RFC 5545 requires folding lines longer than 75 *octets*, continued by a
// line starting with a single space. Carpool/kid names can contain emoji,
// so this has to split on UTF-8 byte boundaries — slicing the JS string by
// character count can (and did) cut a multi-byte character in half and
// corrupt the feed, which Google's stricter ICS parser then rejected
// outright while Apple's silently tolerated the garbage.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function foldLine(line: string): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const width = first ? 75 : 74;
    let end = Math.min(start + width, bytes.length);
    // Back off until `end` isn't in the middle of a multi-byte UTF-8
    // sequence (continuation bytes match 10xxxxxx, i.e. 0x80-0xBF).
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.slice(start, end)));
    start = end;
    first = false;
  }
  return chunks.join("\r\n ");
}

// A carpool's schedule is a wall-clock time in that carpool's own timezone
// (e.g. "4pm in LA"), not a floating time. Google Calendar's subscribe-by-URL
// importer treats a floating DTSTART (no Z, no TZID) as UTC and then
// re-renders it in the viewer's own zone — silently shifting the displayed
// time by that zone's UTC offset. Converting to a real UTC instant up front
// (DTSTART...Z) sidesteps that ambiguity entirely; both Apple and Google
// render an absolute instant identically.
type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

const WEEKDAY_SHORT_TO_MON0: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

// UTC-minus-local offset (minutes) that `timeZone` observes at `utcMillis`.
function timeZoneOffsetMinutes(utcMillis: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMillis), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return (asUtc - utcMillis) / 60000;
}

// Convert a wall-clock y/mo/d h:mi as observed in `timeZone` to the UTC instant it represents.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = timeZoneOffsetMinutes(naiveUtc, timeZone);
  return new Date(naiveUtc - offset * 60000);
}

function icsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Next date (today included) that falls on the given Monday=0..Sunday=6
// weekday, as observed in `timeZone` (not the server's own zone).
function nextDateForWeekday(weekdayMon0: number, timeZone: string): { year: number; month: number; day: number } {
  const now = zonedParts(new Date(), timeZone);
  const todayMon0 = WEEKDAY_SHORT_TO_MON0[now.weekday];
  const diff = (weekdayMon0 - todayMon0 + 7) % 7;
  // Anchor at UTC noon so adding days never crosses a local-date boundary.
  const anchor = new Date(Date.UTC(now.year, now.month - 1, now.day + diff, 12));
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
}

function utcStamp(): string {
  return icsUtc(new Date());
}

const UTC_DAY_TO_ICAL = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function buildEvent(opts: {
  uid: string;
  summary: string;
  date: { year: number; month: number; day: number };
  time: string;
  timezone: string;
  location: string;
  url: string;
}): string {
  const [h, m] = opts.time.split(":").map(Number);
  const start = zonedTimeToUtc(opts.date.year, opts.date.month, opts.date.day, h, m, opts.timezone);
  const dtstart = icsUtc(start);
  const dtend = icsUtc(new Date(start.getTime() + 15 * 60000));
  // DTSTART is a bare UTC instant (no TZID), so per RFC 5545 the RRULE is
  // evaluated in UTC too — BYDAY must match DTSTART's *UTC* weekday, not the
  // carpool's local one. An evening Pacific time converts to the next UTC
  // calendar day, so using the local day here (e.g. "TU" for a Tuesday
  // practice) silently mismatches DTSTART's real UTC weekday (Wednesday);
  // calendar apps then generate every recurrence *after* the first from the
  // BYDAY rule, landing one day earlier in local time (Monday instead of
  // Tuesday) even though the very first occurrence looked correct.
  const byday = UTC_DAY_TO_ICAL[start.getUTCDay()];

  const lines = [
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${utcStamp()}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${byday}`,
    `SUMMARY:${escapeText(opts.summary)}`,
    ...(opts.location ? [`LOCATION:${escapeText(opts.location)}`] : []),
    `DESCRIPTION:${escapeText(`Open in blisspool: ${opts.url}`)}`,
    `URL:${opts.url}`,
    "END:VEVENT",
  ];
  return lines.map(foldLine).join("\r\n");
}

function buildEventsForCarpool(carpool: Carpool, memberId: string, origin: string): string[] {
  if (!(carpool.day in DAY_TO_MON0)) return [];
  const self = carpool.members.find((m) => m.id === memberId);
  if (!self) return [];

  const timezone = carpool.timezone || DEFAULT_TIMEZONE;
  const kidDefaults = computeKidDefaults(carpool.members);
  const date = nextDateForWeekday(DAY_TO_MON0[carpool.day], timezone);
  const location = [carpool.destination?.street, carpool.destination?.zip].filter(Boolean).join(", ");
  const url = `${origin}/?carpool=${carpool.code}`;

  const events: string[] = [];
  for (const [legName, leg] of [
    ["dropOff", carpool.dropOff],
    ["pickUp", carpool.pickUp],
  ] as const) {
    if (!leg?.time) continue;

    const kidToDriver = resolveKidDrivers(leg.cars ?? [], carpool.members, kidDefaults);
    const byDriver = groupKidsByDriver(kidToDriver);

    for (const [driverId, kids] of byDriver) {
      let summary: string;
      if (driverId === memberId) {
        summary =
          legName === "dropOff"
            ? `Drive ${joinList(kids)} to ${carpool.name}`
            : `Pick up ${joinList(kids)} from ${carpool.name}`;
      } else {
        const relevantKids = kids.filter((k) => self.kids.includes(k));
        if (relevantKids.length === 0) continue;
        const driverName = carpool.members.find((m) => m.id === driverId)?.name ?? "Someone";
        summary =
          legName === "dropOff"
            ? `${driverName} is driving ${joinList(relevantKids)} to ${carpool.name}`
            : `${driverName} is picking up ${joinList(relevantKids)} from ${carpool.name}`;
      }

      events.push(
        buildEvent({
          uid: `${carpool.code}-${legName}-${driverId}@blisspool`,
          summary,
          date,
          time: leg.time,
          timezone,
          location,
          url,
        })
      );
    }
  }
  return events;
}

export default async (req: Request) => {
  const memberId = new URL(req.url).searchParams.get("memberId");
  if (!memberId) return new Response("Missing memberId", { status: 400 });

  const store = getStore("carpools", { consistency: "strong" });
  const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
  const carpools = (
    await Promise.all(codes.map((code) => store.get(`code:${code}`, { type: "json" })))
  ).filter(Boolean) as Carpool[];

  const origin = new URL(req.url).origin;
  const events = carpools.flatMap((c) => buildEventsForCarpool(c, memberId, origin));

  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//blisspool//carpool calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:blisspools",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...events,
    "END:VCALENDAR",
  ]
    .map(foldLine)
    .join("\r\n");

  return new Response(calendar, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, max-age=3600",
    },
  });
};

export const config: Config = {
  path: "/api/calendar",
};
