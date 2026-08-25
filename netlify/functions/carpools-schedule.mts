import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Car = { driverId: string; kids: string[]; seats: number };
type Leg = { time: string; cars: Car[] };
type Address = { street: string; zip: string };
type Member = { id: string; kids: string[]; canDriveDropOff: boolean; canDrivePickUp: boolean };

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
  // Set when this occurrence was individually rescheduled to a date its
  // series wouldn't otherwise generate (e.g. "just this Wednesday practice,
  // moved to Thursday") — pruneInvalidOccurrences must never delete it for
  // sitting on a date outside the recurrence pattern, since that's the
  // entire point of it.
  moved?: boolean;
  // Set on the date a moved occurrence vacated, so generateOccurrences
  // (which only ever fills in missing dates) doesn't quietly regenerate a
  // fresh occurrence there — the whole point of moving it was that this
  // week's occurrence no longer happens on its usual date. A cancelled
  // occurrence is never shown or counted toward anything.
  cancelled?: boolean;
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
const GENERATION_HORIZON_DAYS = 90; // ~3 months ahead

function clampSeats(seats: unknown): number {
  const n = Number(seats);
  if (!Number.isFinite(n)) return 0;
  return Math.min(8, Math.max(0, Math.round(n)));
}

// A member without this leg's "I can drive" toggle set still has a car entry
// dropped server-side — unless every kid in it is their own. Parents can
// always carry their own kids regardless of that toggle.
function sanitizeLeg(
  leg: Leg | undefined,
  eligibleDriverIds: Set<string>,
  ownKidsByMember: Map<string, Set<string>>
): Leg {
  const seenKids = new Set<string>();
  const cars: Car[] = [];
  for (const car of leg?.cars ?? []) {
    const ownKids = ownKidsByMember.get(car.driverId) ?? new Set<string>();
    const isEligible = eligibleDriverIds.has(car.driverId);
    const kids = car.kids.filter((k) => {
      if (seenKids.has(k)) return false; // a kid can only ride in one car per leg
      if (!isEligible && !ownKids.has(k)) return false;
      seenKids.add(k);
      return true;
    });
    if (isEligible || kids.length > 0) cars.push({ driverId: car.driverId, kids, seats: clampSeats(car.seats) });
  }
  return { time: leg?.time ?? "", cars };
}

// ---- date helpers (see carpools.mts for the fuller comment on the
// UTC-vs-carpool-timezone approximation this makes) ----
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
async function listOccurrences(store: ReturnType<typeof getStore>, code: string): Promise<CarpoolOccurrence[]> {
  const { blobs } = await store.list({ prefix: `occ:${code}:` });
  const occs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return occs.filter(Boolean) as CarpoolOccurrence[];
}

function sanitizedEra(
  era: Pick<RecurrenceEra, "startDate" | "endDate" | "type" | "daysOfWeek">,
  dropOff: Leg | undefined,
  pickUp: Leg | undefined,
  members: Member[]
): RecurrenceEra {
  const dropOffEligible = new Set(members.filter((m) => m.canDriveDropOff).map((m) => m.id));
  const pickUpEligible = new Set(members.filter((m) => m.canDrivePickUp).map((m) => m.id));
  const ownKidsByMember = new Map(members.map((m) => [m.id, new Set(m.kids)]));
  return {
    startDate: era.startDate,
    endDate: era.endDate,
    type: era.type,
    daysOfWeek: era.type === "oneoff" ? [] : era.daysOfWeek,
    defaultDropOff: sanitizeLeg(dropOff, dropOffEligible, ownKidsByMember),
    defaultPickUp: sanitizeLeg(pickUp, pickUpEligible, ownKidsByMember),
  };
}

// A day/frequency change can leave already-generated future occurrences
// that no longer correspond to any date the (now-changed) recurrence would
// actually produce — e.g. changing Wednesday to Tuesday leaves stale future
// Wednesday blobs sitting around. Deletes any not-yet-historized occurrence
// from `fromDate` onward whose date isn't valid under any current era,
// including individually-overridden ones (an override for a day that no
// longer exists in the schedule at all isn't a real occurrence to keep).
async function pruneInvalidOccurrences(store: ReturnType<typeof getStore>, series: CarpoolSeries, fromDate: string) {
  const horizonEnd = addDaysISO(todayISO(), GENERATION_HORIZON_DAYS);
  const validDates = new Set(series.recurrenceEras.flatMap((era) => generateDatesForEra(era, horizonEnd)));
  const occurrences = await listOccurrences(store, series.code);
  await Promise.all(
    occurrences.map(async (occ) => {
      if (occ.historized || occ.moved || occ.cancelled) return;
      if (isoCompare(occ.date, fromDate) < 0) return;
      if (validDates.has(occ.date)) return;
      await store.delete(`occ:${series.code}:${occ.date}`);
    })
  );
}

