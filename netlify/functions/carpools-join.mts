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
type ServerProfile = { name: string; seats: number; kids: string[]; street: string; zip: string };
type Car = { driverId: string; kids: string[] };
type Leg = { time: string; cars: Car[] };
type Carpool = {
  code: string;
  name: string;
  day: string;
  dropOff: Leg;
  pickUp: Leg;
  members: Member[];
  createdAt: number;
};

// If this member has a linked co-parent who shares one of the kids just
// assigned, add the co-parent too — but never mark them as able to drive,
// that's always a separate, explicit choice each person makes for themselves.
async function autoAddCoParent(
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
    seats: coProfile.seats,
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

// Keep a leg's car list in sync with a member's driving toggle: drop their
// car if they can no longer drive it, or give them one (defaulting to their
// own unclaimed kids) if they now can and don't have one yet.
function syncCar(leg: Leg, member: Member, canDrive: boolean) {
  leg.cars ??= [];
  if (!canDrive) {
    leg.cars = leg.cars.filter((c) => c.driverId !== member.id);
    return;
  }
  if (leg.cars.some((c) => c.driverId === member.id)) return;
  const claimed = new Set(leg.cars.flatMap((c) => c.kids));
  leg.cars.push({ driverId: member.id, kids: member.kids.filter((k) => !claimed.has(k)) });
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { code, member } = (await req.json()) as { code: string; member: Member };
  if (!code || !member?.id || !member?.name) {
    return new Response("Missing fields", { status: 400 });
  }

  const store = getStore("carpools");
  const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
  if (!carpool) return new Response("No carpool with that code", { status: 404 });

  // The client can't be trusted to know its own household link (it may be
  // stale or forged), so look it up server-side rather than trust the body.
  member.coparentId = (await store.get(`coparent:${member.id}`)) as string | null;

  const existingIndex = carpool.members.findIndex((m) => m.id === member.id);
  const isNewJoin = existingIndex === -1;
  if (isNewJoin) {
    carpool.members.push(member);
  } else {
    carpool.members[existingIndex] = member;
  }

  carpool.dropOff ??= { time: "", cars: [] };
  carpool.pickUp ??= { time: "", cars: [] };
  syncCar(carpool.dropOff, member, member.canDriveDropOff);
  syncCar(carpool.pickUp, member, member.canDrivePickUp);

  if (isNewJoin) {
    await autoAddCoParent(store, carpool, member.id, member.kids);
  }

  await store.setJSON(`code:${code}`, carpool);

  for (const m of isNewJoin ? carpool.members : [member]) {
    const memberCarpools = ((await store.get(`member:${m.id}`, { type: "json" })) as string[] | null) ?? [];
    if (!memberCarpools.includes(code)) {
      await store.setJSON(`member:${m.id}`, [...memberCarpools, code]);
    }
  }

  return new Response(JSON.stringify(carpool), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/carpools/join",
};
