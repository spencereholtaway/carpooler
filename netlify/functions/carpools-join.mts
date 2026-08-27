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
const GENERATION_HORIZON_DAYS = 56;
const DAY_INDEX: Record<DayOfWeek, number> = Object.fromEntries(DAYS_OF_WEEK.map((d, i) => [d, i])) as Record<
  DayOfWeek,
  number
>;

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
// Reads+migrates a series by code, same as carpools.mts's loadSeries — the
// two need to be independently duplicated (this repo doesn't share modules
// between functions) since either endpoint might be the first to touch a
// still-legacy-shaped blob.
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

function currentEra(series: CarpoolSeries): RecurrenceEra {
  const today = todayISO();
  // Eras are ordered by startDate; the current one is the last whose
  // startDate has already arrived (should always exist — a series always
  // has at least one era whose startDate is at/before its own creation).
  let found = series.recurrenceEras[0];
  for (const era of series.recurrenceEras) {
    if (isoCompare(era.startDate, today) <= 0) found = era;
  }
  return found;
}

async function listOccurrences(store: ReturnType<typeof getStore>, code: string): Promise<CarpoolOccurrence[]> {
  const { blobs } = await store.list({ prefix: `occ:${code}:` });
  const occs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return occs.filter(Boolean) as CarpoolOccurrence[];
}

// After a membership/car change to the current era's defaults, push that
// change into every not-yet-passed, not-individually-overridden occurrence
// still governed by that same era — otherwise a newly-joined member's car
// would exist only in the series defaults and never show up on any actual
// date. An occurrence someone already hand-overrode is left alone, and a
// past occurrence is never touched (it's either historized or on its way to
// being so).
// A kid marked skipped for a specific occurrence must stay out of it even
// when the era's own defaults get copied in — otherwise a later, unrelated
// schedule change would silently un-skip them by copying them right back in.
function withoutSkipped(cars: Car[], skippedKids: string[] | undefined): Car[] {
  if (!skippedKids || skippedKids.length === 0) return cars.map((c) => ({ ...c, kids: [...c.kids] }));
  const skip = new Set(skippedKids);
  return cars.map((c) => ({ ...c, kids: c.kids.filter((k) => !skip.has(k)) }));
}

async function restampFutureOccurrences(
  store: ReturnType<typeof getStore>,
  series: CarpoolSeries,
  era: RecurrenceEra,
  dropDriver?: { memberId: string; legs: { dropOff: boolean; pickUp: boolean } }
) {
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
      } else if (dropDriver?.legs.dropOff && occ.dropOff.cars.some((c) => c.driverId === dropDriver.memberId)) {
        occ.dropOff = { ...occ.dropOff, cars: occ.dropOff.cars.filter((c) => c.driverId !== dropDriver.memberId) };
        changed = true;
      }
      if (!occ.overridden.pickUp) {
        occ.pickUp = { time: era.defaultPickUp.time, cars: withoutSkipped(era.defaultPickUp.cars, occ.skippedKids) };
        changed = true;
      } else if (dropDriver?.legs.pickUp && occ.pickUp.cars.some((c) => c.driverId === dropDriver.memberId)) {
        occ.pickUp = { ...occ.pickUp, cars: occ.pickUp.cars.filter((c) => c.driverId !== dropDriver.memberId) };
        changed = true;
      }
      if (changed) await store.setJSON(`occ:${series.code}:${occ.date}`, occ);
    })
  );
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

// Fully remove a member: their row, their car on both legs of the current
// era's defaults (regardless of whether they could still drive), and any of
// their kids left sitting in someone else's car that no remaining member
// still legitimately claims.
function dropMember(carpool: CarpoolSeries, era: RecurrenceEra, memberId: string) {
  const leaving = carpool.members.find((m) => m.id === memberId);
  carpool.members = carpool.members.filter((m) => m.id !== memberId);
  era.defaultDropOff.cars = era.defaultDropOff.cars.filter((c) => c.driverId !== memberId);
  era.defaultPickUp.cars = era.defaultPickUp.cars.filter((c) => c.driverId !== memberId);

  const stillOwned = new Set(carpool.members.flatMap((m) => m.kids));
  const kidsToClear = (leaving?.kids ?? []).filter((k) => !stillOwned.has(k));
  if (kidsToClear.length > 0) {
    const removeSet = new Set(kidsToClear);
    for (const leg of [era.defaultDropOff, era.defaultPickUp]) {
      leg.cars = leg.cars.map((c) => ({ ...c, kids: c.kids.filter((k) => !removeSet.has(k)) }));
    }
  }
}

async function removeCodeFromMember(store: ReturnType<typeof getStore>, memberId: string, code: string) {
  const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
  await store.setJSON(`member:${memberId}`, codes.filter((c) => c !== code));
}

