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
type ServerProfile = { name: string; kids: string[]; street: string; zip: string };
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
type OccurrenceOverrides = { dropOff: boolean; pickUp: boolean };
type CarpoolOccurrence = {
  code: string;
  date: string;
  dropOff: Leg;
  pickUp: Leg;
  overridden: OccurrenceOverrides;
  historized: boolean;
  // Kids not participating in this specific occurrence (e.g. a trip that
  // day) — removed from every car on both legs; excluded from the
  // unclaimed-kid-defaults-to-own-parent fallback everywhere it's computed.
  skippedKids?: string[];
  generatedAt: number;
};

// Legacy shape, still possibly sitting in storage under `code:{code}` for any
// carpool nobody has opened since this migration shipped.
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
const GENERATION_HORIZON_DAYS = 56; // 8 weeks ahead (4 real occurrences for a biweekly carpool)

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---- date helpers (calendar-date arithmetic only, no time-of-day) ----
// NOTE: "today" here is derived from the server's own UTC clock rather than
// each carpool's own timezone (unlike calendar.mts's more careful
// zonedParts). That's an acceptable approximation for "which week does
// generation start from" but could misjudge a carpool right at a midnight
// boundary in a very different timezone from the server — worth revisiting
// if that ever turns out to matter in practice.
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekdayIndexISO(iso: string): number {
  // getUTCDay is Sun=0..Sat=6; convert to Monday=0..Sunday=6 to match DAY_INDEX.
  return (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
}
function mondayOfISO(iso: string): string {
  return addDaysISO(iso, -weekdayIndexISO(iso));
}
function isoCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function weeksBetweenMondays(a: string, b: string): number {
  return Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / (7 * 86400000));
}

// Every date within [today, horizon] (clipped to the era's own range) that
// this era should generate an occurrence for.
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

function nextDateForWeekday(day: DayOfWeek): string {
  const today = todayISO();
  const diff = (DAY_INDEX[day] - weekdayIndexISO(today) + 7) % 7;
  return addDaysISO(today, diff);
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
        // Verbatim copy — this is what makes the migration invisible to
        // whoever's already driving; nobody's current assignment changes.
        defaultDropOff: legacy.dropOff,
        defaultPickUp: legacy.pickUp,
      },
    ],
    members: legacy.members,
    createdAt: legacy.createdAt,
    timezone: legacy.timezone || DEFAULT_TIMEZONE,
  };
}

