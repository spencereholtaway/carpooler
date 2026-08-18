import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Leg = { time: string; driverId: string | null };
type Address = { street: string; zip: string };
type Carpool = {
  code: string;
  name: string;
  day: string;
  destination: Address;
  dropOff: Leg;
  pickUp: Leg;
  members: { id: string }[];
  createdAt: number;
};

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { code, day, destination, dropOff, pickUp } = (await req.json()) as {
    code: string;
    day: string;
    destination: Address;
    dropOff: Leg;
    pickUp: Leg;
  };
  if (!code || !day) return new Response("Missing fields", { status: 400 });

  const store = getStore("carpools");
  const carpool = (await store.get(`code:${code}`, { type: "json" })) as Carpool | null;
  if (!carpool) return new Response("No carpool with that code", { status: 404 });

  const validDriverId = (id: string | null) =>
    id === null || carpool.members.some((m) => m.id === id);

  carpool.day = day;
  carpool.destination = { street: destination?.street ?? "", zip: destination?.zip ?? "" };
  carpool.dropOff = {
    time: dropOff?.time ?? "",
    driverId: validDriverId(dropOff?.driverId ?? null) ? dropOff?.driverId ?? null : null,
  };
  carpool.pickUp = {
    time: pickUp?.time ?? "",
    driverId: validDriverId(pickUp?.driverId ?? null) ? pickUp?.driverId ?? null : null,
  };

  await store.setJSON(`code:${code}`, carpool);

  return new Response(JSON.stringify(carpool), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/carpools/schedule",
};
