import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; seats: number; kids: string[]; street: string; zip: string };
type Member = {
  id: string;
  name: string;
  seats: number;
  kids: string[];
  isDriving: boolean;
  street: string;
  zip: string;
};
type Leg = { time: string; driverId: string | null };
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

export default async (req: Request) => {
  const expected = process.env.ADMIN_KEY;
  const key = new URL(req.url).searchParams.get("key");
  if (!expected || key !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const store = getStore("carpools");

  const { blobs: profileBlobs } = await store.list({ prefix: "profile:" });
  const users = (
    await Promise.all(
      profileBlobs.map(async (b) => {
        const profile = (await store.get(b.key, { type: "json" })) as ServerProfile | null;
        if (!profile) return null;
        return { memberId: b.key.slice("profile:".length), ...profile };
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
