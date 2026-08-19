import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { name, memberId } = (await req.json()) as { name?: string; memberId?: string };
  if (!name?.trim() || !memberId) {
    return new Response("Missing fields", { status: 400 });
  }

  const key = `name:${name.trim().toLowerCase()}`;
  const store = getStore("carpools", { consistency: "strong" });
  const claimedBy = await store.get(key);

  if (claimedBy) {
    // Someone already owns this name — could be this same browser's identity
    // with a lost local profile, or a genuinely different device. Either way
    // there's no password here, so typing a known name back in always means
    // "log back in as that person" rather than silently creating a duplicate.
    return new Response(JSON.stringify({ recovered: true, memberId: claimedBy }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  await store.set(key, memberId);
  return new Response(JSON.stringify({ recovered: false, memberId }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/claim-name",
};
