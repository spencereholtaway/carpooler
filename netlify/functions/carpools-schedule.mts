import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

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
  members: { id: string; kids: string[]; canDriveDropOff: boolean; canDrivePickUp: boolean }[];
  createdAt: number;
};

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
    if (isEligible || kids.length > 0) cars.push({ driverId: car.driverId, kids });
  }
  return { time: leg?.time ?? "", cars };
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { code, day, destination, dropOff, pickUp, name } = (await req.json()) as {
    code: string;
    day: string;
    destination: Address;
    dropOff: Leg;
    pickUp: Leg;
    name?: string;
  };
  if (!code || !day) return new Response("Missing fields", { status: 400 });

  const store = getStore("carpools", { consistency: "strong" });
  const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
  if (!carpool) return new Response("No carpool with that code", { status: 404 });

  const dropOffEligible = new Set(
    carpool.members.filter((m) => m.canDriveDropOff).map((m) => m.id)
  );
  const pickUpEligible = new Set(
    carpool.members.filter((m) => m.canDrivePickUp).map((m) => m.id)
  );
  const ownKidsByMember = new Map(carpool.members.map((m) => [m.id, new Set(m.kids)]));

  if (name && name.trim()) carpool.name = name.trim();
  carpool.day = day;
  carpool.destination = { street: destination?.street ?? "", zip: destination?.zip ?? "" };
  carpool.dropOff = sanitizeLeg(dropOff, dropOffEligible, ownKidsByMember);
  carpool.pickUp = sanitizeLeg(pickUp, pickUpEligible, ownKidsByMember);

  await store.setJSON(`code:${code}`, carpool);

  return new Response(JSON.stringify(carpool), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/carpools/schedule",
};
