import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; seats: number; kids: string[]; street: string; zip: string };

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { memberId, profile } = (await req.json()) as { memberId?: string; profile?: ServerProfile };
  if (!memberId || !profile) return new Response("Missing fields", { status: 400 });

  const store = getStore("carpools");
  await store.setJSON(`profile:${memberId}`, profile);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/profile",
};
