import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; kids: string[]; street: string; zip: string; isTestAccount?: boolean };
type Member = {
  id: string;
  name: string;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
  street: string;
  zip: string;
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
type Carpool = {
  code: string;
  name: string;
  destination: Address;
  recurrenceEras: RecurrenceEra[];
  members: Member[];
  createdAt: number;
  timezone?: string;
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
function migrateLegacyCarpool(legacy: LegacyCarpool): Carpool {
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
async function listOccurrences(store: ReturnType<typeof getStore>, code: string): Promise<CarpoolOccurrence[]> {
  const { blobs } = await store.list({ prefix: `occ:${code}:` });
  const occs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return occs.filter(Boolean) as CarpoolOccurrence[];
}
async function generateOccurrences(store: ReturnType<typeof getStore>, series: Carpool): Promise<void> {
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
// A kid marked skipped for a specific occurrence must stay out of it even
// when the era's own defaults get copied in — otherwise a later, unrelated
// schedule change would silently un-skip them by copying them right back in.
function withoutSkipped(cars: Car[], skippedKids: string[] | undefined): Car[] {
  if (!skippedKids || skippedKids.length === 0) return cars.map((c) => ({ ...c, kids: [...c.kids] }));
  const skip = new Set(skippedKids);
  return cars.map((c) => ({ ...c, kids: c.kids.filter((k) => !skip.has(k)) }));
}

async function restampEra(
  store: ReturnType<typeof getStore>,
  series: Carpool,
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
// Reads+migrates a series by code, same as carpools.mts's loadSeries.
async function loadSeries(store: ReturnType<typeof getStore>, code: string): Promise<Carpool | null> {
  const raw = await store.get(`code:${code}`, { type: "json" });
  if (!raw) return null;
  let series: Carpool;
  if (isLegacyShape(raw)) {
    series = migrateLegacyCarpool(raw);
    await store.setJSON(`code:${code}`, series);
  } else {
    series = raw as Carpool;
  }
  await generateOccurrences(store, series);
  return series;
}
function currentEra(series: Carpool): RecurrenceEra {
  const today = todayISO();
  let found = series.recurrenceEras[0];
  for (const era of series.recurrenceEras) {
    if (isoCompare(era.startDate, today) <= 0) found = era;
  }
  return found;
}
// After mutating the current era's defaults, push the change into every
// future not-individually-overridden occurrence it governs.
async function applyEraChange(
  store: ReturnType<typeof getStore>,
  series: Carpool,
  era: RecurrenceEra,
  dropDriver?: { memberId: string; legs: { dropOff: boolean; pickUp: boolean } }
) {
  await store.setJSON(`code:${series.code}`, series);
  await restampEra(store, series, era, dropDriver);
}

function clampSeats(seats: unknown): number {
  const n = Number(seats);
  if (!Number.isFinite(n)) return 0;
  return Math.min(8, Math.max(0, Math.round(n)));
}

// Like syncCar, but sets an explicit seat count instead of defaulting to 1 —
// the admin panel's free-seats stepper mirrors the real driving-leg control
// (0 means not driving, 1+ means driving with that many free seats), so it
// needs to write the number the admin actually chose, not just flip a
// boolean and let syncCar's default win.
function setSeats(leg: Leg, member: Member, seats: number) {
  leg.cars ??= [];
  if (seats <= 0) {
    leg.cars = leg.cars.filter((c) => c.driverId !== member.id);
    return;
  }
  const existing = leg.cars.find((c) => c.driverId === member.id);
  if (existing) {
    existing.seats = seats;
    // Seats cap other members' kids only, same as sanitizeLeg in
    // carpools-schedule.mts — trim any that no longer fit so a lowered
    // count actually frees the car up instead of just relabeling it.
    let otherSeatsLeft = seats;
    existing.kids = existing.kids.filter((k) => {
      if (member.kids.includes(k)) return true;
      if (otherSeatsLeft <= 0) return false;
      otherSeatsLeft -= 1;
      return true;
    });
    return;
  }
  const claimed = new Set(leg.cars.flatMap((c) => c.kids));
  const unclaimedOwnKids = member.kids.filter((k) => !claimed.has(k));
  leg.cars.push({ driverId: member.id, kids: unclaimedOwnKids, seats });
}

// Mirrors moveKid in CarpoolDetail.tsx: pull the kid out of whatever car
// they're currently in, then drop them into driverId's car (creating it,
// seeded with defaultSeats, if the driver doesn't have one yet), or leave
// them unassigned if driverId is null.
function moveKidCar(cars: Car[], kid: string, driverId: string | null, defaultSeats: number): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  if (!cleared.some((c) => c.driverId === driverId)) {
    return [...cleared, { driverId, kids: [kid], seats: defaultSeats }];
  }
  return cleared.map((c) => (c.driverId === driverId ? { ...c, kids: [...c.kids, kid] } : c));
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

function nameClaimKey(name: string) {
  return `name:${name.trim().toLowerCase()}`;
}

// Mirrors claim-name.mts's own claim logic. Sign-in matches a typed name
// against this name:{trimmed-lowercased} -> memberId index, but admin's
// createUser/updateUser used to write profile:{memberId} directly without
// ever touching it — so an admin-created (or admin-corrected) user had no
// claim key at all, and would fail to match on sign-in, forcing a
// duplicate profile. Never steals a name genuinely claimed by another
// user still on file — but a claim can point at a memberId whose profile
// is gone (e.g. deleteUser missed it, or predates that cleanup), and a
// dangling claim like that can never be reclaimed on its own, so this
// self-heals by treating it as free.
async function claimNameIfFree(store: ReturnType<typeof getStore>, name: string, memberId: string) {
  const key = nameClaimKey(name);
  const existing = await store.get(key);
  if (existing && existing !== memberId) {
    const stillExists = await store.get(`profile:${existing}`, { type: "json" });
    if (stillExists) return;
  }
  await store.set(key, memberId);
}

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Mirrors household.mts's lazy code generation, but run eagerly at profile
// creation so every user has a co-parent invite code from the start instead
// of only once they first open the invite screen.
async function ensureHouseholdCode(store: ReturnType<typeof getStore>, memberId: string) {
  let code = (await store.get(`household-owner:${memberId}`)) as string | null;
  if (code) return code;
  code = randomCode();
  for (let i = 0; i < 10 && (await store.get(`household:${code}`)); i++) {
    code = randomCode();
  }
  await store.set(`household:${code}`, memberId);
  await store.set(`household-owner:${memberId}`, code);
  return code;
}

// Mirrors backfillCoParentIntoCarpools in household-link.mts: retroactively
// add the co-parent to any of ownerId's carpools where they share a kid, so
// an admin-created link behaves the same as one a member makes themselves.
async function backfillCoParentIntoCarpools(
  store: ReturnType<typeof getStore>,
  ownerId: string,
  coParentId: string
) {
  const coProfile = (await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null;
  if (!coProfile) return;

  const codes = ((await store.get(`member:${ownerId}`, { type: "json" })) as string[] | null) ?? [];
  for (const code of codes) {
    const carpool = await loadSeries(store, code);
    if (!carpool || carpool.members.some((m) => m.id === coParentId)) continue;

    const owner = carpool.members.find((m) => m.id === ownerId);
    if (!owner) continue;
    const sharedKids = owner.kids.filter((k) => coProfile.kids.includes(k));
    if (sharedKids.length === 0) continue;

    carpool.members.push({
      id: coParentId,
      name: coProfile.name,
      kids: sharedKids,
      canDriveDropOff: false,
      canDrivePickUp: false,
      street: coProfile.street,
      zip: coProfile.zip,
    });
    await store.setJSON(`code:${code}`, carpool);

    const coParentCodes = ((await store.get(`member:${coParentId}`, { type: "json" })) as string[] | null) ?? [];
    if (!coParentCodes.includes(code)) {
      await store.setJSON(`member:${coParentId}`, [...coParentCodes, code]);
    }
  }
}

// Mirrors autoAddCoParent in carpools-join.mts/carpools.mts: when a member
// is added to ONE carpool (as opposed to backfillCoParentIntoCarpools
// above, which syncs ALL of an owner's carpools at link time), add their
// linked co-parent too if they share one of the kids just assigned — so
// admin's addMember behaves the same as a member joining themselves.
async function autoAddCoParentToCarpool(
  store: ReturnType<typeof getStore>,
  carpool: Carpool,
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
  });

  const existing = ((await store.get(`member:${coParentId}`, { type: "json" })) as string[] | null) ?? [];
  if (!existing.includes(carpool.code)) {
    await store.setJSON(`member:${coParentId}`, [...existing, carpool.code]);
  }
}

async function removeCodeFromMember(store: ReturnType<typeof getStore>, memberId: string, code: string) {
  const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
  await store.setJSON(`member:${memberId}`, codes.filter((c) => c !== code));
}

function dropMember(carpool: Carpool, era: RecurrenceEra, memberId: string) {
  const leaving = carpool.members.find((m) => m.id === memberId);
  carpool.members = carpool.members.filter((m) => m.id !== memberId);
  era.defaultDropOff.cars = era.defaultDropOff.cars.filter((c) => c.driverId !== memberId);
  era.defaultPickUp.cars = era.defaultPickUp.cars.filter((c) => c.driverId !== memberId);

  // Their kid(s) may still be sitting in someone else's car from an earlier
  // move — unless a co-parent still legitimately claims them, that ride is
  // no longer valid for anyone now that this member is gone.
  const stillOwned = new Set(carpool.members.flatMap((m) => m.kids));
  const kidsToClear = (leaving?.kids ?? []).filter((k) => !stillOwned.has(k));
  if (kidsToClear.length > 0) {
    const removeSet = new Set(kidsToClear);
    for (const leg of [era.defaultDropOff, era.defaultPickUp]) {
      leg.cars = leg.cars.map((c) => ({ ...c, kids: c.kids.filter((k) => !removeSet.has(k)) }));
    }
  }
}

async function handleMutation(store: ReturnType<typeof getStore>, req: Request) {
  const body = (await req.json()) as { key: string; action: string; payload: any };
  const expected = process.env.ADMIN_KEY;
  if (!expected || body.key !== expected) return new Response("Unauthorized", { status: 401 });

  switch (body.action) {
    case "createUser": {
      const { name, kids, street, zip, isTestAccount } = body.payload;
      const memberId = crypto.randomUUID();
      const profile: ServerProfile = { name, kids: kids ?? [], street, zip, isTestAccount: !!isTestAccount };
      await store.setJSON(`profile:${memberId}`, profile);
      await store.setJSON(`member:${memberId}`, []);
      await ensureHouseholdCode(store, memberId);
      await claimNameIfFree(store, name, memberId);
      return new Response(JSON.stringify({ memberId }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    case "updateUser": {
      const { memberId, name, kids, street, zip, isTestAccount } = body.payload;
      const oldProfile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      const profile: ServerProfile = { name, kids, street, zip, isTestAccount: !!isTestAccount };

      // Mirrors the merge in profile.mts's POST handler: a kid added here
      // should also reach a linked co-parent's profile, and vice versa,
      // instead of only ever merging once at initial link time.
      const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
      if (coParentId) {
        const coProfile = (await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null;
        if (coProfile) {
          const mergedKids = Array.from(new Set([...profile.kids, ...coProfile.kids]));
          profile.kids = mergedKids;
          if (mergedKids.length !== coProfile.kids.length) {
            await store.setJSON(`profile:${coParentId}`, { ...coProfile, kids: mergedKids });
          }
        }
      }

      await store.setJSON(`profile:${memberId}`, profile);

      if (oldProfile && nameClaimKey(oldProfile.name) !== nameClaimKey(name)) {
        const oldKey = nameClaimKey(oldProfile.name);
        if ((await store.get(oldKey)) === memberId) await store.delete(oldKey);
      }
      await claimNameIfFree(store, name, memberId);

      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      for (const code of codes) {
        const carpool = await loadSeries(store, code);
        if (!carpool) continue;
        const m = carpool.members.find((mm) => mm.id === memberId);
        if (!m) continue;
        m.name = name;
        m.kids = kids;
        m.street = street;
        m.zip = zip;
        await store.setJSON(`code:${code}`, carpool);
      }

      return new Response("ok");
    }
    // Adds a kid to a member's profile only — deliberately not synced into
    // any carpool they already belong to. updateUser overwrites a carpool's
    // Member.kids with the member's *entire* profile kids list, which is
    // wrong here: a co-parent might already be a member of a carpool for a
    // kid THEY don't share (e.g. Carmen is in a boys'-soccer carpool for
    // William only), and pushing her full kids list there would incorrectly
    // add Caroline to a carpool Caroline has nothing to do with. Carpool
    // membership for the added kid, if any, stays something the parent
    // opts into per carpool, same as any other kid.
    case "addKidToProfile": {
      const { memberId, kid } = body.payload as { memberId: string; kid: string };
      if (!memberId || !kid) return new Response("Invalid payload", { status: 400 });
      const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      if (!profile) return new Response("User not found", { status: 404 });
      if (!profile.kids.includes(kid)) {
        await store.setJSON(`profile:${memberId}`, { ...profile, kids: [...profile.kids, kid] });
      }
      return new Response("ok");
    }
    // Renames one kid string for a member everywhere it appears in their
    // own carpools — profile, each carpool's Member.kids row, and any car
    // that already has them explicitly assigned. Unlike updateUser (which
    // only ever touches Member.kids), this also fixes Car.kids so an
    // already-arranged ride doesn't go stale/orphaned under the old
    // spelling. Exists for reconciling a co-parent pair who each typed a
    // different spelling for the same kid (e.g. "Will" vs "William")
    // before either carpool data existed to notice. If oldName and newName
    // are already riding in two *different* cars on the same leg, that's a
    // real scheduling conflict, not just a spelling mismatch — left
    // untouched and reported back rather than silently picking a winner.
    case "mergeKidName": {
      const { memberId, oldName, newName } = body.payload as {
        memberId: string;
        oldName: string;
        newName: string;
      };
      if (!memberId || !oldName || !newName || oldName === newName) {
        return new Response("Invalid payload", { status: 400 });
      }

      const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      if (!profile) return new Response("User not found", { status: 404 });
      if (profile.kids.includes(oldName)) {
        const kids = profile.kids.filter((k) => k !== oldName);
        if (!kids.includes(newName)) kids.push(newName);
        await store.setJSON(`profile:${memberId}`, { ...profile, kids });
      }

      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      const carpoolsUpdated: { code: string; name: string }[] = [];
      const conflicts: { code: string; name: string; leg: "dropOff" | "pickUp" }[] = [];

      for (const code of codes) {
        const carpool = await loadSeries(store, code);
        if (!carpool) continue;
        let changed = false;

        const member = carpool.members.find((m) => m.id === memberId);
        if (member?.kids.includes(oldName)) {
          member.kids = member.kids.filter((k) => k !== oldName);
          if (!member.kids.includes(newName)) member.kids.push(newName);
          changed = true;
        }

        const era = currentEra(carpool);
        for (const [legName, leg] of [
          ["dropOff", era.defaultDropOff],
          ["pickUp", era.defaultPickUp],
        ] as const) {
          const oldCar = leg?.cars?.find((c) => c.kids.includes(oldName));
          if (!oldCar) continue;
          const newCar = leg.cars.find((c) => c !== oldCar && c.kids.includes(newName));
          if (newCar) {
            conflicts.push({ code, name: carpool.name, leg: legName });
            continue;
          }
          oldCar.kids = oldCar.kids.filter((k) => k !== oldName);
          if (!oldCar.kids.includes(newName)) oldCar.kids.push(newName);
          changed = true;
        }

        if (changed) {
          await store.setJSON(`code:${code}`, carpool);
          // Also pushes the (unconflicted) rename into every future
          // not-overridden occurrence — restampEra only ever reflects the
          // era's actual current defaults, so a leg that hit a conflict
          // above (and so was never actually changed) is simply re-stamped
          // unchanged, which is a no-op for that leg.
          await restampEra(store, carpool, era);
          carpoolsUpdated.push({ code, name: carpool.name });
        }
      }

      return new Response(JSON.stringify({ carpoolsUpdated, conflicts }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    case "deleteUser": {
      const { memberId } = body.payload;
      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      for (const code of codes) {
        const carpool = await loadSeries(store, code);
        if (!carpool) continue;
        const era = currentEra(carpool);
        dropMember(carpool, era, memberId);
        await applyEraChange(store, carpool, era);
      }
      const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      if (profile) {
        // Otherwise a dangling name:{name} claim points at a memberId that
        // no longer exists, so a matching duplicate (or the person signing
        // in again) can never claim it back on sign-in.
        const key = nameClaimKey(profile.name);
        if ((await store.get(key)) === memberId) await store.delete(key);
      }
      await store.delete(`profile:${memberId}`);
      await store.delete(`member:${memberId}`);
      return new Response("ok");
    }
    case "linkCoParents": {
      const { memberId, coParentId } = body.payload as { memberId: string; coParentId: string };
      if (memberId === coParentId) return new Response("Can't link a user to themselves", { status: 400 });
      const [profileA, profileB] = (await Promise.all([
        store.get(`profile:${memberId}`, { type: "json" }),
        store.get(`profile:${coParentId}`, { type: "json" }),
      ])) as [ServerProfile | null, ServerProfile | null];
      if (!profileA || !profileB) return new Response("User not found", { status: 404 });

      // backfillCoParentIntoCarpools only adds the co-parent to a carpool
      // where their kids actually overlap the existing member's — so if
      // one side's profile has no kids yet (e.g. a co-parent added via
      // admin with an empty kids field), that intersection is empty and
      // they'd never get added anywhere despite being "linked". Union the
      // kids into both profiles first so the overlap check has something
      // to find, mirroring the same merge profile.mts does on every save.
      const mergedKids = Array.from(new Set([...profileA.kids, ...profileB.kids]));
      if (mergedKids.length !== profileA.kids.length) {
        await store.setJSON(`profile:${memberId}`, { ...profileA, kids: mergedKids });
      }
      if (mergedKids.length !== profileB.kids.length) {
        await store.setJSON(`profile:${coParentId}`, { ...profileB, kids: mergedKids });
      }

      await store.set(`coparent:${memberId}`, coParentId);
      await store.set(`coparent:${coParentId}`, memberId);
      await backfillCoParentIntoCarpools(store, memberId, coParentId);
      await backfillCoParentIntoCarpools(store, coParentId, memberId);
      return new Response("ok");
    }
    case "unlinkCoParents": {
      const { memberId } = body.payload as { memberId: string };
      const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
      await store.delete(`coparent:${memberId}`);
      if (coParentId) {
        await store.delete(`coparent:${coParentId}`);
        await store.delete(`combined:${pairKey(memberId, coParentId)}`);
      }
      return new Response("ok");
    }
    case "setHouseholdCombined": {
      const { memberId, combined } = body.payload as { memberId: string; combined: boolean };
      const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
      if (!coParentId) return new Response("No linked co-parent", { status: 400 });
      await store.set(`combined:${pairKey(memberId, coParentId)}`, combined ? "true" : "false");
      return new Response("ok");
    }
    case "setMemberSeats": {
      const { code, memberId, leg, seats } = body.payload as {
        code: string;
        memberId: string;
        leg: "dropOff" | "pickUp";
        seats: number;
      };
      const carpool = await loadSeries(store, code);
      if (!carpool) return new Response("Not found", { status: 404 });
      const member = carpool.members.find((m) => m.id === memberId);
      if (!member) return new Response("Member not found", { status: 404 });
      const era = currentEra(carpool);
      const clamped = clampSeats(seats);
      const turnedOff = clamped === 0 && (leg === "dropOff" ? member.canDriveDropOff : member.canDrivePickUp);
      if (leg === "dropOff") member.canDriveDropOff = clamped > 0;
      else member.canDrivePickUp = clamped > 0;
      setSeats(leg === "dropOff" ? era.defaultDropOff : era.defaultPickUp, member, clamped);
      await applyEraChange(
        store,
        carpool,
        era,
        turnedOff
          ? { memberId, legs: { dropOff: leg === "dropOff", pickUp: leg === "pickUp" } }
          : undefined
      );
      return new Response("ok");
    }
    case "moveKid": {
      const { code, leg, kid, driverId } = body.payload as {
        code: string;
        leg: "dropOff" | "pickUp";
        kid: string;
        driverId: string | null;
      };
      const carpool = await loadSeries(store, code);
      if (!carpool) return new Response("Not found", { status: 404 });
      const era = currentEra(carpool);
      const target = leg === "dropOff" ? era.defaultDropOff : era.defaultPickUp;
      target.cars = moveKidCar(target.cars ?? [], kid, driverId, 1);
      await applyEraChange(store, carpool, era);
      return new Response("ok");
    }
    case "deleteCarpool": {
      const { code } = body.payload;
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as { members: Member[] } | null;
      if (carpool) {
        for (const m of carpool.members) await removeCodeFromMember(store, m.id, code);
      }
      await store.delete(`code:${code}`);
      const { blobs } = await store.list({ prefix: `occ:${code}:` });
      await Promise.all(blobs.map((b) => store.delete(b.key)));
      return new Response("ok");
    }
    case "addMember": {
      const { code, memberId } = body.payload;
      const carpool = await loadSeries(store, code);
      if (!carpool) return new Response("Not found", { status: 404 });
      if (carpool.members.some((m) => m.id === memberId)) return new Response("ok");

      const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      if (!profile) return new Response("User not found", { status: 404 });

      carpool.members.push({
        id: memberId,
        name: profile.name,
        kids: profile.kids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      });
      await autoAddCoParentToCarpool(store, carpool, memberId, profile.kids);
      await store.setJSON(`code:${code}`, carpool);

      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      if (!codes.includes(code)) await store.setJSON(`member:${memberId}`, [...codes, code]);

      return new Response("ok");
    }
    // Toggles one kid on/off for a household (a parent, or a linked
    // co-parent pair passed together as memberIds) within one carpool —
    // the admin-panel equivalent of a member editing their own kids in
    // CarpoolDetail, but usable without the household ever having signed
    // in themselves. Turning on prefers whichever household member is
    // already a carpool member (adding the kid to their row); if neither
    // is a member yet, adds the first id as a new member seeded with just
    // this kid, then mirrors autoAddCoParentToCarpool so a linked
    // co-parent who shares the kid gets pulled in too. Turning off strips
    // the kid from every household member's row and un-assigns them from
    // both legs' cars, but leaves member rows in place even if their kids
    // list goes empty, matching CarpoolDetail's own save-with-no-kids
    // behavior.
    case "toggleHouseholdKid": {
      const { code, memberIds, kid, on } = body.payload as {
        code: string;
        memberIds: string[];
        kid: string;
        on: boolean;
      };
      if (!code || !memberIds?.length || !kid) return new Response("Invalid payload", { status: 400 });
      const carpool = await loadSeries(store, code);
      if (!carpool) return new Response("Not found", { status: 404 });
      const era = currentEra(carpool);

      if (!on) {
        for (const m of carpool.members) {
          if (memberIds.includes(m.id)) m.kids = m.kids.filter((k) => k !== kid);
        }
        for (const leg of [era.defaultDropOff, era.defaultPickUp]) {
          leg.cars = (leg.cars ?? []).map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
        }
        await applyEraChange(store, carpool, era);
        return new Response("ok");
      }

      const existingMember = carpool.members.find((m) => memberIds.includes(m.id));
      let actingMemberId = existingMember?.id ?? memberIds[0];
      if (existingMember) {
        if (!existingMember.kids.includes(kid)) existingMember.kids = [...existingMember.kids, kid];
      } else {
        const memberId = memberIds[0];
        const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
        if (!profile) return new Response("User not found", { status: 404 });
        carpool.members.push({
          id: memberId,
          name: profile.name,
          kids: [kid],
          canDriveDropOff: false,
          canDrivePickUp: false,
          street: profile.street,
          zip: profile.zip,
        });
        const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
        if (!codes.includes(code)) await store.setJSON(`member:${memberId}`, [...codes, code]);
        actingMemberId = memberId;
      }

      await autoAddCoParentToCarpool(store, carpool, actingMemberId, [kid]);
      await applyEraChange(store, carpool, era);
      return new Response("ok");
    }
    case "removeMember": {
      const { code, memberId } = body.payload;
      const carpool = await loadSeries(store, code);
      if (!carpool) return new Response("Not found", { status: 404 });
      const era = currentEra(carpool);
      dropMember(carpool, era, memberId);
      await applyEraChange(store, carpool, era);
      await removeCodeFromMember(store, memberId, code);
      return new Response("ok");
    }
    // One-time migration for the move to per-leg seats: capacity used to
    // live only on the profile (a single `seats` number = total capacity
    // including the driver's own kid, applied to every carpool a member
    // drove). Now each `Car` in a leg carries its own `seats`, meaning "free
    // seats for other people's kids" directly — no profile-level default at
    // all, and a fresh sign-up starts at 1, same as pressing "+" once from
    // off. This migration exists purely so nobody who was ALREADY driving
    // before this shipped gets reset to 1: for any car that predates this
    // change (no `seats` field yet), seed it from that driver's old profile
    // `seats` value — checked on the carpool's own denormalized member row
    // first, then their profile blob, since either one might still carry
    // the legacy key — minus however many of the driver's own kids are
    // already riding in that car, to convert the old "total incl. own kid"
    // number into the new "free for others" one. Falls back to 1 only if no
    // legacy value exists at all. Anyone who signs up to drive after this
    // migration runs just gets the plain 1-seat default like everyone else.
    // Idempotent: records itself under "meta:legSeatsBackfill" and no-ops on
    // a second run unless forced.
    case "backfillCapacity": {
      const already = (await store.get("meta:legSeatsBackfill")) as string | null;
      if (already && !body.payload?.force) {
        return new Response(JSON.stringify({ skipped: true, ranAt: already }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const legacySeatsByMember = new Map<string, number>();
      const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
      for (const b of profileBlobs) {
        const profile = (await store.get(b.key, { type: "json" })) as { seats?: number } | null;
        if (profile?.seats !== undefined) {
          legacySeatsByMember.set(b.key.slice("profile:".length), profile.seats);
        }
      }

      // This backfill predates (and is unaffected by) the dates-not-days
      // schema migration — every car it could possibly touch either already
      // has `seats` or belongs to a carpool from before per-leg seats
      // existed, long since backfilled. It reads the legacy top-level
      // dropOff/pickUp shape directly and deliberately doesn't call
      // loadSeries: on an already-migrated (new-shape) blob, `.dropOff`
      // is simply undefined and `leg?.cars ?? []` safely no-ops rather than
      // crashing, which is exactly the do-nothing behavior wanted here.
      const { blobs: codeBlobs } = await store.list({ prefix: "code:" });
      let carsUpdated = 0;
      for (const b of codeBlobs) {
        const carpool = (await store.get(b.key, { type: "json" })) as
          | (Omit<Carpool, "recurrenceEras"> & { dropOff?: Leg; pickUp?: Leg })
          | null;
        if (!carpool) continue;
        let changed = false;

        for (const leg of [carpool.dropOff, carpool.pickUp]) {
          for (const car of leg?.cars ?? []) {
            if (car.seats !== undefined) continue;
            const driver = carpool.members.find((m) => m.id === car.driverId);
            const legacyTotal = (driver as (Member & { seats?: number }) | undefined)?.seats
              ?? legacySeatsByMember.get(car.driverId);
            if (legacyTotal === undefined) {
              car.seats = 1;
            } else {
              // The legacy number was total capacity including the driver's
              // own kid(s); the new per-leg number is free seats for OTHER
              // kids only, so subtract however many of the driver's own kids
              // are already riding in this car to land on the equivalent
              // free-seat count instead of resetting or double-counting.
              const ownKidsInCar = car.kids.filter((k) => driver?.kids.includes(k)).length;
              car.seats = Math.max(legacyTotal - ownKidsInCar, 0);
            }
            changed = true;
            carsUpdated++;
          }
        }

        if (changed) await store.setJSON(b.key, carpool);
      }

      await store.set("meta:legSeatsBackfill", new Date().toISOString());
      return new Response(JSON.stringify({ carsUpdated }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // Every carpool keeps its own denormalized copy of a member's shared
    // profile fields (name/street/zip), synced only when that member next
    // hits "Save changes" in ProfileEditor — so a carpool a save's fetch
    // missed (or a save from before that sync existed) can drift stale
    // indefinitely. This re-pushes current profile values to every carpool
    // for every member, matching exactly what ProfileEditor's own sync
    // does: name/street/zip only, never touching a carpool's own kids
    // subset or any car's per-leg seats (those aren't profile fields).
    case "resyncProfileFields": {
      const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
      let carpoolsUpdated = 0;
      for (const b of profileBlobs) {
        const profile = (await store.get(b.key, { type: "json" })) as ServerProfile | null;
        if (!profile) continue;
        const memberId = b.key.slice("profile:".length);

        const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
        for (const code of codes) {
          const carpool = await loadSeries(store, code);
          const m = carpool?.members.find((mm) => mm.id === memberId);
          if (!carpool || !m) continue;
          if (m.name === profile.name && m.street === profile.street && m.zip === profile.zip) {
            continue;
          }
          m.name = profile.name;
          m.street = profile.street;
          m.zip = profile.zip;
          await store.setJSON(`code:${code}`, carpool);
          carpoolsUpdated++;
        }
      }

      return new Response(JSON.stringify({ carpoolsUpdated }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // One-time backfill for carpools created before the `timezone` field
    // existed. Every carpool on prod so far is in Pacific time, so this
    // fills the gap directly rather than trying to infer a zone. Idempotent:
    // records itself under "meta:timezoneBackfill" and no-ops on a second
    // run unless forced. Only touches carpools that don't already have a
    // timezone set, so it's safe to re-run after new carpools (which now
    // always get one) exist.
    case "backfillTimezone": {
      const already = (await store.get("meta:timezoneBackfill")) as string | null;
      if (already && !body.payload?.force) {
        return new Response(JSON.stringify({ skipped: true, ranAt: already }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const { blobs: carpoolBlobs } = await store.list({ prefix: "code:" });
      let updated = 0;
      for (const b of carpoolBlobs) {
        const carpool = (await store.get(b.key, { type: "json" })) as Carpool | null;
        if (!carpool || carpool.timezone) continue;
        carpool.timezone = "America/Los_Angeles";
        await store.setJSON(b.key, carpool);
        updated++;
      }

      await store.set("meta:timezoneBackfill", new Date().toISOString());
      return new Response(JSON.stringify({ updated }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // One-time backfill for users whose profile was created or last edited
    // through the admin panel before createUser/updateUser started keeping
    // the name:{name} sign-in claim key in sync. Without that key, sign-in
    // (claim-name.mts) can't match the typed name back to this memberId, so
    // it silently creates a duplicate profile instead of recognizing the
    // returning user. Idempotent like backfillTimezone: records itself
    // under "meta:nameClaimBackfill" and no-ops on a second run unless
    // forced. Never overwrites a claim already held by a different member.
    case "backfillNameClaims": {
      const already = (await store.get("meta:nameClaimBackfill")) as string | null;
      if (already && !body.payload?.force) {
        return new Response(JSON.stringify({ skipped: true, ranAt: already }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
      let claimed = 0;
      for (const b of profileBlobs) {
        const profile = (await store.get(b.key, { type: "json" })) as ServerProfile | null;
        if (!profile) continue;
        const memberId = b.key.slice("profile:".length);
        const key = nameClaimKey(profile.name);
        const before = await store.get(key);
        await claimNameIfFree(store, profile.name, memberId);
        if ((await store.get(key)) !== before) claimed++;
      }

      await store.set("meta:nameClaimBackfill", new Date().toISOString());
      return new Response(JSON.stringify({ claimed }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // One-time backfill for co-parents linked before backfillCoParentIntoCarpools
    // existed (or before it merged kids at link time): re-runs the same
    // kid-merge + carpool-backfill that linkCoParents now does, for every
    // pair that's currently linked, in both directions. Pass payload.dryRun
    // to report what would change without writing anything — use this first
    // to check asymmetricLinks (a coparent: pointer that isn't reciprocated,
    // a sign of stale/corrupt link data) and possibleDuplicates (a carpool
    // that already has a different member with the same name as the
    // co-parent being added — skipped rather than risking a second row for
    // the same person under a leftover duplicate profile id). Idempotent
    // like the other backfills: records itself under
    // "meta:coParentCarpoolBackfill" and no-ops on a second real run unless
    // forced (dry runs never check or set that key).
    case "backfillCoParentCarpools": {
      const dryRun = !!body.payload?.dryRun;
      const already = (await store.get("meta:coParentCarpoolBackfill")) as string | null;
      if (already && !body.payload?.force && !dryRun) {
        return new Response(JSON.stringify({ skipped: true, ranAt: already }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const { blobs: coparentBlobs } = await store.list({ prefix: "coparent:" });
      const linkMap = new Map<string, string>();
      for (const b of coparentBlobs) {
        const partner = (await store.get(b.key)) as string | null;
        if (partner) linkMap.set(b.key.slice("coparent:".length), partner);
      }

      const asymmetricLinks: string[] = [];
      const seenPairs = new Set<string>();
      const pairs: [string, string][] = [];
      for (const [id, partner] of linkMap) {
        const pairKey = [id, partner].sort().join("|");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        if (linkMap.get(partner) !== id) {
          asymmetricLinks.push(`${id} -> ${partner} (but ${partner} -> ${linkMap.get(partner) ?? "nothing"})`);
          continue;
        }
        pairs.push([id, partner]);
      }

      const possibleDuplicates: string[] = [];
      let kidsMerged = 0;
      let carpoolsAdded = 0;

      for (const [a, b2] of pairs) {
        const profileA = (await store.get(`profile:${a}`, { type: "json" })) as ServerProfile | null;
        const profileB = (await store.get(`profile:${b2}`, { type: "json" })) as ServerProfile | null;
        if (!profileA || !profileB) continue;

        const mergedKids = Array.from(new Set([...profileA.kids, ...profileB.kids]));
        if (mergedKids.length !== profileA.kids.length || mergedKids.length !== profileB.kids.length) {
          kidsMerged++;
          if (!dryRun) {
            if (mergedKids.length !== profileA.kids.length) {
              await store.setJSON(`profile:${a}`, { ...profileA, kids: mergedKids });
            }
            if (mergedKids.length !== profileB.kids.length) {
              await store.setJSON(`profile:${b2}`, { ...profileB, kids: mergedKids });
            }
          }
        }
        profileA.kids = mergedKids;
        profileB.kids = mergedKids;

        for (const [ownerId, coParentId, coProfile] of [
          [a, b2, profileB],
          [b2, a, profileA],
        ] as const) {
          const codes = ((await store.get(`member:${ownerId}`, { type: "json" })) as string[] | null) ?? [];
          for (const code of codes) {
            const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
            if (!carpool || carpool.members.some((m) => m.id === coParentId)) continue;

            const nameCollision = carpool.members.find(
              (m) => m.name === coProfile.name && m.id !== coParentId
            );
            if (nameCollision) {
              possibleDuplicates.push(
                `Carpool ${code} ("${carpool.name}") already has a member named "${coProfile.name}" under id ${nameCollision.id}, different from linked co-parent id ${coParentId} — skipped to avoid a duplicate row`
              );
              continue;
            }

            const owner = carpool.members.find((m) => m.id === ownerId);
            if (!owner) continue;
            const sharedKids = owner.kids.filter((k) => coProfile.kids.includes(k));
            if (sharedKids.length === 0) continue;

            carpoolsAdded++;
            if (!dryRun) {
              carpool.members.push({
                id: coParentId,
                name: coProfile.name,
                kids: sharedKids,
                canDriveDropOff: false,
                canDrivePickUp: false,
                street: coProfile.street,
                zip: coProfile.zip,
              });
              await store.setJSON(`code:${code}`, carpool);
              const existing =
                ((await store.get(`member:${coParentId}`, { type: "json" })) as string[] | null) ?? [];
              if (!existing.includes(code)) {
                await store.setJSON(`member:${coParentId}`, [...existing, code]);
              }
            }
          }
        }
      }

      if (!dryRun) await store.set("meta:coParentCarpoolBackfill", new Date().toISOString());

      return new Response(
        JSON.stringify({ dryRun, pairsChecked: pairs.length, asymmetricLinks, possibleDuplicates, kidsMerged, carpoolsAdded }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    default:
      return new Response("Unknown action", { status: 400 });
  }
}

export default async (req: Request) => {
  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });

  if (req.method === "POST") return handleMutation(store, req);

  const expected = process.env.ADMIN_KEY;
  const key = new URL(req.url).searchParams.get("key");
  if (!expected || key !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
  const users = (
    await Promise.all(
      profileBlobs.map(async (b) => {
        const profile = (await store.get(b.key, { type: "json" })) as ServerProfile | null;
        if (!profile) return null;
        const memberId = b.key.slice("profile:".length);

        const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
        let coParentName: string | null = null;
        let householdCombined = false;
        if (coParentId) {
          const coProfile = (await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null;
          coParentName = coProfile?.name ?? null;
          householdCombined = (await store.get(`combined:${pairKey(memberId, coParentId)}`)) === "true";
        }
        const coParentCode = (await store.get(`household-owner:${memberId}`)) as string | null;

        return { memberId, ...profile, coParentId, coParentName, householdCombined, coParentCode };
      })
    )
  ).filter(Boolean);

  const { blobs: codeBlobs } = await store.list({ prefix: "code:" });
  const carpools = (
    await Promise.all(codeBlobs.map((b) => loadSeries(store, b.key.slice("code:".length))))
  ).filter(Boolean) as Carpool[];
  const occurrences = (await Promise.all(carpools.map((c) => listOccurrences(store, c.code)))).flat();

  return new Response(JSON.stringify({ users, carpools, occurrences }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/data",
};
