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
};

const DAY_TO_ICAL: Record<string, string> = {
  Monday: "MO",
  Tuesday: "TU",
  Wednesday: "WE",
  Thursday: "TH",
  Friday: "FR",
  Saturday: "SA",
  Sunday: "SU",
};
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

// RFC 5545 requires folding lines longer than 75 octets, continued by a
// line starting with a single space.
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const width = first ? 75 : 74;
    chunks.push(rest.slice(0, width));
    rest = rest.slice(width);
    first = false;
  }
  return chunks.join("\r\n ");
}

function icsDate(date: Date, time: string): string {
  const [h, m] = time.split(":").map(Number);
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${mo}${d}T${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`;
}

// Next date (today included) that falls on the given Monday=0..Sunday=6 weekday.
function nextDateForWeekday(weekdayMon0: number): Date {
  const now = new Date();
  const todayMon0 = (now.getDay() + 6) % 7;
  const diff = (weekdayMon0 - todayMon0 + 7) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return d;
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function buildEvent(opts: {
  uid: string;
  summary: string;
  date: Date;
  time: string;
  location: string;
  url: string;
  day: string;
}): string {
  const dtstart = icsDate(opts.date, opts.time);
  const [h, m] = opts.time.split(":").map(Number);
  const endDate = new Date(opts.date);
  endDate.setHours(h, m + 15, 0, 0);
  const dtend = icsDate(endDate, `${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}`);
  const byday = DAY_TO_ICAL[opts.day];

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

  const kidDefaults = computeKidDefaults(carpool.members);
  const date = nextDateForWeekday(DAY_TO_MON0[carpool.day]);
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
          location,
          url,
          day: carpool.day,
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
    "X-WR-CALNAME:blisspool driving schedule",
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
