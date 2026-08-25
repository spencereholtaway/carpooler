import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// One-off local tool: copies every blob from the real "carpools" store into
// "carpools-dev" so local development/testing works against realistic data
// (real co-parents, real orphaned kids, real households) instead of
// hand-typed fixtures. Per the migration plan, this is the only place the
// code ever opens the real store by its literal name instead of through
// CARPOOL_STORE — everything else in the app must keep using the
// env-driven name so it can never read/write production by accident.
//
// Hard-gated to NETLIFY_DEV so this can never run against a deployed
// site even if it were mistakenly pushed live: `netlify dev` sets
// NETLIFY_DEV=true for local runs and nothing else does.
export default async (req: Request) => {
  if (process.env.NETLIFY_DEV !== "true") {
    return new Response("Only runs under `netlify dev`", { status: 403 });
  }

  const expected = process.env.ADMIN_KEY;
  const key = new URL(req.url).searchParams.get("key");
  if (!expected || key !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const target = getStore("carpools-dev", { consistency: "strong" });

  // `netlify dev` fully emulates Blobs locally, so a plain getStore("carpools")
  // call from inside this function never reaches the real deployed store no
  // matter what it's named — it only sees other local-emulated data. Real
  // production values have to come in from outside (e.g. the `netlify blobs`
  // CLI, which does talk to the real API) and get relayed in via POST here.
  if (req.method === "POST") {
    const { entries } = (await req.json()) as { entries?: Record<string, string> };
    if (!entries) return new Response("Missing entries", { status: 400 });

    const { blobs: existing } = await target.list();
    for (const { key: blobKey } of existing) await target.delete(blobKey);

    let copied = 0;
    for (const [blobKey, value] of Object.entries(entries)) {
      await target.set(blobKey, value);
      copied++;
    }
    return new Response(JSON.stringify({ cleared: existing.length, copied }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const source = getStore("carpools", { consistency: "strong" });
  const { blobs } = await source.list();
  let copied = 0;
  for (const { key: blobKey } of blobs) {
    const value = await source.get(blobKey, { type: "text" });
    if (value === null) continue;
    await target.set(blobKey, value);
    copied++;
  }

  return new Response(JSON.stringify({ copied, total: blobs.length }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/dev-seed",
};
