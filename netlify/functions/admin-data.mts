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
  timezone?: string;
};

// Keep a leg's car list in sync with a member's driving toggle: drop their
// car if they can no longer drive it, or give them one (defaulting to their
// own unclaimed kids) if they now can and don't have one yet. Mirrors
// syncCar in carpools-join.mts so admin toggles behave the same as a member
// flipping their own toggle.
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
  leg.cars.push({ driverId: member.id, kids: unclaimedOwnKids });
}

// Mirrors moveKid in CarpoolDetail.tsx: pull the kid out of whatever car
// they're currently in, then drop them into driverId's car (creating it if
// the driver doesn't have one yet), or leave them unassigned if driverId is
// null.
function moveKidCar(cars: Car[], kid: string, driverId: string | null): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  if (!cleared.some((c) => c.driverId === driverId)) {
    return [...cleared, { driverId, kids: [kid] }];
  }
  return cleared.map((c) => (c.driverId === driverId ? { ...c, kids: [...c.kids, kid] } : c));
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
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
    });
    await store.setJSON(`code:${code}`, carpool);

    const coParentCodes = ((await store.get(`member:${coParentId}`, { type: "json" })) as string[] | null) ?? [];
    if (!coParentCodes.includes(code)) {
      await store.setJSON(`member:${coParentId}`, [...coParentCodes, code]);
    }
  }
}

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

      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      for (const code of codes) {
        const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
        if (!carpool) continue;
        const m = carpool.members.find((mm) => mm.id === memberId);
        if (!m) continue;
        m.name = name;
        m.seats = seats;
        m.kids = kids;
        m.street = street;
        m.zip = zip;
        await store.setJSON(`code:${code}`, carpool);
      }

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
    case "linkCoParents": {
      const { memberId, coParentId } = body.payload as { memberId: string; coParentId: string };
      if (memberId === coParentId) return new Response("Can't link a user to themselves", { status: 400 });
      const [profileA, profileB] = await Promise.all([
        store.get(`profile:${memberId}`, { type: "json" }),
        store.get(`profile:${coParentId}`, { type: "json" }),
      ]);
      if (!profileA || !profileB) return new Response("User not found", { status: 404 });

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
    case "updateCarpool": {
      const { code, name, day, destination, dropOffTime, pickUpTime } = body.payload;
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (!carpool) return new Response("Not found", { status: 404 });
      carpool.name = name;
      carpool.day = day;
      carpool.destination = destination;
      carpool.dropOff ??= { time: "", cars: [] };
      carpool.pickUp ??= { time: "", cars: [] };
      if (dropOffTime !== undefined) carpool.dropOff.time = dropOffTime;
      if (pickUpTime !== undefined) carpool.pickUp.time = pickUpTime;
      await store.setJSON(`code:${code}`, carpool);
      return new Response("ok");
    }
    case "setMemberDriving": {
      const { code, memberId, leg, value } = body.payload as {
        code: string;
        memberId: string;
        leg: "dropOff" | "pickUp";
        value: boolean;
      };
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (!carpool) return new Response("Not found", { status: 404 });
      const member = carpool.members.find((m) => m.id === memberId);
      if (!member) return new Response("Member not found", { status: 404 });
      carpool.dropOff ??= { time: "", cars: [] };
      carpool.pickUp ??= { time: "", cars: [] };
      if (leg === "dropOff") member.canDriveDropOff = value;
      else member.canDrivePickUp = value;
      syncCar(leg === "dropOff" ? carpool.dropOff : carpool.pickUp, member, value);
      await store.setJSON(`code:${code}`, carpool);
      return new Response("ok");
    }
    case "moveKid": {
      const { code, leg, kid, driverId } = body.payload as {
        code: string;
        leg: "dropOff" | "pickUp";
        kid: string;
        driverId: string | null;
      };
      const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
      if (!carpool) return new Response("Not found", { status: 404 });
      carpool.dropOff ??= { time: "", cars: [] };
      carpool.pickUp ??= { time: "", cars: [] };
      const target = leg === "dropOff" ? carpool.dropOff : carpool.pickUp;
      target.cars = moveKidCar(target.cars ?? [], kid, driverId);
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
    // One-time backfill for the seats -> capacity change: `seats` used to mean
    // "free seats for other people's kids" (a driver's own kids never
    // consumed one); now it means total car capacity including the driver's
    // own kids. Old values are reinterpreted as capacity = oldSeats +
    // ownKidCount, both in each profile and in every carpool's denormalized
    // copy of that member's row. Idempotent: records itself under
    // "meta:capacityBackfill" and no-ops on a second run unless forced.
    case "backfillCapacity": {
      const already = (await store.get("meta:capacityBackfill")) as string | null;
      if (already && !body.payload?.force) {
        return new Response(JSON.stringify({ skipped: true, ranAt: already }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
      let updated = 0;
      for (const b of profileBlobs) {
        const profile = (await store.get(b.key, { type: "json" })) as ServerProfile | null;
        if (!profile) continue;
        const newSeats = profile.seats + profile.kids.length;
        if (newSeats === profile.seats) continue;

        const memberId = b.key.slice("profile:".length);
        await store.setJSON(b.key, { ...profile, seats: newSeats });

        const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
        for (const code of codes) {
          const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
          const m = carpool?.members.find((mm) => mm.id === memberId);
          if (!carpool || !m) continue;
          m.seats = newSeats;
          await store.setJSON(`code:${code}`, carpool);
        }
        updated++;
      }

      await store.set("meta:capacityBackfill", new Date().toISOString());
      return new Response(JSON.stringify({ updated }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // Every carpool keeps its own denormalized copy of a member's shared
    // profile fields (name/seats/street/zip), synced only when that member
    // next hits "Save changes" in ProfileEditor — so a carpool a save's fetch
    // missed (or a save from before that sync existed) can drift stale
    // indefinitely. This re-pushes current profile values to every carpool
    // for every member, matching exactly what ProfileEditor's own sync does:
    // name/seats/street/zip only, never touching a carpool's own kids subset
    // (that's per-carpool, not a copy of the household's full kid list).
    case "resyncProfileFields": {
      const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
      let carpoolsUpdated = 0;
      for (const b of profileBlobs) {
        const profile = (await store.get(b.key, { type: "json" })) as ServerProfile | null;
        if (!profile) continue;
        const memberId = b.key.slice("profile:".length);

        const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
        for (const code of codes) {
          const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
          const m = carpool?.members.find((mm) => mm.id === memberId);
          if (!carpool || !m) continue;
          if (
            m.name === profile.name &&
            m.seats === profile.seats &&
            m.street === profile.street &&
            m.zip === profile.zip
          ) {
            continue;
          }
          m.name = profile.name;
          m.seats = profile.seats;
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

        return { memberId, ...profile, coParentId, coParentName, householdCombined };
      })
    )
  ).filter(Boolean);

  const { blobs: codeBlobs } = await store.list({ prefix: "code:" });
  const carpools = (
    await Promise.all(codeBlobs.map((b) => store.get(b.key, { type: "json" })))
  ).filter(Boolean) as Carpool[];

  return new Response(JSON.stringify({ users, carpools }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/data",
};
