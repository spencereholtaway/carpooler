// Beta feature: figures out a good order to visit several stops, using
// straight-line distance (not real road routing) since we're only ever
// ordering a handful of stops. The actual turn-by-turn routing is left to
// the driver's Maps app once we hand off the ordered addresses to it.

export type GeoPoint = { lat: number; lon: number };
export type NamedStop = { label: string; address: { street: string; zip: string } };
export type AutoRouteLegKind = "dropOff" | "pickUp";
export type AutoRouteResult =
  | { ok: true; orderedStops: NamedStop[] }
  | { ok: false; reason: "geolocation-denied" | "geolocation-unavailable" | "geocode-failed" | "too-few-stops" };

// Nominatim (the free OSM geocoder used here) doesn't send CORS headers, so
// the browser can't call it directly — /api/geocode proxies the lookup
// server-side, where CORS doesn't apply.
export async function geocodeAddress(street: string, zip: string): Promise<GeoPoint | null> {
  if (!street && !zip) return null;
  const url = `/api/geocode?street=${encodeURIComponent(street)}&zip=${encodeURIComponent(zip)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as GeoPoint | null;
  } catch {
    return null;
  }
}

// Nominatim's public instance asks for at most ~1 request/second, so these
// run sequentially with a delay rather than in parallel.
export async function geocodeSequential(
  addresses: { street: string; zip: string }[],
  delayMs = 1100,
): Promise<(GeoPoint | null)[]> {
  const results: (GeoPoint | null)[] = [];
  for (let i = 0; i < addresses.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    results.push(await geocodeAddress(addresses[i].street, addresses[i].zip));
  }
  return results;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

// Brute-force is fine here: this only ever runs over a handful of stops.
export function optimizeStopOrder<T extends { point: GeoPoint }>(
  start: GeoPoint,
  middleStops: T[],
  end: GeoPoint,
): T[] {
  if (middleStops.length <= 1) return middleStops;
  let best: T[] = middleStops;
  let bestDistance = Infinity;
  for (const perm of permutations(middleStops)) {
    let distance = haversineKm(start, perm[0].point);
    for (let i = 0; i < perm.length - 1; i++) {
      distance += haversineKm(perm[i].point, perm[i + 1].point);
    }
    distance += haversineKm(perm[perm.length - 1].point, end);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = perm;
    }
  }
  return best;
}

function getCurrentPosition(): Promise<GeoPoint | { denied: true } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => resolve(err.code === err.PERMISSION_DENIED ? { denied: true } : null),
      { timeout: 10000 },
    );
  });
}

export async function computeAutoRoute(
  legKind: AutoRouteLegKind,
  kidHomeStops: NamedStop[],
  bookend: NamedStop,
  extraFixedStop?: NamedStop,
): Promise<AutoRouteResult> {
  // Mirrors buildAutoRouteLeg's eligibility check in CarpoolDetail: a fixed
  // stop (pick-up's drive to the destination before any kid) makes even one
  // kid a genuine multi-stop route, so only drop-off needs 2+ to bother.
  const minKidStops = extraFixedStop ? 1 : 2;
  if (kidHomeStops.length < minKidStops) return { ok: false, reason: "too-few-stops" };

  const position = await getCurrentPosition();
  if (position === null) return { ok: false, reason: "geolocation-unavailable" };
  if ("denied" in position) return { ok: false, reason: "geolocation-denied" };

  const toGeocode = [bookend, ...(extraFixedStop ? [extraFixedStop] : []), ...kidHomeStops];
  const points = await geocodeSequential(toGeocode.map((s) => s.address));
  if (points.some((p) => p === null)) return { ok: false, reason: "geocode-failed" };

  const bookendPoint = points[0]!;
  const extraFixedPoint = extraFixedStop ? points[1]! : null;
  const kidPoints = points.slice(extraFixedStop ? 2 : 1) as GeoPoint[];
  const kidStopsWithPoints = kidHomeStops.map((stop, i) => ({ ...stop, point: kidPoints[i] }));

  if (legKind === "dropOff") {
    const ordered = optimizeStopOrder(position, kidStopsWithPoints, bookendPoint);
    return { ok: true, orderedStops: [...ordered, bookend] };
  }

  // pickUp: current location -> destination (fixed) -> optimized kid homes -> home (bookend)
  const ordered = optimizeStopOrder(extraFixedPoint!, kidStopsWithPoints, bookendPoint);
  return { ok: true, orderedStops: [extraFixedStop!, ...ordered, bookend] };
}
