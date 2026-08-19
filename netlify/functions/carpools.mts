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

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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

export default async (req: Request) => {
  const store = getStore("carpools", { consistency: "strong" });

  if (req.method === "GET") {
    const memberId = new URL(req.url).searchParams.get("memberId");
    if (!memberId) return new Response("Missing memberId", { status: 400 });

    const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
    const carpools = (
      await Promise.all(
        codes.map((code) => store.get(`code:${code}`, { type: "json", consistency: "eventual" }))
      )
    ).filter(Boolean) as Carpool[];

    return new Response(JSON.stringify(carpools), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const { name, day, destination, dropOff, pickUp, member } = (await req.json()) as {
      name: string;
      day: string;
      destination: Address;
      dropOff: Leg;
      pickUp: Leg;
      member: Member;
    };
    if (!name || !day || !member?.id || !member?.name) {
      return new Response("Missing fields", { status: 400 });
    }

    let code = randomCode();
    for (let i = 0; i < 10 && (await store.get(`code:${code}`)); i++) {
      code = randomCode();
    }

    member.coparentId = (await store.get(`coparent:${member.id}`)) as string | null;

    const carpool: Carpool = {
      code,
      name,
      day,
      destination: destination ?? { street: "", zip: "" },
      dropOff: { time: dropOff?.time ?? "", cars: [] },
      pickUp: { time: pickUp?.time ?? "", cars: [] },
      members: [member],
      createdAt: Date.now(),
    };

    await autoAddCoParent(store, carpool, member.id, member.kids);

    await store.setJSON(`code:${code}`, carpool);

    for (const m of carpool.members) {
      const existing = ((await store.get(`member:${m.id}`, { type: "json" })) as string[] | null) ?? [];
      if (!existing.includes(code)) {
        await store.setJSON(`member:${m.id}`, [...existing, code]);
      }
    }

    return new Response(JSON.stringify(carpool), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/carpools",
};
