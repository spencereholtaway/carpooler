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
    const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
    if (!carpool || carpool.members.some((m) => m.id === coParentId)) continue;

    const owner = carpool.members.find((m) => m.id === ownerId);
    if (!owner) continue;
    const sharedKids = owner.kids.filter((k) => coProfile.kids.includes(k));
    if (sharedKids.length === 0) continue;

    carpool.members.push({
      id: coParentId,
      name: coProfile.name,
      seats: coProfile.seats,
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

  const store = getStore("carpools");
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
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/household/link",
};
