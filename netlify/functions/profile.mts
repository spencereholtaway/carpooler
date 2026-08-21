import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; kids: string[]; street: string; zip: string };

function randomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Mirrors household.mts's lazy code generation, but run eagerly whenever a
// profile is saved so every user has a co-parent invite code from the
// start instead of only once they first open the invite screen. Cheap and
// idempotent for returning users re-saving their profile — it's a no-op
// once a code already exists.
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
    await ensureHouseholdCode(store, memberId);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/profile",
};