// Re-stamp every not-yet-passed, not-individually-overridden occurrence
// governed by `era` from that era's (possibly just-updated) defaults.
// A kid marked skipped for a specific occurrence must stay out of it even
// when the era's own defaults (which the kid may still be part of) get
// copied in — otherwise a later, unrelated schedule change would silently
// un-skip them by copying them right back in.
function withoutSkipped(cars: Car[], skippedKids: string[] | undefined): Car[] {
  if (!skippedKids || skippedKids.length === 0) return cars.map((c) => ({ ...c, kids: [...c.kids] }));
  const skip = new Set(skippedKids);
  return cars.map((c) => ({ ...c, kids: c.kids.filter((k) => !skip.has(k)) }));
}

async function restampEra(store: ReturnType<typeof getStore>, series: CarpoolSeries, era: RecurrenceEra) {
  const today = todayISO();
  const occurrences = await listOccurrences(store, series.code);
  await Promise.all(
    occurrences.map(async (occ) => {
      if (isoCompare(occ.date, today) < 0) return;
      if (isoCompare(occ.date, era.startDate) < 0) return;
      if (era.endDate && isoCompare(occ.date, era.endDate) > 0) return;
      let changed = false;
      if (!occ.overridden.dropOff) {
        occ.dropOff = { time: era.defaultDropOff.time, cars: withoutSkipped(era.defaultDropOff.cars, occ.skippedKids) };
        changed = true;
      }
      if (!occ.overridden.pickUp) {
        occ.pickUp = { time: era.defaultPickUp.time, cars: withoutSkipped(era.defaultPickUp.cars, occ.skippedKids) };
        changed = true;
      }
      if (changed) await store.setJSON(`occ:${series.code}:${occ.date}`, occ);
    })
  );
}

