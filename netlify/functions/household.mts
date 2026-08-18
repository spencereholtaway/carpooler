import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; seats: number; kids: string[]; street: string; zip: string };

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const memberId = new URL(req.url).searchParams.get("memberId");
  if (!memberId) return new Response("Missing memberId", { status: 400 });

  const store = getStore("carpools");

  let code = (await store.get(`household-owner:${memberId}`)) as string | null;
  if (!code) {
    code = randomCode();
    for (let i = 0; i < 10 && (await store.get(`household:${code}`)); i++) {
      code = randomCode();
    }
    await store.set(`household:${code}`, memberId);
    await store.set(`household-owner:${memberId}`, code);
  }

  const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
  let coParentName: string | null = null;
  if (coParentId) {
    const coProfile = (await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null;
    coParentName = coProfile?.name ?? null;
  }

  return new Response(JSON.stringify({ code, coParentId, coParentName }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/household",
};
