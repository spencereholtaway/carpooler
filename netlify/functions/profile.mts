import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; kids: string[]; street: string; zip: string };

export default async (req: Request) => {
  const store = getStore("carpools", { consistency: "strong" });

  if (req.method === "GET") {
    const memberId = new URL(req.url).searchParams.get("memberId");
    if (!memberId) return new Response("Missing memberId", { status: 400 });

    const profile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
    if (!profile) return new Response("Not found", { status: 404 });

    return new Response(JSON.stringify(profile), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const { memberId, profile } = (await req.json()) as { memberId?: string; profile?: ServerProfile };
    if (!memberId || !profile) return new Response("Missing fields", { status: 400 });

    await store.setJSON(`profile:${memberId}`, profile);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/profile",
};
