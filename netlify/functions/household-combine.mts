import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { memberId, combined } = (await req.json()) as { memberId?: string; combined?: boolean };
  if (!memberId || typeof combined !== "boolean") return new Response("Missing fields", { status: 400 });

  const store = getStore("carpools", { consistency: "strong" });
  const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
  if (!coParentId) return new Response("No linked co-parent", { status: 400 });

  await store.set(`combined:${pairKey(memberId, coParentId)}`, combined ? "true" : "false");

  return new Response(JSON.stringify({ combined }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/household/combine",
};