type ScheduleBody =
  | {
      code: string;
      scope: "all";
      name?: string;
      destination?: Address;
      timezone?: string;
    }
  // A genuine retroactive correction — every occurrence of this leg, past
  // and future, overridden or not. Unlike every other schedule edit, this
  // one deliberately rewrites history: it exists for "we always had the
  // wrong time on file," not for a real schedule change, so it always wins
  // over an individual occurrence's override.
  | {
      code: string;
      scope: "allTime";
      leg: "dropOff" | "pickUp";
      time: string;
    }
  | {
      code: string;
      scope: "thisAndFuture";
      startDate: string; // today or a future date
      type: RecurrenceType;
      daysOfWeek?: DayOfWeek[];
      dropOff: Leg;
      pickUp: Leg;
    }
  | {
      code: string;
      scope: "occurrence";
      date: string;
      dropOff?: Leg;
      pickUp?: Leg;
    }
  // "My kid isn't doing it this week" — pulls one kid out of every car on
  // both legs for a single occurrence, without touching anyone else's
  // seats/eligibility or the series defaults.
  | {
      code: string;
      scope: "skipKid";
      date: string;
      kid: string;
      skipped: boolean;
      memberId: string;
    }
  // "Just this one," where the day itself changed — e.g. one Wednesday
  // practice moved to Thursday without touching the recurring Wednesday
  // pattern. Reschedules a single occurrence to a different date; the
  // vacated date is marked cancelled, not deleted, so it never silently
  // regenerates.
  | {
      code: string;
      scope: "moveOccurrence";
      fromDate: string;
      toDate: string;
      dropOff?: Leg;
      pickUp?: Leg;
    }
  // Legacy shape from the not-yet-updated CarpoolDetail UI: treated as an
  // implicit "this and all future, starting today" on a single weekday.
  | {
      code: string;
      day: string;
      destination: Address;
      dropOff: Leg;
      pickUp: Leg;
      name?: string;
      timezone?: string;
    };

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = (await req.json()) as ScheduleBody;
  if (!body.code) return new Response("Missing fields", { status: 400 });

  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });
  const carpool = await loadSeries(store, body.code);
  if (!carpool) return new Response("No carpool with that code", { status: 404 });

  const today = todayISO();

  if ("scope" in body && body.scope === "all") {
    if (body.name && body.name.trim()) carpool.name = body.name.trim();
    if (body.timezone && body.timezone.trim()) carpool.timezone = body.timezone.trim();
    if (body.destination) carpool.destination = { street: body.destination.street ?? "", zip: body.destination.zip ?? "" };
    await store.setJSON(`code:${body.code}`, carpool);
    const occurrences = await listOccurrences(store, body.code);
    return new Response(JSON.stringify({ carpool, occurrences }), { headers: { "Content-Type": "application/json" } });
  }

  if ("scope" in body && body.scope === "allTime") {
    const { leg, time } = body;
    for (const era of carpool.recurrenceEras) {
      if (leg === "dropOff") era.defaultDropOff = { ...era.defaultDropOff, time };
      else era.defaultPickUp = { ...era.defaultPickUp, time };
    }
    await store.setJSON(`code:${body.code}`, carpool);

    const occurrences = await listOccurrences(store, body.code);
    await Promise.all(
      occurrences.map(async (occ) => {
        if (leg === "dropOff") occ.dropOff = { ...occ.dropOff, time };
        else occ.pickUp = { ...occ.pickUp, time };
        await store.setJSON(`occ:${body.code}:${occ.date}`, occ);
      })
    );
    const fresh = await listOccurrences(store, body.code);
    return new Response(JSON.stringify({ carpool, occurrences: fresh }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if ("scope" in body && body.scope === "occurrence") {
    const occKey = `occ:${body.code}:${body.date}`;
    const occ = (await store.get(occKey, { type: "json" })) as CarpoolOccurrence | null;
    if (!occ) return new Response("No occurrence on that date", { status: 404 });

    const dropOffEligible = new Set(carpool.members.filter((m) => m.canDriveDropOff).map((m) => m.id));
    const pickUpEligible = new Set(carpool.members.filter((m) => m.canDrivePickUp).map((m) => m.id));
    const ownKidsByMember = new Map(carpool.members.map((m) => [m.id, new Set(m.kids)]));

    if (body.dropOff) {
      occ.dropOff = sanitizeLeg(body.dropOff, dropOffEligible, ownKidsByMember);
      occ.overridden.dropOff = true;
    }
    if (body.pickUp) {
      occ.pickUp = sanitizeLeg(body.pickUp, pickUpEligible, ownKidsByMember);
      occ.overridden.pickUp = true;
    }
    // A kid manually placed in a car is, by that same act, no longer "not
    // going" for this occurrence — leaving both flags set would mean a kid
    // simultaneously has a ride and is marked skipped.
    if (occ.skippedKids && occ.skippedKids.length > 0) {
      const assignedKids = new Set([...occ.dropOff.cars, ...occ.pickUp.cars].flatMap((c) => c.kids));
      occ.skippedKids = occ.skippedKids.filter((k) => !assignedKids.has(k));
    }
    await store.setJSON(occKey, occ);
    return new Response(JSON.stringify(occ), { headers: { "Content-Type": "application/json" } });
  }

  if ("scope" in body && body.scope === "skipKid") {
    const { date, kid, skipped, memberId } = body;
    const occKey = `occ:${body.code}:${date}`;
    const occ = (await store.get(occKey, { type: "json" })) as CarpoolOccurrence | null;
    if (!occ) return new Response("No occurrence on that date", { status: 404 });

    const current = new Set(occ.skippedKids ?? []);
    if (skipped) {
      current.add(kid);
      // Pull them out of every car on both legs — "not going" means not
      // riding with anyone, not just "no longer your responsibility." The
      // car entry itself (and its seat count) is left in place, not deleted.
      occ.dropOff = { ...occ.dropOff, cars: occ.dropOff.cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) })) };
      occ.pickUp = { ...occ.pickUp, cars: occ.pickUp.cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) })) };
    } else {
      current.delete(kid);
      // Put them back in the requesting member's own car specifically,
      // preserving whatever seats it already had — the generic
      // unclaimed-kid-defaults-to-owner fallback won't fire here anyway,
      // since a member who already has a car on a leg is exempt from it.
      for (const leg of [occ.dropOff, occ.pickUp]) {
        const car = leg.cars.find((c) => c.driverId === memberId);
        if (car && !car.kids.includes(kid)) car.kids.push(kid);
      }
    }
    occ.skippedKids = [...current];
    await store.setJSON(occKey, occ);
    return new Response(JSON.stringify(occ), { headers: { "Content-Type": "application/json" } });
  }

  if ("scope" in body && body.scope === "moveOccurrence") {
    const fromKey = `occ:${body.code}:${body.fromDate}`;
    const toKey = `occ:${body.code}:${body.toDate}`;
    const fromOcc = (await store.get(fromKey, { type: "json" })) as CarpoolOccurrence | null;
    if (!fromOcc) return new Response("No occurrence on that date", { status: 404 });

    const existingAtTo = (await store.get(toKey, { type: "json" })) as CarpoolOccurrence | null;
    if (existingAtTo && !existingAtTo.cancelled) {
      return new Response("That date already has an occurrence", { status: 409 });
    }

    const dropOffEligible = new Set(carpool.members.filter((m) => m.canDriveDropOff).map((m) => m.id));
    const pickUpEligible = new Set(carpool.members.filter((m) => m.canDrivePickUp).map((m) => m.id));
    const ownKidsByMember = new Map(carpool.members.map((m) => [m.id, new Set(m.kids)]));

    const movedOcc: CarpoolOccurrence = {
      code: body.code,
      date: body.toDate,
      dropOff: body.dropOff ? sanitizeLeg(body.dropOff, dropOffEligible, ownKidsByMember) : fromOcc.dropOff,
      pickUp: body.pickUp ? sanitizeLeg(body.pickUp, pickUpEligible, ownKidsByMember) : fromOcc.pickUp,
      overridden: { dropOff: true, pickUp: true },
      historized: false,
      moved: true,
      skippedKids: fromOcc.skippedKids ?? [],
      generatedAt: Date.now(),
    };
    await store.setJSON(toKey, movedOcc);
    // The vacated date is cancelled, not deleted — generateOccurrences only
    // ever fills in *missing* dates, so leaving a cancelled marker there is
    // what stops it from quietly regenerating a fresh occurrence on the day
    // this one just moved off of.
    await store.setJSON(fromKey, { ...fromOcc, cancelled: true } as CarpoolOccurrence);

    const occurrences = await listOccurrences(store, body.code);
    return new Response(JSON.stringify({ carpool, occurrences }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Either an explicit "thisAndFuture" edit, or the legacy single-day shape
  // (implicitly "thisAndFuture, starting today").
  const startDate = "scope" in body ? body.startDate : nextDateForWeekday(
    (DAYS_OF_WEEK as readonly string[]).includes((body as { day: string }).day)
      ? ((body as { day: string }).day as DayOfWeek)
      : "Monday"
  );
  const type: RecurrenceType = "scope" in body ? body.type : "weekly";
  const daysOfWeek: DayOfWeek[] =
    "scope" in body
      ? body.daysOfWeek ?? []
      : [((body as { day: string }).day as DayOfWeek)];
  const dropOff = body.dropOff;
  const pickUp = body.pickUp;

  if (!("scope" in body)) {
    if (body.name && body.name.trim()) carpool.name = body.name.trim();
    if (body.timezone && body.timezone.trim()) carpool.timezone = body.timezone.trim();
    carpool.destination = { street: body.destination?.street ?? "", zip: body.destination?.zip ?? "" };
  }

  // Keep every era that's fully over before `startDate` untouched. Any era
  // that starts at or after `startDate` is superseded by this edit and
  // dropped — not just "the current one," since a second future-dated edit
  // earlier than an already-existing later split must replace that later
  // split too, not silently coexist with (or get replaced by) it via a
  // fragile "current era index" that assumes eras are edited in order.
  const eras = carpool.recurrenceEras;
  const before = eras.filter((e) => e.endDate !== null && isoCompare(e.endDate, startDate) < 0);
  // If an era spans across `startDate` (started before it, still open at or
  // past it), close it the day before rather than dropping it outright.
  const spanning = eras.find(
    (e) => isoCompare(e.startDate, startDate) < 0 && (e.endDate === null || isoCompare(e.endDate, startDate) >= 0)
  );
  if (spanning) before.push({ ...spanning, endDate: addDaysISO(startDate, -1) });

  const newEra = sanitizedEra({ startDate, endDate: null, type, daysOfWeek }, dropOff, pickUp, carpool.members);
  carpool.recurrenceEras = [...before, newEra];
  await store.setJSON(`code:${body.code}`, carpool);
  await pruneInvalidOccurrences(store, carpool, isoCompare(startDate, today) <= 0 ? today : startDate);
  await generateOccurrences(store, carpool);
  await restampEra(store, carpool, newEra);

  const occurrences = await listOccurrences(store, body.code);
  return new Response(JSON.stringify({ carpool, occurrences }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/carpools/schedule",
};