// Creates any occurrence blobs that don't exist yet for dates within the
// generation horizon. Never touches an occurrence that's already there,
// overridden or not — this is purely additive top-up.
async function generateOccurrences(store: ReturnType<typeof getStore>, series: CarpoolSeries): Promise<void> {
  const horizonEnd = addDaysISO(todayISO(), GENERATION_HORIZON_DAYS);
  for (const era of series.recurrenceEras) {
    const dates = generateDatesForEra(era, horizonEnd);
    await Promise.all(
      dates.map(async (date) => {
        const occKey = `occ:${series.code}:${date}`;
        const existing = await store.get(occKey, { type: "json" });
        if (existing) return;
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

// Reads a carpool by code, migrating it in place if it's still the legacy
// shape, then tops up its occurrences. This is the one place a `code:{code}`
// blob gets converted — every other reader of a series should already be
// past this point.
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

// If this member has a linked co-parent who shares one of the kids just
// assigned, add the co-parent too — but never mark them as able to drive,
// that's always a separate, explicit choice each person makes for themselves.
async function autoAddCoParent(
  store: ReturnType<typeof getStore>,
  carpool: CarpoolSeries,
  actingMemberId: string,
  assignedKids: string[]
) {
  const coParentId = (await store.get(`coparent:${actingMemberId}`)) as string | null;
  if (!coParentId || carpool.members.some((m) => m.id === coParentId)) return;

  const coProfile = (await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null;
  if (!coProfile) return;

  const sharedKids = assignedKids.filter((k) => coProfile.kids.includes(k));
  if (sharedKids.length === 0) return;

  carpool.members.push({
    id: coParentId,
    name: coProfile.name,
    kids: sharedKids,
    canDriveDropOff: false,
    canDrivePickUp: false,
    street: coProfile.street,
    zip: coProfile.zip,
    coparentId: actingMemberId,
  });

  const existing = ((await store.get(`member:${coParentId}`, { type: "json" })) as string[] | null) ?? [];
  if (!existing.includes(carpool.code)) {
    await store.setJSON(`member:${coParentId}`, [...existing, carpool.code]);
  }
}

type CreateBody = {
  name: string;
  destination: Address;
  member: Member;
  timezone?: string;
  dropOff: Leg;
  pickUp: Leg;
  // New shape.
  recurrence?: { type: RecurrenceType; daysOfWeek?: DayOfWeek[]; startDate: string };
  // Legacy shape, still accepted so an un-migrated Create form keeps working
  // (translated to an equivalent single-day weekly recurrence below).
  day?: string;
};

export default async (req: Request) => {
  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });

  if (req.method === "GET") {
    const memberId = new URL(req.url).searchParams.get("memberId");
    if (!memberId) return new Response("Missing memberId", { status: 400 });

    const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
    const carpools = (await Promise.all(codes.map((code) => loadSeries(store, code)))).filter(
      Boolean
    ) as CarpoolSeries[];
    const occurrences = (await Promise.all(carpools.map((c) => listOccurrences(store, c.code)))).flat();

    return new Response(JSON.stringify({ carpools, occurrences }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const body = (await req.json()) as CreateBody;
    const { name, destination, dropOff, pickUp, member, timezone } = body;

    let recurrence = body.recurrence;
    if (!recurrence && body.day) {
      // Bridge for the not-yet-updated Create form: one day, every week.
      const day = (DAYS_OF_WEEK as readonly string[]).includes(body.day) ? (body.day as DayOfWeek) : null;
      if (day) recurrence = { type: "weekly", daysOfWeek: [day], startDate: nextDateForWeekday(day) };
    }

    const validRecurrence =
      !!recurrence?.startDate &&
      (recurrence.type === "oneoff" || (Array.isArray(recurrence.daysOfWeek) && recurrence.daysOfWeek.length > 0));

    if (!name || !validRecurrence || !member?.id || !member?.name) {
      return new Response("Missing fields", { status: 400 });
    }

    let code = randomCode();
    for (let i = 0; i < 10 && (await store.get(`code:${code}`)); i++) {
      code = randomCode();
    }

    member.coparentId = (await store.get(`coparent:${member.id}`)) as string | null;

    const series: CarpoolSeries = {
      code,
      name,
      destination: destination ?? { street: "", zip: "" },
      recurrenceEras: [
        {
          startDate: recurrence!.startDate,
          endDate: null,
          type: recurrence!.type,
          daysOfWeek: recurrence!.type === "oneoff" ? [] : recurrence!.daysOfWeek!,
          defaultDropOff: { time: dropOff?.time ?? "", cars: [] },
          defaultPickUp: { time: pickUp?.time ?? "", cars: [] },
        },
      ],
      members: [member],
      createdAt: Date.now(),
      timezone: timezone?.trim() || DEFAULT_TIMEZONE,
    };

    await autoAddCoParent(store, series, member.id, member.kids);

    await store.setJSON(`code:${code}`, series);
    await generateOccurrences(store, series);

    for (const m of series.members) {
      const existing = ((await store.get(`member:${m.id}`, { type: "json" })) as string[] | null) ?? [];
      if (!existing.includes(code)) {
        await store.setJSON(`member:${m.id}`, [...existing, code]);
      }
    }

    const occurrences = await listOccurrences(store, code);
    return new Response(JSON.stringify({ carpool: series, occurrences }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/carpools",
};
