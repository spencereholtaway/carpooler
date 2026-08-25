import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Member = {
  id: string;
  name: string;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
  street: string;
  zip: string;
  coparentId?: string | null;
};
type Car = { driverId: string; kids: string[]; seats: number };
type Leg = { time: string; cars: Car[] };
type Address = { street: string; zip: string };

const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
type DayOfWeek = (typeof DAYS_OF_WEEK)[number];
const DAY_INDEX: Record<DayOfWeek, number> = Object.fromEntries(DAYS_OF_WEEK.map((d, i) => [d, i])) as Record<
  DayOfWeek,
  number
>;

type RecurrenceType = "weekly" | "biweekly" | "oneoff";
type RecurrenceEra = {
  startDate: string;
  endDate: string | null;
  type: RecurrenceType;
  daysOfWeek: DayOfWeek[];
  defaultDropOff: Leg;
  defaultPickUp: Leg;
};
type CarpoolSeries = {
  code: string;
  name: string;
  destination: Address;
  recurrenceEras: RecurrenceEra[];
  members: Member[];
  createdAt: number;
  timezone: string;
};
type CarpoolOccurrence = {
  code: string;
  date: string;
  dropOff: Leg;
  pickUp: Leg;
  overridden: { dropOff: boolean; pickUp: boolean };
  historized: boolean;
  // Kids not participating in this specific occurrence (e.g. a trip that
  // day) — removed from every car on both legs; excluded from the
  // unclaimed-kid-defaults-to-own-parent fallback everywhere it's computed.
  skippedKids?: string[];
  generatedAt: number;
};
type LegacyCarpool = {
  code: string;
  name: string;
  day: string;
  destination: Address;
  dropOff: Leg;
  pickUp: Leg;
  members: Member[];
  createdAt: number;
  timezone: string;
};

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const GENERATION_HORIZON_DAYS = 56;

// ---- date helpers + migration/generation (see carpools.mts for the fuller
// comments — duplicated here per this repo's no-shared-modules convention) ----
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekdayIndexISO(iso: string): number {
  return (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
}
function mondayOfISO(iso: string): string {
  return addDaysISO(iso, -weekdayIndexISO(iso));
}
function weeksBetweenMondays(a: string, b: string): number {
  return Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / (7 * 86400000));
}
function nextDateForWeekday(day: DayOfWeek): string {
  const today = todayISO();
  const diff = (DAY_INDEX[day] - weekdayIndexISO(today) + 7) % 7;
  return addDaysISO(today, diff);
}
function generateDatesForEra(era: RecurrenceEra, horizonEndISO: string): string[] {
  if (era.type === "oneoff") return [era.startDate];
  const today = todayISO();
  const scanStart = isoCompare(era.startDate, today) > 0 ? era.startDate : today;
  const scanEnd = era.endDate && isoCompare(era.endDate, horizonEndISO) < 0 ? era.endDate : horizonEndISO;
  if (isoCompare(scanStart, scanEnd) > 0) return [];
  const eraMonday = mondayOfISO(era.startDate);
  const wantedDays = new Set(era.daysOfWeek.map((d) => DAY_INDEX[d]));
  const dates: string[] = [];
  for (let d = scanStart; isoCompare(d, scanEnd) <= 0; d = addDaysISO(d, 1)) {
    if (!wantedDays.has(weekdayIndexISO(d))) continue;
    if (era.type === "biweekly" && weeksBetweenMondays(mondayOfISO(d), eraMonday) % 2 !== 0) continue;
    dates.push(d);
  }
  return dates;
}
function isLegacyShape(blob: unknown): blob is LegacyCarpool {
  return !!blob && typeof blob === "object" && "day" in (blob as object) && !("recurrenceEras" in (blob as object));
}
function migrateLegacyCarpool(legacy: LegacyCarpool): CarpoolSeries {
  const day = (DAYS_OF_WEEK as readonly string[]).includes(legacy.day) ? (legacy.day as DayOfWeek) : "Monday";
  return {
    code: legacy.code,
    name: legacy.name,
    destination: legacy.destination,
    recurrenceEras: [
      {
        startDate: nextDateForWeekday(day),
        endDate: null,
        type: "weekly",
        daysOfWeek: [day],
        defaultDropOff: legacy.dropOff,
        defaultPickUp: legacy.pickUp,
      },
    ],
    members: legacy.members,
    createdAt: legacy.createdAt,
    timezone: legacy.timezone || DEFAULT_TIMEZONE,
  };
}
async function generateOccurrences(store: ReturnType<typeof getStore>, series: CarpoolSeries): Promise<void> {
  const horizonEnd = addDaysISO(todayISO(), GENERATION_HORIZON_DAYS);
  for (const era of series.recurrenceEras) {
    const dates = generateDatesForEra(era, horizonEnd);
    await Promise.all(
      dates.map(async (date) => {
        const occKey = `occ:${series.code}:${date}`;
        if (await store.get(occKey, { type: "json" })) return;
        const occurrence: CarpoolOccurrence = {
          code: series.code,
          date,
          dropOff: { time: era.defaultDropOff.time, cars: era.defaultDropOff.cars.map((c) => ({ ...c, kids: [...c.kids] })) },
          pickUp: { time: era.defaultPickUp.time, cars: era.defaultPickUp.cars.map((c) => ({ ...c, kids: [...c.kids] })) },
          overridden: { dropOff: false, pickUp: false },
          historized: false,
          skippedKids: [],
          generatedAt: Date.now(),
        };
        await store.setJSON(occKey, occurrence);
      })
    );
  }
}
async function listOccurrences(store: ReturnType<typeof getStore>, code: string): Promise<CarpoolOccurrence[]> {
  const { blobs } = await store.list({ prefix: `occ:${code}:` });
  const occs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return occs.filter(Boolean) as CarpoolOccurrence[];
}
async function loadSeries(store: ReturnType<typeof getStore>, code: string): Promise<CarpoolSeries | null> {
  const raw = await store.get(`code:${code}`, { type: "json" });
  if (!raw) return null;
  let series: CarpoolSeries;
  if (isLegacyShape(raw)) {
    series = migrateLegacyCarpool(raw);
    await store.setJSON(`code:${code}`, series);
  } else {
    series = raw as CarpoolSeries;
  }
  await generateOccurrences(store, series);
  return series;
}

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

