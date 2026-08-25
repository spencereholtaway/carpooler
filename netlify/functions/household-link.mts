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
type RecurrenceEra = {
  startDate: string;
  endDate: string | null;
  type: "weekly" | "biweekly" | "oneoff";
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
  timezone: string;
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekdayIndexISO(iso: string): number {
  return (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;
}
function nextDateForWeekday(day: DayOfWeek): string {
  const today = todayISO();
  const diff = (DAY_INDEX[day] - weekdayIndexISO(today) + 7) % 7;
  return addDaysISO(today, diff);
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
// A lighter loadSeries than carpools.mts's — migrates the legacy shape in
// place but deliberately doesn't generate occurrences here (this endpoint
// only ever touches `.members`, never a schedule/driver field). Any
// endpoint that later reads this series generates its occurrences then;
// that's fine, generation is purely additive and idempotent.
async function loadSeriesForMembers(store: ReturnType<typeof getStore>, code: string): Promise<Carpool | null> {
  const raw = await store.get(`code:${code}`, { type: "json" });
  if (!raw) return null;
  if (isLegacyShape(raw)) {
    const migrated = migrateLegacyCarpool(raw);
    await store.setJSON(`code:${code}`, migrated);
    return migrated;
  }
  return raw as Carpool;
}

// Retroactively add `coParentId` to any carpool where `ownerId` is already a
// member and shares a kid with them — covers the case where the household
// link is made *after* one parent already joined/started the carpool, which
// is when the link is most commonly formed in practice.
async function backfillCoParentIntoCarpools(
  store: ReturnType<typeof getStore>,
  ownerId: string,
  coParentId: string
) {
  const coProfile = (await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null;
  if (!coProfile) return;

  const codes = ((await store.get(`member:${ownerId}`, { type: "json" })) as string[] | null) ?? [];
  for (const code of codes) {
    const carpool = await loadSeriesForMembers(store, code);
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
      coparentId: ownerId,
    });
    await store.setJSON(`code:${code}`, carpool);

    const coParentCarpools = ((await store.get(`member:${coParentId}`, { type: "json" })) as string[] | null) ?? [];
    if (!coParentCarpools.includes(code)) {
      await store.setJSON(`member:${coParentId}`, [...coParentCarpools, code]);
    }
  }
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { code, memberId } = (await req.json()) as { code?: string; memberId?: string };
  if (!code || !memberId) return new Response("Missing fields", { status: 400 });

  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });
  const inviterId = (await store.get(`household:${code}`)) as string | null;
  if (!inviterId) return new Response("No invite with that code", { status: 404 });
  if (inviterId === memberId) return new Response("That's your own invite code", { status: 400 });

  await store.set(`coparent:${memberId}`, inviterId);
  await store.set(`coparent:${inviterId}`, memberId);

  await backfillCoParentIntoCarpools(store, inviterId, memberId);
  await backfillCoParentIntoCarpools(store, memberId, inviterId);

  const inviterProfile = (await store.get(`profile:${inviterId}`, { type: "json" })) as ServerProfile | null;

  return new Response(
    JSON.stringify({
      coParentId: inviterId,
      coParentName: inviterProfile?.name ?? null,
      coParentKids: inviterProfile?.kids ?? [],
      coParentStreet: inviterProfile?.street ?? null,
      coParentZip: inviterProfile?.zip ?? null,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/household/link",
};
