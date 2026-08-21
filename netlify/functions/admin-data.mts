import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; kids: string[]; street: string; zip: string };
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
// own unclaimed kids) if they now can and don't have one yet — starting at 1
// seat, same as pressing "+" once from off, since there's no profile default
// to seed from. Mirrors syncCar in carpools-join.mts so admin toggles behave
// the same as a member flipping their own toggle. An existing car's seat
// count is left alone — that's a per-leg value edited directly, not
// something a driving-toggle sync should clobber.
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
// duplicate profile. Never steals a name already claimed by someone else.
async function claimNameIfFree(store: ReturnType<typeof getStore>, name: string, memberId: string) {
  const key = nameClaimKey(name);
  const existing = await store.get(key);
  if (!existing || existing === memberId) await store.set(key, memberId);
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
    const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
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
      const { name, kids, street, zip } = body.payload;
      const memberId = crypto.randomUUID();
      const profile: ServerProfile = { name, kids: kids ?? [], street, zip };
      await store.setJSON(`profile:${memberId}`, profile);
      await store.setJSON(`member:${memberId}`, []);
      await ensureHouseholdCode(store, memberId);
      await claimNameIfFree(store, name, memberId);
      return new Response(JSON.stringify({ memberId }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    case "updateUser": {
      const { memberId, name, kids, street, zip } = body.payload;
      const oldProfile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
      const profile: ServerProfile = { name, kids, street, zip };
      await store.setJSON(`profile:${memberId}`, profile);

      if (oldProfile && nameClaimKey(oldProfile.name) !== nameClaimKey(name)) {
        const oldKey = nameClaimKey(oldProfile.name);
        if ((await store.get(oldKey)) === memberId) await store.delete(oldKey);
      }
      await claimNameIfFree(store, name, memberId);

      const codes = ((await store.get(`member:${memberId}`, { type: "json" })) as string[] | null) ?? [];
      for (const code of codes) {
        const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
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
        const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
        if (!carpool) continue;
        let changed = false;

        const member = carpool.members.find((m) => m.id === memberId);
        if (member?.kids.includes(oldName)) {
          member.kids = member.kids.filter((k) => k !== oldName);
          if (!member.kids.includes(newName)) member.kids.push(newName);
          changed = true;
        }

        for (const [legName, leg] of [
          ["dropOff", carpool.dropOff],
          ["pickUp", carpool.pickUp],
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
      target.cars = moveKidCar(target.cars ?? [], kid, driverId, 1);
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

      const { blobs: codeBlobs } = await store.list({ prefix: "code:" });
      let carsUpdated = 0;
      for (const b of codeBlobs) {
        const carpool = (await store.get(b.key, { type: "json" })) as Carpool | null;
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
          const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
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
        const existing = await store.get(key);
        if (!existing) {
          await store.set(key, memberId);
          claimed++;
        }
      }

      await store.set("meta:nameClaimBackfill", new Date().toISOString());
      return new Response(JSON.stringify({ claimed }), {
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
        const coParentCode = (await store.get(`household-owner:${memberId}`)) as string | null;

        return { memberId, ...profile, coParentId, coParentName, householdCombined, coParentCode };
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