// Keep a leg's car list in sync with a member's driving toggle: drop their
// car if they can no longer drive it, or give them one (defaulting to their
// own unclaimed kids) if they now can and don't have one yet. There's no
// profile-level default to seed capacity from — a brand-new car starts at 1
// seat, same as pressing "+" once from off. If they already have a car, also
// fold in any of their own kids that aren't claimed anywhere yet — e.g. a
// kid just re-added to this carpool — so a re-added kid defaults back to
// riding with them instead of no one. An existing car's seat count is left
// alone here — that's a per-leg value the driver edits directly, not
// something a profile sync should clobber.
function syncCar(leg: Leg, member: Member, canDrive: boolean) {
  leg.cars ??= [];
  if (!canDrive) {
    leg.cars = leg.cars.filter((c) => c.driverId !== member.id);
    return;
  }
  const claimed = new Set(leg.cars.flatMap((c) => c.kids));
  const unclaimedOwnKids = member.kids.filter((k) => !claimed.has(k));
  const existing = leg.cars.find((c) => c.driverId === member.id);
  if (existing) {
    if (unclaimedOwnKids.length > 0) existing.kids = [...existing.kids, ...unclaimedOwnKids];
    return;
  }
  leg.cars.push({ driverId: member.id, kids: unclaimedOwnKids, seats: 1 });
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { code, member } = (await req.json()) as { code: string; member: Member };
  if (!code || !member?.id || !member?.name) {
    return new Response("Missing fields", { status: 400 });
  }

  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });
  const carpool = await loadSeries(store, code);
  if (!carpool) return new Response("No carpool with that code", { status: 404 });

  const era = currentEra(carpool);

  // The client can't be trusted to know its own household link (it may be
  // stale or forged), so look it up server-side rather than trust the body.
  member.coparentId = (await store.get(`coparent:${member.id}`)) as string | null;

  const existingIndex = carpool.members.findIndex((m) => m.id === member.id);
  const isNewJoin = existingIndex === -1;
  const previousMember = isNewJoin ? null : carpool.members[existingIndex];
  const previousKids = previousMember?.kids ?? [];
  // Deselecting every kid you have in this carpool isn't a kids update —
  // it's you leaving. Drop the member row entirely rather than upserting an
  // empty kids array onto a row that would otherwise linger forever.
  const isLeaving = !isNewJoin && member.kids.length === 0;
  // A leg going from "can drive" to "can't" (or the member leaving outright)
  // means their car shouldn't exist anywhere anymore — including a date
  // someone already hand-overrode, unlike an ordinary default change (see
  // restampFutureOccurrences), because "not driving" isn't a preference a
  // stale per-date override should be able to keep alive.
  const droppedDriverLegs = {
    dropOff: (previousMember?.canDriveDropOff ?? false) && (isLeaving || !member.canDriveDropOff),
    pickUp: (previousMember?.canDrivePickUp ?? false) && (isLeaving || !member.canDrivePickUp),
  };

  if (isLeaving) {
    dropMember(carpool, era, member.id);
  } else if (isNewJoin) {
    carpool.members.push(member);
  } else {
    carpool.members[existingIndex] = member;
  }

  // A coparent row that was auto-added on this member's behalf (see
  // autoAddCoParent below) is a snapshot, not an independent choice — keep it
  // in step with this member's current kids rather than letting a kid who
  // was removed here linger under the coparent's row forever. Even if that
  // sync leaves the coparent with no shared kids left in this carpool, they
  // stay as a member (just with an empty kids list, same as anyone not
  // currently offering a ride) rather than being silently dropped — the
  // whole point of auto-adding them was so they can see where their kid's
  // rides stand, and that visibility shouldn't vanish the moment the other
  // parent unenrolls that kid.
  if (!isNewJoin && member.coparentId) {
    const coIndex = carpool.members.findIndex((m) => m.id === member.coparentId);
    if (coIndex !== -1 && carpool.members[coIndex].coparentId === member.id) {
      const coProfile = (await store.get(`profile:${member.coparentId}`, { type: "json" })) as
        | ServerProfile
        | null;
      if (coProfile) {
        const syncedKids = member.kids.filter((k) => coProfile.kids.includes(k));
        carpool.members[coIndex] = { ...carpool.members[coIndex], kids: syncedKids };
      }
    }
  }

  // A kid dropped from this member's roster (e.g. taken off this carpool
  // entirely) may still be sitting in someone else's car from an earlier
  // move — unless a co-parent still legitimately claims them, that ride is
  // no longer valid for anyone, so clear it out of every car on both legs.
  const stillOwned = new Set(carpool.members.filter((m) => m.id !== member.id).flatMap((m) => m.kids));
  const kidsToClear = previousKids.filter((k) => !member.kids.includes(k) && !stillOwned.has(k));
  if (kidsToClear.length > 0) {
    const removeSet = new Set(kidsToClear);
    for (const leg of [era.defaultDropOff, era.defaultPickUp]) {
      leg.cars = leg.cars.map((c) => ({ ...c, kids: c.kids.filter((k) => !removeSet.has(k)) }));
    }
  }

  if (!isLeaving) {
    syncCar(era.defaultDropOff, member, member.canDriveDropOff);
    syncCar(era.defaultPickUp, member, member.canDrivePickUp);
  }

  if (isNewJoin) {
    await autoAddCoParent(store, carpool, member.id, member.kids);
  }

  // Leaving members always need their own carpool-code list cleaned up.
  if (isLeaving) await removeCodeFromMember(store, member.id, code);

  // No one left — delete the carpool itself (and its occurrences) rather
  // than writing back an empty shell. This only happens as a side effect of
  // the member count reaching zero, never as a directly-invokable action.
  if (carpool.members.length === 0) {
    await store.delete(`code:${code}`);
    const { blobs } = await store.list({ prefix: `occ:${code}:` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    return new Response(JSON.stringify({ deleted: true, code }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  await store.setJSON(`code:${code}`, carpool);
  await restampFutureOccurrences(
    store,
    carpool,
    era,
    droppedDriverLegs.dropOff || droppedDriverLegs.pickUp ? { memberId: member.id, legs: droppedDriverLegs } : undefined
  );

  if (!isLeaving) {
    for (const m of isNewJoin ? carpool.members : [member]) {
      const memberCarpools =
        ((await store.get(`member:${m.id}`, { type: "json" })) as string[] | null) ?? [];
      if (!memberCarpools.includes(code)) {
        await store.setJSON(`member:${m.id}`, [...memberCarpools, code]);
      }
    }
  }

  const occurrences = await listOccurrences(store, code);
  return new Response(JSON.stringify({ carpool, occurrences }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/carpools/join",
};
