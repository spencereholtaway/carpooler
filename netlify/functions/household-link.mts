import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type ServerProfile = { name: string; seats: number; kids: string[]; street: string; zip: string };

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { code, memberId } = (await req.json()) as { code?: string; memberId?: string };
  if (!code || !memberId) return new Response("Missing fields", { status: 400 });

  const store = getStore("carpools");
  const inviterId = (await store.get(`household:${code}`)) as string | null;
  if (!inviterId) return new Response("No invite with that code", { status: 404 });
  if (inviterId === memberId) return new Response("That's your own invite code", { status: 400 });

  await store.set(`coparent:${memberId}`, inviterId);
  await store.set(`coparent:${inviterId}`, memberId);

  const inviterProfile = (await store.get(`profile:${inviterId}`, { type: "json" })) as ServerProfile | null;

  return new Response(
    JSON.stringify({
      coParentId: inviterId,
      coParentName: inviterProfile?.name ?? null,
      coParentKids: inviterProfile?.kids ?? [],
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/household/link",
};
