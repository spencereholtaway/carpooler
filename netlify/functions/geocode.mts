import type { Config } from "@netlify/functions";

// OSM Nominatim doesn't send CORS headers, so the browser can't call it
// directly — this proxies the lookup server-side, where CORS doesn't apply.
export default async (req: Request) => {
  const street = new URL(req.url).searchParams.get("street") ?? "";
  const zip = new URL(req.url).searchParams.get("zip") ?? "";
  const query = [street, zip].filter(Boolean).join(", ");
  if (!query) return new Response("Missing address", { status: 400 });

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Carpooler (carpool scheduling app)" } });
  if (!res.ok) return new Response(JSON.stringify(null), { headers: { "Content-Type": "application/json" } });

  const results = (await res.json()) as { lat: string; lon: string }[];
  const first = results[0];
  const point = first ? { lat: parseFloat(first.lat), lon: parseFloat(first.lon) } : null;
  return new Response(JSON.stringify(point), { headers: { "Content-Type": "application/json" } });
};

export const config: Config = {
  path: "/api/geocode",
};
