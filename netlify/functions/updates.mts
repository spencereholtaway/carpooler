import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Update = { id: string; text: string; createdAt: number };

async function handleMutation(store: ReturnType<typeof getStore>, req: Request) {
  const body = (await req.json()) as { key: string; action: string; payload: any };
  const expected = process.env.ADMIN_KEY;
  if (!expected || body.key !== expected) return new Response("Unauthorized", { status: 401 });

  switch (body.action) {
    case "createUpdate": {
      const text = (body.payload?.text ?? "").trim();
      if (!text) return new Response("Missing text", { status: 400 });
      const update: Update = { id: crypto.randomUUID(), text, createdAt: Date.now() };
      await store.setJSON(`update:${update.id}`, update);
      return new Response(JSON.stringify(update), { headers: { "Content-Type": "application/json" } });
    }
    case "updateUpdate": {
      const { id, text } = body.payload as { id: string; text: string };
      const existing = (await store.get(`update:${id}`, { type: "json" })) as Update | null;
      if (!existing) return new Response("Not found", { status: 404 });
      existing.text = text.trim();
      await store.setJSON(`update:${id}`, existing);
      return new Response("ok");
    }
    case "deleteUpdate": {
      const { id } = body.payload as { id: string };
      await store.delete(`update:${id}`);
      return new Response("ok");
    }
    default:
      return new Response("Unknown action", { status: 400 });
  }
}

export default async (req: Request) => {
  const store = getStore(process.env.CARPOOL_STORE || "carpools", { consistency: "strong" });

  if (req.method === "POST") return handleMutation(store, req);

  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const { blobs } = await store.list({ prefix: "update:" });
  const updates = (
    await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))
  ).filter(Boolean) as Update[];
  updates.sort((a, b) => b.createdAt - a.createdAt);

  return new Response(JSON.stringify({ updates }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/updates",
};