function utcStamp(): string {
  return icsUtc(new Date());
}

function parseISODate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

// One standalone VEVENT per occurrence — no RRULE at all. Every date this
// carpool actually runs on is already materialized as its own
// CarpoolOccurrence (including any per-date override), so there's no
// recurrence rule to reconstruct and no BYDAY/UTC-weekday phase-matching to
// get subtly wrong (a real bug this file used to have, per the comment that
// used to live on this function). The only tradeoff is the feed only shows
// occurrences within the app's generation horizon (currently 8 weeks) until
// someone next opens the app to top up further ones — an acceptable trade
// given the hourly refresh interval below and that generation already
// happens opportunistically on every read.
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

  const lines = [
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${utcStamp()}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeText(opts.summary)}`,
    ...(opts.location ? [`LOCATION:${escapeText(opts.location)}`] : []),
    `DESCRIPTION:${escapeText(`Open in blisspool: ${opts.url}`)}`,
    `URL:${opts.url}`,
    "END:VEVENT",
  ];
  return lines.map(foldLine).join("\r\n");
}

function buildEventsForOccurrence(
  series: CarpoolSeries,
  occurrence: CarpoolOccurrence,
  memberId: string,
  origin: string
): string[] {
  const self = series.members.find((m) => m.id === memberId);
  if (!self) return [];

  const timezone = series.timezone || DEFAULT_TIMEZONE;
  const kidDefaults = computeKidDefaults(series.members);
  const date = parseISODate(occurrence.date);
  const location = [series.destination?.street, series.destination?.zip].filter(Boolean).join(", ");
  const url = `${origin}/?carpool=${series.code}`;

  const events: string[] = [];
  for (const [legName, leg] of [
    ["dropOff", occurrence.dropOff],
    ["pickUp", occurrence.pickUp],
  ] as const) {
    if (!leg?.time) continue;

    const kidToDriver = resolveKidDrivers(leg.cars ?? [], series.members, kidDefaults);
    const byDriver = groupKidsByDriver(kidToDriver);

    for (const [driverId, kids] of byDriver) {
      let summary: string;
      if (driverId === memberId) {
        summary =
          legName === "dropOff"
            ? `Drive ${joinList(kids)} to ${series.name}`
            : `Pick up ${joinList(kids)} from ${series.name}`;
      } else {
        const relevantKids = kids.filter((k) => self.kids.includes(k));
        if (relevantKids.length === 0) continue;
        const driverName = series.members.find((m) => m.id === driverId)?.name ?? "Someone";
        summary =
          legName === "dropOff"
            ? `${driverName} is driving ${joinList(relevantKids)} to ${series.name}`
            : `${driverName} is picking up ${joinList(relevantKids)} from ${series.name}`;
      }

      events.push(
        buildEvent({
          uid: `${series.code}-${occurrence.date}-${legName}-${driverId}@blisspool`,
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

  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });
  const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
  const seriesList = (await Promise.all(codes.map((code) => loadSeries(store, code)))).filter(
    Boolean
  ) as CarpoolSeries[];

  const origin = new URL(req.url).origin;
  const events = (
    await Promise.all(
      seriesList.map(async (series) => {
        const occurrences = await listOccurrences(store, series.code);
        return occurrences.flatMap((occ) => buildEventsForOccurrence(series, occ, memberId, origin));
      })
    )
  ).flat();

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
