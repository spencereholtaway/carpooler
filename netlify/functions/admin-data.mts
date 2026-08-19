import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; seats: number; kids: string[]; street: string; zip: string };
type Member = {
  id: string;
  name: string;
  seats: number;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
  street: string;
  zip: string;
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

async function removeCodeFromMember(store: ReturnType<typeof getStore>, memberId: string, code: string) {
  const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
  await store.setJSON(`member:${memberId}`, codes.filter((c) => c !== code));
}

function dropMember(carpool: Carpool, memberId: string) {
  const leaving = carpool.members.find((m) => m.id === memberId);
  carpool.members = carpool.members.filter((m) => m.id !== memberId);
  carpool.dropOff ??= { time: "", cars: [] };
  carpool.pickUp ??= { time: "", cars: [] };
  carpool.dropOff.cars = (carpool.dropOff.cars ?? []).filter((c) => c.driverId !== memberId);
  carpool.pickUp.cars = (carpool.pickUp.cars ?? []).filter((c) => c.driverId !== memberId);

  // Their kid(s) may still be sitting in someone else's car from an earlier
  // move — unless a co-parent still legitimately claims them, that ride is
  // no longer valid for anyone now that this member is gone.
  const stillOwned = new Set(carpool.members.flatMap((m) => m.kids));
  const kidsToClear = (leaving?.kids ?? []).filter((k) => !stillOwned.has(k));
  if (kidsToClear.length > 0) {
    const removeSet = new Set(kidsToClear);
    for (const leg of [carpool.dropOff, carpool.pickUp]) {
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
      const { name, seats, kids, street, zip } = body.payload;
      const memberId = crypto.randomUUID();
      const profile: ServerProfile = { name, seats: Number(seats) || 0, kids: kids ?? [], street, zip };
      await store.setJSON(`profile:${memberId}`, profile);
      await store.setJSON(`member:${memberId}`, []);
      return new Response(JSON.stringify({ memberId }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    case "updateUser": {
      const { memberId, name, seats, kids, street, zip } = body.payload;
      const profile: ServerProfile = { name, seats, kids, street, zip };
      await store.setJSON(`profile:${memberId}`, profile);
      return new Response("ok");
    }
    case "deleteUser": {
      const { memberId } = body.payload;
      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      for (const code of codes) {
        const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
        if (!carpool) continue;
        dropMember(carpool, memberId);
        await store.setJSON(`code:${code}`, carpool);
      }
      await store.delete(`profile:${memberId}`);
      await store.delete(`member:${memberId}`);
      return new Response("ok");
    }
    case "updateCarpool": {
      const { code, name, day, destination } = body.payload;
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (!carpool) return new Response("Not found", { status: 404 });
      carpool.name = name;
      carpool.day = day;
      carpool.destination = destination;
      await store.setJSON(`code:${code}`, carpool);
      return new Response("ok");
    }
    case "deleteCarpool": {
      const { code } = body.payload;
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (carpool) {
        for (const m of carpool.members) await removeCodeFromMember(store, m.id, code);
      }
      await store.delete(`code:${code}`);
      return new Response("ok");
    }
    case "addMember": {
      const { code, memberId } = body.payload;
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (!carpool) return new Response("Not found", { status: 404 });
      if (carpool.members.some((m) => m.id === memberId)) return new Response("ok");

      const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      if (!profile) return new Response("User not found", { status: 404 });

      carpool.members.push({
        id: memberId,
        name: profile.name,
        seats: profile.seats,
        kids: profile.kids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      });
      await store.setJSON(`code:${code}`, carpool);

      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      if (!codes.includes(code)) await store.setJSON(`member:${memberId}`, [...codes, code]);

      return new Response("ok");
    }
    case "removeMember": {
      const { code, memberId } = body.payload;
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (!carpool) return new Response("Not found", { status: 404 });
      dropMember(carpool, memberId);
      await store.setJSON(`code:${code}`, carpool);
      await removeCodeFromMember(store, memberId, code);
      return new Response("ok");
    }
    default:
      return new Response("Unknown action", { status: 400 });
  }
}

export default async (req: Request) => {
  const store = getStore("carpools", { consistency: "strong" });

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
        const profile = (await store.get(b.key, { type: "json", consistency: "eventual" })) as ServerProfile | null;
        if (!profile) return null;
        return { memberId: b.key.slice("profile:".length), ...profile };
      })
    )
  ).filter(Boolean);

  const { blobs: codeBlobs } = await store.list({ prefix: "code:" });
  const carpools = (
    await Promise.all(codeBlobs.map((b) => store.get(b.key, { type: "json", consistency: "eventual" })))
  ).filter(Boolean) as Carpool[];

  return new Response(JSON.stringify({ users, carpools }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/data",
};
