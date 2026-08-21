import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { geocodeSequential, type GeoPoint } from "./autoRoute";
import { DAYS_OF_WEEK } from "./types";

const GEOCODE_CACHE_KEY = "blisspool:dataviz-geocode-cache";

type AdminUser = {
  memberId: string;
  name: string;
  kids: string[];
  street: string;
  zip: string;
  coParentId?: string | null;
};

type AdminCar = { driverId: string; kids: string[]; seats: number };
type AdminLeg = { time: string; cars: AdminCar[] };

type AdminCarpool = {
  code: string;
  name: string;
  day: string;
  destination?: { street: string; zip: string };
  members: {
    id: string;
    name: string;
    kids: string[];
    canDriveDropOff?: boolean;
    canDrivePickUp?: boolean;
  }[];
  dropOff?: AdminLeg;
  pickUp?: AdminLeg;
  createdAt: number;
};

type MapPoint = { id: string; label: string; address: string; kind: "home" | "carpool"; point: GeoPoint };

function addressKey(street: string, zip: string): string {
  return `${street.trim().toLowerCase()}|${zip.trim().toLowerCase()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadGeocodeCache(): Record<string, GeoPoint | null> {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

// Geocodes every distinct address across homes and carpool destinations,
// reusing a localStorage cache keyed by street+zip so repeat page loads
// don't re-hit Nominatim (rate-limited to ~1req/s) for addresses we've
// already resolved.
async function geocodeAll(
  addresses: { key: string; street: string; zip: string }[],
  onProgress: (done: number, total: number) => void,
): Promise<Record<string, GeoPoint | null>> {
  const cache = loadGeocodeCache();
  const uncached = addresses.filter((a) => !(a.key in cache));
  let done = 0;
  onProgress(0, uncached.length);
  const results = await geocodeSequential(
    uncached.map((a) => ({ street: a.street, zip: a.zip })),
    1100,
  );
  uncached.forEach((a, i) => {
    cache[a.key] = results[i];
    done++;
    onProgress(done, uncached.length);
  });
  localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  return cache;
}

type CarpoolRecommendation = { carpoolCode: string; carpoolName: string; sharedMateNames: string[] };
type KidRecommendations = { kidName: string; recs: CarpoolRecommendation[] };

// For each user, recommends carpools *per kid* they're not in but that
// carpool with that kid's actual teammates elsewhere — e.g. Jack and Miles
// both ride "Boys Soccer Practice", and Miles also rides "Boys Soccer
// Clinic", so Clinic gets recommended for Jack specifically, not for a
// sibling on an unrelated team. Deliberately kid-scoped via member.kids
// (the "which of your kids is in this carpool?" selection made at join
// time — see CarpoolDetail.tsx), not the parent's whole household roster.
// minShared is the number of distinct teammate kids required before a
// candidate counts as a recommendation — higher means fewer,
// higher-confidence results.
function computeRecommendations(
  users: AdminUser[],
  carpools: AdminCarpool[],
  minShared: number,
): Map<string, KidRecommendations[]> {
  // "memberId::kidName" -> carpool codes that specific kid rides (per the
  // "which of your kids is in this carpool?" selection made at join time).
  const kidCarpoolCodes = new Map<string, Set<string>>();
  for (const c of carpools) {
    for (const m of c.members) {
      for (const kidName of m.kids) {
        const key = `${m.id}::${kidName}`;
        if (!kidCarpoolCodes.has(key)) kidCarpoolCodes.set(key, new Set());
        kidCarpoolCodes.get(key)!.add(c.code);
      }
    }
  }
  const memberCarpoolCodes = new Map<string, Set<string>>();
  for (const c of carpools) {
    for (const m of c.members) {
      if (!memberCarpoolCodes.has(m.id)) memberCarpoolCodes.set(m.id, new Set());
      memberCarpoolCodes.get(m.id)!.add(c.code);
    }
  }
  const carpoolByCode = new Map(carpools.map((c) => [c.code, c]));

  const recs = new Map<string, KidRecommendations[]>();
  for (const u of users) {
    const myCarpools = memberCarpoolCodes.get(u.memberId);
    if (!myCarpools || myCarpools.size === 0) continue;

    const kidResults: KidRecommendations[] = [];
    for (const kidName of u.kids) {
      const myKidCarpools = kidCarpoolCodes.get(`${u.memberId}::${kidName}`);
      if (!myKidCarpools) continue;

      // minShared counts distinct *teammate kids* corroborating a
      // candidate — not raw kid-pairs (a kid showing up via two
      // co-parents, e.g. Carmen + Jared both listing William, is one
      // piece of evidence, not two) and not distinct source carpools of
      // mine (a parent with only one carpool could never clear a
      // threshold above 1 under that metric, which undercounted real
      // corroboration from multiple teammates within that single
      // carpool). Scoped per-kid so a kid on two different teams doesn't
      // have one team's evidence leak into the other's recommendations.
      const sharedByCandidate = new Map<string, { teammateKids: Set<string>; details: Set<string> }>();
      for (const myCode of myKidCarpools) {
        const sharedCarpool = carpoolByCode.get(myCode);
        if (!sharedCarpool) continue;
        for (const mate of sharedCarpool.members) {
          if (mate.id === u.memberId) continue;
          for (const mateKidName of mate.kids) {
            for (const candidateCode of kidCarpoolCodes.get(`${mate.id}::${mateKidName}`) ?? []) {
              if (myCarpools.has(candidateCode)) continue;
              if (!sharedByCandidate.has(candidateCode)) {
                sharedByCandidate.set(candidateCode, { teammateKids: new Set(), details: new Set() });
              }
              const entry = sharedByCandidate.get(candidateCode)!;
              entry.teammateKids.add(mateKidName);
              entry.details.add(`${mateKidName} (${mate.name})`);
            }
          }
        }
      }

      const list = [...sharedByCandidate.entries()]
        .filter(([, v]) => v.teammateKids.size >= minShared)
        .map(([candidateCode, v]) => ({
          carpoolCode: candidateCode,
          carpoolName: carpoolByCode.get(candidateCode)!.name,
          sharedMateNames: [...v.details],
        }))
        .sort((a, b) => b.sharedMateNames.length - a.sharedMateNames.length);

      if (list.length > 0) kidResults.push({ kidName, recs: list });
    }

    if (kidResults.length > 0) recs.set(u.memberId, kidResults);
  }
  return recs;
}

type Bucket = { label: string; count: number };

// Merges each user with their linked co-parent into one household row, so
// a two-parent family isn't double-counted in per-household stats. Mirrors
// the merge in parentRows below, but returns raw member-id groups rather
// than a display row.
function householdGroups(users: AdminUser[]): { label: string; memberIds: string[] }[] {
  const usersById = new Map(users.map((u) => [u.memberId, u]));
  const visited = new Set<string>();
  const groups: { label: string; memberIds: string[] }[] = [];
  for (const u of users) {
    if (visited.has(u.memberId)) continue;
    visited.add(u.memberId);
    const coParent = u.coParentId ? usersById.get(u.coParentId) : undefined;
    if (coParent) visited.add(coParent.memberId);
    const memberIds = coParent ? [u.memberId, coParent.memberId] : [u.memberId];
    const label = coParent ? [u.name, coParent.name].sort().join(" & ") : u.name;
    groups.push({ label, memberIds });
  }
  return groups;
}

type DriverLoad = { name: string; legs: number; ownKids: number; otherKids: number; score: number };

// Driving another family's kid is real carpool effort; driving only your
// own kid to where you were already taking them is the baseline, not a
// favor to anyone — so a driver's own kids count at a fraction of the
// weight of everyone else's on their roster. A person who never drives at
// all (never appears as a car's driverId on a leg, even if their kid rides
// with someone else) gets nothing added for that leg — only actual
// drivers accrue score.
const OWN_KID_WEIGHT = 0.5;
const OTHER_KID_WEIGHT = 2;

// Weighted driving load per person, summed across every carpool they're
// in — the fairness question "who's actually doing the driving" only
// makes sense at this cross-carpool level, not per-carpool. Counts every
// kid nobody explicitly claimed with a car (see computeOrphanedKids) as a
// ride their own parent is implicitly driving solo — always at the
// own-kid weight, since it's necessarily their own kid — alongside the
// app's explicit car assignments, so a carpool that's never had its cars
// filled in doesn't just vanish from the picture.
function computeDriverLoads(carpools: AdminCarpool[]): DriverLoad[] {
  const byId = new Map<string, DriverLoad>();
  const bump = (id: string, name: string, ownKids: number, otherKids: number) => {
    const entry = byId.get(id) ?? { name, legs: 0, ownKids: 0, otherKids: 0, score: 0 };
    entry.legs += 1;
    entry.ownKids += ownKids;
    entry.otherKids += otherKids;
    entry.score += ownKids * OWN_KID_WEIGHT + otherKids * OTHER_KID_WEIGHT;
    byId.set(id, entry);
  };
  for (const c of carpools) {
    const memberById = new Map(c.members.map((m) => [m.id, m]));
    for (const leg of [c.dropOff, c.pickUp]) {
      const claimed = new Set<string>();
      for (const car of leg?.cars ?? []) {
        const driver = memberById.get(car.driverId);
        const ownKidSet = new Set(driver?.kids ?? []);
        let own = 0;
        let other = 0;
        for (const kid of car.kids) {
          if (ownKidSet.has(kid)) own++;
          else other++;
          claimed.add(kid);
        }
        bump(car.driverId, driver?.name ?? car.driverId, own, other);
      }
      for (const m of c.members) {
        const ownUnclaimed = m.kids.filter((kid) => !claimed.has(kid));
        if (ownUnclaimed.length > 0) bump(m.id, m.name, ownUnclaimed.length, 0);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

type UnusedDriver = { name: string; carpoolName: string; leg: "Drop-off" | "Pick-up" };

// Members who've toggled "I can drive" for a leg but have no car on that
// leg — willing capacity nobody's using yet.
function computeUnusedDrivers(carpools: AdminCarpool[]): UnusedDriver[] {
  const out: UnusedDriver[] = [];
  for (const c of carpools) {
    for (const [leg, label, canDriveKey] of [
      [c.dropOff, "Drop-off", "canDriveDropOff"],
      [c.pickUp, "Pick-up", "canDrivePickUp"],
    ] as const) {
      const driverIds = new Set((leg?.cars ?? []).map((car) => car.driverId));
      for (const m of c.members) {
        if (m[canDriveKey] && !driverIds.has(m.id)) out.push({ name: m.name, carpoolName: c.name, leg: label });
      }
    }
  }
  return out;
}

type OrphanedKid = { kidName: string; parentName: string; carpoolName: string; leg: "Drop-off" | "Pick-up" };

// Kids whose parent is in the carpool but who aren't claimed by any car on
// a leg — a broken/incomplete carpool, worth flagging before the day comes.
function computeOrphanedKids(carpools: AdminCarpool[]): OrphanedKid[] {
  const out: OrphanedKid[] = [];
  for (const c of carpools) {
    for (const [leg, label] of [
      [c.dropOff, "Drop-off"],
      [c.pickUp, "Pick-up"],
    ] as const) {
      const claimed = new Set((leg?.cars ?? []).flatMap((car) => car.kids));
      for (const m of c.members) {
        for (const kid of m.kids) {
          if (!claimed.has(kid)) out.push({ kidName: kid, parentName: m.name, carpoolName: c.name, leg: label });
        }
      }
    }
  }
  return out;
}

type SeatBalance = { carpoolName: string; leg: "Drop-off" | "Pick-up"; kidsCount: number; seatsOffered: number };

// Seats offered vs. kids needing a ride, per carpool leg — sorted so the
// most under-supplied legs (biggest shortfall) surface first.
function computeSeatBalance(carpools: AdminCarpool[]): SeatBalance[] {
  const out: SeatBalance[] = [];
  for (const c of carpools) {
    const kidsCount = c.members.reduce((s, m) => s + m.kids.length, 0);
    for (const [leg, label] of [
      [c.dropOff, "Drop-off"],
      [c.pickUp, "Pick-up"],
    ] as const) {
      const seatsOffered = (leg?.cars ?? []).reduce((s, car) => s + car.seats, 0);
      out.push({ carpoolName: c.name, leg: label, kidsCount, seatsOffered });
    }
  }
  return out.sort((a, b) => a.seatsOffered - a.kidsCount - (b.seatsOffered - b.kidsCount));
}

// Carpools created per week, from the first carpool's week through the
// most recent — zero-filled so a quiet week reads as a gap, not a missing
// bar.
function computeWeeklyGrowth(carpools: AdminCarpool[]): Bucket[] {
  if (carpools.length === 0) return [];
  const msWeek = 7 * 24 * 60 * 60 * 1000;
  const weekStart = (t: number) => Math.floor(t / msWeek) * msWeek;
  const created = carpools.map((c) => c.createdAt).sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (const t of created) counts.set(weekStart(t), (counts.get(weekStart(t)) ?? 0) + 1);
  const out: Bucket[] = [];
  for (let t = weekStart(created[0]); t <= weekStart(created[created.length - 1]); t += msWeek) {
    out.push({
      label: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      count: counts.get(t) ?? 0,
    });
  }
  return out;
}

// One bucket per exact member count (1, 2, 3, ... up to the largest
// carpool) rather than coarse ranges — zero-filled so a size nobody has
// still shows as a gap in the shape, not a missing point.
function computeSizeDistribution(carpools: AdminCarpool[]): Bucket[] {
  if (carpools.length === 0) return [];
  const counts = new Map<number, number>();
  let max = 1;
  for (const c of carpools) {
    const n = Math.max(1, c.members.length);
    counts.set(n, (counts.get(n) ?? 0) + 1);
    max = Math.max(max, n);
  }
  const out: Bucket[] = [];
  for (let n = 1; n <= max; n++) out.push({ label: `${n}`, count: counts.get(n) ?? 0 });
  return out;
}

// Every day of the week, Monday through Sunday, zero-filled — a day with
// no carpools still shows as a flat point rather than disappearing.
function computeDayDistribution(carpools: AdminCarpool[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const c of carpools) counts.set(c.day, (counts.get(c.day) ?? 0) + 1);
  const known = DAYS_OF_WEEK.map((label) => ({ label, count: counts.get(label) ?? 0 }));
  const other = [...counts.entries()]
    .filter(([d]) => !(DAYS_OF_WEEK as readonly string[]).includes(d))
    .map(([label, count]) => ({ label, count }));
  return [...known, ...other];
}

// Distinct kids per household (co-parents merged), bucketed by count.
function computeKidsPerFamily(users: AdminUser[]): Bucket[] {
  const usersById = new Map(users.map((u) => [u.memberId, u]));
  const counts = new Map<number, number>();
  for (const group of householdGroups(users)) {
    const kidSet = new Set(group.memberIds.flatMap((id) => usersById.get(id)?.kids ?? []));
    counts.set(kidSet.size, (counts.get(kidSet.size) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, count]) => ({ label: `${n} kid${n === 1 ? "" : "s"}`, count }));
}

type HouseholdCarpoolCount = { label: string; carpoolCount: number };

// Households in 2+ carpools — a decent proxy for the app's power users.
function computeMultiCarpoolHouseholds(users: AdminUser[], carpools: AdminCarpool[]): HouseholdCarpoolCount[] {
  const codesByMember = new Map<string, Set<string>>();
  for (const c of carpools) {
    for (const m of c.members) {
      if (!codesByMember.has(m.id)) codesByMember.set(m.id, new Set());
      codesByMember.get(m.id)!.add(c.code);
    }
  }
  const out: HouseholdCarpoolCount[] = [];
  for (const group of householdGroups(users)) {
    const codes = new Set(group.memberIds.flatMap((id) => [...(codesByMember.get(id) ?? [])]));
    if (codes.size >= 2) out.push({ label: group.label, carpoolCount: codes.size });
  }
  return out.sort((a, b) => b.carpoolCount - a.carpoolCount);
}

// Every household (not just multi-carpool ones), bucketed by exactly how
// many carpools they're in — the shape of "how many carpools does a
// typical family juggle," vs. computeMultiCarpoolHouseholds's ranked list
// of who specifically is juggling several.
function computeCarpoolCountDistribution(users: AdminUser[], carpools: AdminCarpool[]): Bucket[] {
  const codesByMember = new Map<string, Set<string>>();
  for (const c of carpools) {
    for (const m of c.members) {
      if (!codesByMember.has(m.id)) codesByMember.set(m.id, new Set());
      codesByMember.get(m.id)!.add(c.code);
    }
  }
  const counts = new Map<number, number>();
  for (const group of householdGroups(users)) {
    const codes = new Set(group.memberIds.flatMap((id) => [...(codesByMember.get(id) ?? [])]));
    if (codes.size === 0) continue;
    counts.set(codes.size, (counts.get(codes.size) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, count]) => ({ label: `${n} carpool${n === 1 ? "" : "s"}`, count }));
}

function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const R_MILES = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(h));
}

type HistBin = Bucket & { tick?: string };

// Straight-line distance for every geocoded home -> its carpool's
// destination, deduped per pair — bucketed into a fine-grained
// (tenth-of-a-mile) histogram over just the actual data's range (padded
// half a mile on each side so the curve tapers to zero rather than
// getting cut off at the edges, reading as one clean "mountain") rather
// than a fixed 0-12mi range, since a fixed range wastes most of its width
// on buckets nobody's in.
function computeDistanceHistogram(points: MapPoint[], adjacency: Record<string, string[]>): HistBin[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const miles: number[] = [];
  for (const [id, connected] of Object.entries(adjacency)) {
    if (!id.startsWith("home:")) continue;
    const home = byId.get(id);
    if (!home) continue;
    for (const cid of connected) {
      const pairKey = [id, cid].sort().join("~");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const carpool = byId.get(cid);
      if (!carpool) continue;
      miles.push(haversineMiles(home.point, carpool.point));
    }
  }
  if (miles.length === 0) return [];

  const binWidth = 0.1;
  const pad = 0.5;
  const lo = Math.max(0, Math.floor((Math.min(...miles) - pad) / binWidth) * binWidth);
  const hi = Math.ceil((Math.max(...miles) + pad) / binWidth) * binWidth;
  const bins: HistBin[] = [];
  for (let start = lo; start < hi - binWidth / 2; start += binWidth) {
    const rounded = Math.round(start * 10) / 10;
    bins.push({
      label: `${rounded.toFixed(1)}–${(rounded + binWidth).toFixed(1)} mi`,
      count: 0,
      tick: Math.abs(rounded - Math.round(rounded)) < 1e-6 ? `${Math.round(rounded)}` : "",
    });
  }
  for (const m of miles) {
    const idx = Math.min(bins.length - 1, Math.max(0, Math.floor((m - lo) / binWidth)));
    bins[idx].count++;
  }
  return bins;
}

type CarpoolSprawl = { name: string; miles: number };

// Max distance between any two members' homes in the same carpool — a
// rough measure of how geographically tight-knit (or spread out) it is.
function computeCarpoolSprawl(carpools: AdminCarpool[], points: MapPoint[]): CarpoolSprawl[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  return carpools
    .map((c) => {
      const homes = c.members.map((m) => byId.get(`home:${m.id}`)).filter((p): p is MapPoint => p != null);
      let max = 0;
      for (let i = 0; i < homes.length; i++) {
        for (let j = i + 1; j < homes.length; j++) {
          max = Math.max(max, haversineMiles(homes[i].point, homes[j].point));
        }
      }
      return { name: c.name, miles: max };
    })
    .filter((x) => x.miles > 0)
    .sort((a, b) => b.miles - a.miles);
}

// A ranked horizontal bar list — the right form for "who/what is biggest",
// where labels are long free text (names) and the point is the ranking,
// not a distribution shape.
function BarList({ data, unit }: { data: Bucket[]; unit?: string }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.count)));
  if (data.length === 0) return <p className="admin-muted">No data yet.</p>;
  return (
    <div className="admin-dataviz-barlist">
      {data.map((d) => (
        <div key={d.label} className="admin-dataviz-bar-row">
          <span className="admin-dataviz-bar-label" title={d.label}>
            {d.label}
          </span>
          <div className="admin-dataviz-bar-track">
            <div className="admin-dataviz-bar-fill" style={{ width: `${(Math.abs(d.count) / max) * 100}%` }} />
          </div>
          <span className="admin-dataviz-bar-count">
            {d.count}
            {unit ?? ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// A diverging horizontal bar list, bars growing left/right from a zero
// center line — the right form for signed quantities (surplus/deficit)
// where both the sign and the magnitude matter. An absolute-value bar
// list would hide which side of zero each row is on.
function DivergingBarList({ data, unit }: { data: Bucket[]; unit?: string }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.count)));
  if (data.length === 0) return <p className="admin-muted">No data yet.</p>;
  return (
    <div className="admin-dataviz-barlist">
      {data.map((d) => {
        const pct = (Math.abs(d.count) / max) * 50;
        const isNeg = d.count < 0;
        return (
          <div key={d.label} className="admin-dataviz-bar-row">
            <span className="admin-dataviz-bar-label" title={d.label}>
              {d.label}
            </span>
            <div className="admin-dataviz-diverging-track">
              <div className="admin-dataviz-diverging-center" />
              <div
                className={`admin-dataviz-diverging-fill${isNeg ? " negative" : ""}`}
                style={{ width: `${pct}%`, left: isNeg ? `${50 - pct}%` : "50%" }}
              />
            </div>
            <span className="admin-dataviz-bar-count">
              {d.count > 0 ? "+" : ""}
              {d.count}
              {unit ?? ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Open (non-closed) Catmull-Rom spline through `points`, converted to
// cubic Bezier segments — the standard construction (control points at
// 1/6 of the way to each point's neighbors) for a curve that actually
// passes through every data point rather than merely approximating them.
function smoothOpenPath(points: [number, number][]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0][0]},${points[0][1]}`;
  let d = `M ${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// A smoothed line/area chart — the right form for a distribution/trend
// read left-to-right along an ordered axis (time, distance, day-of-week,
// count), where the point is the overall shape rather than any single
// bin's exact value. Each bin's own `tick` (when the data provides one)
// sparsely labels the axis so a 25-bin histogram doesn't collide into
// unreadable text; falling back to `label` suits the few-point
// categorical case where every point can carry its own label. Per-point
// hit targets carry a native title tooltip with the exact count.
function VerticalBars({ data, height = 120 }: { data: HistBin[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  if (data.length === 0) return <p className="admin-muted">No data yet.</p>;
  const w = 100;
  const n = data.length;
  const stepX = n > 1 ? w / (n - 1) : 0;
  // Padding inside the plot so a peak at the max value (or the smoothed
  // curve's slight overshoot past a data point) has room above/below
  // before it would otherwise clip against the SVG's edge.
  const padY = 10;
  const plotH = height - padY * 2;
  const baselineY = padY + plotH;
  const points: [number, number][] = data.map((d, i) => [
    n > 1 ? i * stepX : w / 2,
    baselineY - (d.count / max) * plotH,
  ]);
  const linePath = smoothOpenPath(points);
  const areaPath =
    n === 1 ? "" : `${linePath} L ${points[n - 1][0]},${baselineY} L ${points[0][0]},${baselineY} Z`;

  return (
    <div className="admin-dataviz-hist-wrap">
      <div className="admin-dataviz-hist-row">
        <div className="admin-dataviz-hist-yaxis" style={{ height }}>
          <span style={{ top: padY }}>{max}</span>
          <span style={{ top: baselineY }}>0</span>
        </div>
        <div className="admin-dataviz-hist-plot" style={{ height }}>
          <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="admin-dataviz-hist-svg">
            <line
              x1={0}
              y1={padY}
              x2={w}
              y2={padY}
              className="admin-dataviz-hist-gridline"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              y1={baselineY}
              x2={w}
              y2={baselineY}
              className="admin-dataviz-hist-gridline"
              vectorEffect="non-scaling-stroke"
            />
            {areaPath && <path d={areaPath} className="admin-dataviz-hist-area" />}
            <path d={linePath} className="admin-dataviz-hist-line" vectorEffect="non-scaling-stroke" />
          </svg>
          {points.map(([x, y], i) => (
            <div
              key={i}
              className="admin-dataviz-hist-dot"
              style={{ left: `${(x / w) * 100}%`, top: y }}
              title={`${data[i].label}: ${data[i].count}`}
            />
          ))}
        </div>
      </div>
      <div className="admin-dataviz-hist-axis">
        {data.map((d, i) => {
          const text = d.tick ?? d.label;
          if (!text) return null;
          const pct = n > 1 ? (i / (n - 1)) * 100 : 50;
          return (
            <span
              key={i}
              className="admin-dataviz-hist-tick"
              style={{
                left: `${pct}%`,
                transform: i === 0 ? "translateX(0)" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function polarPoint(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

// A pie chart — the right form here because the request is specifically an
// ordered progression (1, 2, 3, 4... kids) read as a clock face, not a
// ranked comparison the way the bar lists are. Slices go clockwise from
// 12 o'clock in the data's own order. Color is a single-hue sequential
// ramp (opacity steps of one accent color) since the slices are ordered
// magnitude, not unrelated categories that would need distinct hues.
function PieChart({ data, unit }: { data: Bucket[]; unit?: string }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <p className="admin-muted">No data yet.</p>;
  const cx = 50;
  const cy = 50;
  const r = 46;
  const nonZero = data.filter((d) => d.count > 0);
  let angle = 0;
  const slices = data.map((d) => {
    const startAngle = angle;
    const sweep = (d.count / total) * 360;
    angle += sweep;
    const opacity = nonZero.length <= 1 ? 1 : 0.3 + 0.7 * (nonZero.findIndex((n) => n === d) / (nonZero.length - 1));
    return { ...d, startAngle, endAngle: angle, opacity: d.count > 0 ? opacity : 0 };
  });

  return (
    <div className="admin-dataviz-pie-row">
      <svg viewBox="0 0 100 100" className="admin-dataviz-pie-svg">
        {nonZero.length === 1 ? (
          <circle cx={cx} cy={cy} r={r} fill={`rgba(var(--admin-accent-rgb), 1)`}>
            <title>
              {nonZero[0].label}: {nonZero[0].count}
            </title>
          </circle>
        ) : (
          slices
            .filter((s) => s.count > 0)
            .map((s) => {
              const [x1, y1] = polarPoint(cx, cy, r, s.startAngle);
              const [x2, y2] = polarPoint(cx, cy, r, s.endAngle);
              const largeArc = s.endAngle - s.startAngle > 180 ? 1 : 0;
              const d = `M ${cx},${cy} L ${x1},${y1} A ${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z`;
              return (
                <path
                  key={s.label}
                  d={d}
                  className="admin-dataviz-pie-slice"
                  fill={`rgba(var(--admin-accent-rgb), ${s.opacity})`}
                >
                  <title>
                    {s.label}: {s.count}
                    {unit ?? ""} ({Math.round((s.count / total) * 100)}%)
                  </title>
                </path>
              );
            })
        )}
      </svg>
      <div className="admin-dataviz-pie-legend">
        {nonZero.map((d) => {
          const opacity = nonZero.length <= 1 ? 1 : 0.3 + 0.7 * (nonZero.indexOf(d) / (nonZero.length - 1));
          return (
            <div key={d.label} className="admin-dataviz-pie-legend-row">
              <span
                className="admin-dataviz-pie-swatch"
                style={{ background: `rgba(var(--admin-accent-rgb), ${opacity})` }}
              />
              <span className="admin-dataviz-pie-legend-label">{d.label}</span>
              <span className="admin-dataviz-pie-legend-count">
                {d.count}
                {unit ?? ""} ({Math.round((d.count / total) * 100)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="admin-dataviz-stat-tile">
      <div className="admin-dataviz-stat-value">{value}</div>
      <div className="admin-dataviz-stat-label">{label}</div>
    </div>
  );
}

// Monotone-chain convex hull over [lat, lon] pairs (treated as plain 2D —
// fine at this scale, no need for geodesic correctness in a rough visual).
function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Pushes hull points outward from their centroid so the blob doesn't hug
// the dots exactly — gives it some breathing room.
function padHull(hull: [number, number][], factor: number): [number, number][] {
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

// Catmull-Rom through the (closed) hull, sampled densely, so the polygon
// reads as a soft blob rather than a sharp-cornered hull outline.
function smoothClosedPath(pts: [number, number][], segmentsPerEdge = 12): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let t = 0; t < segmentsPerEdge; t++) {
      const s = t / segmentsPerEdge;
      const s2 = s * s;
      const s3 = s2 * s;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * s +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * s2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * s3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * s +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s3);
      out.push([x, y]);
    }
  }
  return out;
}

// Builds the "blob" layer around a carpool's members' homes: a smoothed,
// padded convex hull for 3+ homes, or a covering circle for 1-2 (a hull
// is degenerate below 3 points).
function buildBlob(homePoints: MapPoint[], opts?: { fillOpacity?: number; weight?: number }): L.Layer {
  const style = {
    color: "#2563eb",
    weight: opts?.weight ?? 1,
    fillColor: "#2563eb",
    fillOpacity: opts?.fillOpacity ?? 0.2,
  };
  if (homePoints.length < 3) {
    const latlngs = homePoints.map((h) => L.latLng(h.point.lat, h.point.lon));
    const center = latlngs.length === 1 ? latlngs[0] : L.latLngBounds(latlngs).getCenter();
    const radius = Math.max(500, ...latlngs.map((ll) => center.distanceTo(ll) * 1.6 + 300));
    return L.circle(center, { ...style, radius });
  }
  const hull = convexHull(homePoints.map((h) => [h.point.lat, h.point.lon]));
  const smoothed = smoothClosedPath(padHull(hull, 1.3));
  return L.polygon(smoothed, style);
}

type PulseController = {
  line: L.Polyline;
  setDimmed: (dimmed: boolean) => void;
  stop: () => void;
};

// Draws a static connection line (no movement) whose opacity breathes: a
// held-bright plateau (`holdMs`), then a smooth dip down to `lowOpacity`
// and back up over `fadeMs`, then it repeats. Passing `holdMs: 0` skips
// the plateau entirely for a continuous back-and-forth pulse instead of a
// hold-then-blink pattern. `setDimmed(true)` freezes the line at a flat
// 0.5 opacity, overriding the animation — used to fade out every line
// that isn't part of the currently-hovered point's own connections.
function attachPulseGlow(
  map: L.Map,
  from: L.LatLng,
  to: L.LatLng,
  color: string,
  opts: { holdMs: number; fadeMs: number; baseOpacity: number; lowOpacity: number; weight: number },
): PulseController {
  const { holdMs, fadeMs, baseOpacity, lowOpacity, weight } = opts;
  const cycle = holdMs + fadeMs;
  const line = L.polyline([from, to], {
    color,
    weight,
    opacity: baseOpacity,
    lineCap: "round",
    interactive: false,
  }).addTo(map);

  const start = performance.now() - Math.random() * cycle;
  let dimmed = false;
  let raf = requestAnimationFrame(tick);
  function tick(now: number) {
    if (dimmed) {
      line.setStyle({ opacity: 0.5 });
    } else {
      const elapsed = (now - start) % cycle;
      let opacity = baseOpacity;
      if (elapsed >= holdMs) {
        const t = (elapsed - holdMs) / fadeMs;
        const dip = Math.sin(t * Math.PI); // 0 at start/end of the fade phase, 1 at its midpoint
        opacity = baseOpacity - dip * (baseOpacity - lowOpacity);
      }
      line.setStyle({ opacity });
    }
    raf = requestAnimationFrame(tick);
  }
  return {
    line,
    setDimmed: (v) => {
      dimmed = v;
    },
    stop: () => {
      cancelAnimationFrame(raf);
      line.remove();
    },
  };
}

// Nudges points that share (near-)identical coordinates apart slightly,
// arranged in a small circle around their shared spot — purely for
// on-map rendering. Two carpools at the same destination address (or two
// co-parents at the same home) would otherwise produce two markers sitting
// exactly on top of each other, so only the topmost could ever receive a
// hover/click; every other computation in this file (distance histograms,
// carpool sprawl, etc.) keeps using each point's real, unjittered
// coordinates — only marker and connection-line placement reads this map.
// A fixed lat/lon offset is the wrong unit for this: how many screen
// pixels it renders as depends entirely on zoom, so a value tuned to look
// right zoomed in is invisible zoomed out across a whole city (which is
// exactly what happened — 10m is a fraction of a pixel at neighborhood
// zoom). Leaflet's project/unproject round-trip lets the offset be
// specified in actual screen pixels at a given zoom instead, so the
// separation is visible regardless of scale. `zoom` should be whatever
// the map is about to be fit to, not necessarily its current zoom.
function jitterCoincidentPoints(map: L.Map, points: MapPoint[], zoom: number): Map<string, GeoPoint> {
  const groups = new Map<string, MapPoint[]>();
  for (const p of points) {
    const key = `${p.point.lat.toFixed(5)},${p.point.lon.toFixed(5)}`;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  const pixelOffset = 10;
  const display = new Map<string, GeoPoint>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      display.set(group[0].id, group[0].point);
      continue;
    }
    const center = group[0].point;
    const centerPx = map.project(L.latLng(center.lat, center.lon), zoom);
    group.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      const px = centerPx.add(L.point(Math.cos(angle) * pixelOffset, Math.sin(angle) * pixelOffset));
      const ll = map.unproject(px, zoom);
      display.set(p.id, { lat: ll.lat, lon: ll.lng });
    });
  }
  return display;
}

function MapView({
  points,
  adjacency,
  graphMode,
  showAllBlobs,
  includeDestinationInBlobs,
  showMap,
  resetToken,
  interactive,
}: {
  points: MapPoint[];
  adjacency: Record<string, string[]>;
  graphMode: boolean;
  showAllBlobs: boolean;
  includeDestinationInBlobs: boolean;
  showMap: boolean;
  resetToken: number;
  interactive: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // Scroll/drag/touch gestures start disabled — otherwise scrolling the
    // page with the cursor over an inline map would zoom or pan it instead
    // of scrolling past it. The toggles below re-enable them while
    // fullscreen, where the map is the only thing on screen.
    mapRef.current = L.map(containerRef.current, {
      scrollWheelZoom: false,
      dragging: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
    }).setView([37.9735, -122.5311], 12);

    // MapTiler's "dataviz" style has a "dataviz-dark" counterpart — follow
    // the OS light/dark preference (this page has no theme toggle of its
    // own) and keep swapping live if it changes while the page is open,
    // same as the rest of this app's CSS-driven theming.
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const tileUrl = (dark: boolean) =>
      `https://api.maptiler.com/maps/dataviz${dark ? "-dark" : ""}/{z}/{x}/{y}.png?key=${import.meta.env.VITE_MAPTILER_KEY}`;
    tileLayerRef.current = L.tileLayer(tileUrl(darkQuery.matches), {
      attribution:
        '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 20,
    }).addTo(mapRef.current);
    const onThemeChange = (e: MediaQueryListEvent) => tileLayerRef.current?.setUrl(tileUrl(e.matches));
    darkQuery.addEventListener("change", onThemeChange);

    return () => {
      darkQuery.removeEventListener("change", onThemeChange);
      mapRef.current?.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
    };
  }, []);

  // Leaflet caches its container size at init, so entering/leaving
  // fullscreen (which resizes the container) needs an explicit nudge.
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => mapRef.current?.invalidateSize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Scroll-wheel zoom, drag-panning, etc. only fire while fullscreen; the
  // "Show map" / "Plot all connections" / etc. checkboxes above the map
  // are plain HTML controls outside Leaflet's gesture handling, so they
  // keep working either way.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const handler of [map.scrollWheelZoom, map.dragging, map.doubleClickZoom, map.touchZoom, map.boxZoom]) {
      if (interactive) handler.enable();
      else handler.disable();
    }
  }, [interactive]);

  // Separate toggle for the basemap itself — independent of graphMode,
  // which now only controls whether connection lines are drawn.
  useEffect(() => {
    const map = mapRef.current;
    const tiles = tileLayerRef.current;
    if (!map || !tiles) return;
    if (showMap) map.addLayer(tiles);
    else map.removeLayer(tiles);
  }, [showMap]);

  // Refits to all points on demand (the "reset view" button), independent
  // of the main marker-rebuild effect so it doesn't tear down and redraw
  // everything just to re-center.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pointsRef.current.length === 0) return;
    map.fitBounds(
      L.latLngBounds(pointsRef.current.map((p) => [p.point.lat, p.point.lon])),
      { padding: [12, 12] },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;

    const byId = new Map(points.map((p) => [p.id, p]));
    const markersById = new Map<string, L.CircleMarker>();
    // Compute the jitter for whatever zoom fitBounds is about to settle
    // on below (same bounds, same padding) rather than the map's current
    // zoom — those can differ by a lot on first load, which would size
    // the pixel offset for the wrong scale.
    const fitBounds = L.latLngBounds(points.map((p) => [p.point.lat, p.point.lon]));
    const targetZoom = map.getBoundsZoom(fitBounds, false, L.point(12, 12));
    const displayPoint = jitterCoincidentPoints(map, points, targetZoom);
    const displayLatLng = (id: string): L.LatLng => {
      const dp = displayPoint.get(id) ?? byId.get(id)!.point;
      return L.latLng(dp.lat, dp.lon);
    };

    const markers = points.map((p) => {
      const tooltip = `<strong>${escapeHtml(p.label)}</strong><br>${escapeHtml(p.address)}`;
      const dp = displayPoint.get(p.id) ?? p.point;
      const marker = L.circleMarker([dp.lat, dp.lon], {
        radius: 7,
        color: p.kind === "home" ? "#2563eb" : "#dc2626",
        fillColor: p.kind === "home" ? "#2563eb" : "#dc2626",
        fillOpacity: 0.7,
        weight: 1,
      });
      marker.bindTooltip(tooltip, { direction: "top", offset: [0, -8] }).addTo(map);
      markersById.set(p.id, marker);
      return marker;
    });

    // Heatmap mode: every carpool's blob drawn at once, low opacity so
    // overlapping coverage areas stack up into darker regions.
    const permanentBlobs: L.Layer[] = [];
    if (showAllBlobs) {
      points
        .filter((p) => p.kind === "carpool")
        .forEach((p) => {
          const homePoints = (adjacency[p.id] ?? [])
            .filter((id) => id.startsWith("home:"))
            .map((id) => byId.get(id))
            .filter((h): h is MapPoint => h != null);
          if (includeDestinationInBlobs) homePoints.push(p);
          if (homePoints.length === 0) return;
          permanentBlobs.push(buildBlob(homePoints, { fillOpacity: 0.12, weight: 0 }).addTo(map));
        });
    }

    // Master-graph mode: every carpool<->member edge drawn permanently,
    // deduped so each pair is only drawn once (adjacency stores both
    // directions), each breathing slowly in place (2s held bright, then a
    // ~1.2s dip and recovery) rather than moving — kept as controllers
    // (not just lines) so hovering a point can dim every unrelated edge to
    // a flat 50% below.
    const permanentPulses: { pointId: string; otherId: string; controller: PulseController }[] = [];
    if (graphMode) {
      const seen = new Set<string>();
      for (const [id, connectedIds] of Object.entries(adjacency)) {
        const from = byId.get(id);
        if (!from) continue;
        for (const connectedId of connectedIds) {
          const pairKey = [id, connectedId].sort().join("~");
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const to = byId.get(connectedId);
          if (!to) continue;
          const home = from.kind === "home" ? from : to;
          const carpool = from.kind === "home" ? to : from;
          const controller = attachPulseGlow(
            map,
            displayLatLng(home.id),
            displayLatLng(carpool.id),
            "#94a3b8",
            { holdMs: 2000, fadeMs: 1200, baseOpacity: 0.6, lowOpacity: 0.2, weight: 1 },
          );
          permanentPulses.push({ pointId: id, otherId: connectedId, controller });
        }
      }
    }

    // On hover, pulse a line to every point the hovered point shares a
    // carpool with (a home to its carpools' destinations, or a carpool
    // destination to its members' homes) — continuously blinking (no held
    // plateau) so it reads distinctly from the slower ambient breathing —
    // and, when the master graph is on, dim every other permanent edge to
    // a flat 50% so the hovered point's own connections stand out.
    let activePulses: PulseController[] = [];
    const clearLines = () => {
      activePulses.forEach((c) => c.stop());
      activePulses = [];
      permanentPulses.forEach(({ controller }) => controller.setDimmed(false));
    };
    points.forEach((p) => {
      const marker = markersById.get(p.id)!;
      marker.on("mouseover", () => {
        clearLines();
        const connectedIds = new Set(adjacency[p.id] ?? []);
        for (const { pointId, otherId, controller } of permanentPulses) {
          const isOwn =
            (pointId === p.id && connectedIds.has(otherId)) || (otherId === p.id && connectedIds.has(pointId));
          controller.setDimmed(!isOwn);
        }
        for (const connectedId of connectedIds) {
          const other = byId.get(connectedId);
          if (!other) continue;
          const home = p.kind === "home" ? p : other;
          const carpool = p.kind === "home" ? other : p;
          activePulses.push(
            attachPulseGlow(
              map,
              displayLatLng(home.id),
              displayLatLng(carpool.id),
              "#f59e0b",
              { holdMs: 0, fadeMs: 900, baseOpacity: 0.9, lowOpacity: 0.15, weight: 2 },
            ),
          );
        }
      });
      marker.on("mouseout", clearLines);
    });

    // Clicking a carpool draws a blob around its members' homes and pins
    // that carpool's tooltip open (rather than only on hover); clicking
    // the same carpool again clears both.
    let blobLayer: L.Layer | null = null;
    let blobCarpoolId: string | null = null;
    const clearBlob = () => {
      blobLayer?.remove();
      blobLayer = null;
      if (blobCarpoolId) markersById.get(blobCarpoolId)?.closeTooltip();
      blobCarpoolId = null;
    };
    points
      .filter((p) => p.kind === "carpool")
      .forEach((p) => {
        const marker = markersById.get(p.id)!;
        marker.on("click", () => {
          if (blobCarpoolId === p.id) {
            clearBlob();
            return;
          }
          clearBlob();
          const homePoints = (adjacency[p.id] ?? [])
            .filter((id) => id.startsWith("home:"))
            .map((id) => byId.get(id))
            .filter((h): h is MapPoint => h != null);
          if (homePoints.length === 0) return;
          blobLayer = buildBlob(homePoints).addTo(map);
          blobCarpoolId = p.id;
          marker.openTooltip();
        });
      });

    map.fitBounds(fitBounds, { padding: [12, 12] });

    return () => {
      clearLines();
      clearBlob();
      permanentPulses.forEach(({ controller }) => controller.stop());
      permanentBlobs.forEach((l) => l.remove());
      markers.forEach((m) => m.remove());
    };
  }, [points, adjacency, graphMode, showAllBlobs, includeDestinationInBlobs]);

  return <div ref={containerRef} className="admin-dataviz-map" />;
}

export type DatavizTab = "geography" | "overview" | "fairness" | "households" | "recommendations";

export const DATAVIZ_TABS: { key: DatavizTab; label: string }[] = [
  { key: "geography", label: "Geography" },
  { key: "overview", label: "Overview" },
  { key: "fairness", label: "Driving & fairness" },
  { key: "households", label: "Households" },
  { key: "recommendations", label: "Recommendations" },
];

export function AdminDatavizPanel({
  users,
  carpools,
  subTab: tab,
}: {
  users: AdminUser[];
  carpools: AdminCarpool[];
  subTab: DatavizTab;
}) {
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [adjacency, setAdjacency] = useState<Record<string, string[]>>({});
  const [geocoding, setGeocoding] = useState(false);
  const [geoProgress, setGeoProgress] = useState<{ done: number; total: number } | null>(null);
  const [graphMode, setGraphMode] = useState(false);
  const [showAllBlobs, setShowAllBlobs] = useState(false);
  const [includeDestinationInBlobs, setIncludeDestinationInBlobs] = useState(false);
  const [blobMenuOpen, setBlobMenuOpen] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [resetToken, setResetToken] = useState(0);

  const blobMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!blobMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (blobMenuRef.current && !blobMenuRef.current.contains(e.target as Node)) setBlobMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [blobMenuOpen]);

  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else fullscreenRef.current?.requestFullscreen();
  };

  const [recThreshold, setRecThreshold] = useState(2);
  const recommendations = useMemo(
    () => computeRecommendations(users, carpools, recThreshold),
    [users, carpools, recThreshold],
  );
  // One row per household, not per member — co-parents are merged into a
  // single "A & B" row, and each of their kids gets its own line with its
  // own recommendations (a kid on two different teams shouldn't have its
  // recs blended with a sibling's).
  const parentRows = useMemo(() => {
    const usersById = new Map(users.map((u) => [u.memberId, u]));
    const visited = new Set<string>();
    const rows: { key: string; label: string; kids: KidRecommendations[] }[] = [];
    for (const u of users) {
      if (visited.has(u.memberId)) continue;
      visited.add(u.memberId);
      const coParent = u.coParentId ? usersById.get(u.coParentId) : undefined;
      if (coParent) visited.add(coParent.memberId);
      const ids = coParent ? [u.memberId, coParent.memberId] : [u.memberId];
      const label = coParent ? [u.name, coParent.name].sort().join(" & ") : u.name;

      const allKidNames = new Set<string>();
      for (const id of ids) for (const kidName of usersById.get(id)?.kids ?? []) allKidNames.add(kidName);

      const kids: KidRecommendations[] = [...allKidNames].sort().map((kidName) => {
        const recsByCode = new Map<string, CarpoolRecommendation>();
        for (const id of ids) {
          const kidRecs = recommendations.get(id)?.find((kr) => kr.kidName === kidName);
          for (const r of kidRecs?.recs ?? []) {
            const existing = recsByCode.get(r.carpoolCode);
            if (existing) {
              existing.sharedMateNames = [...new Set([...existing.sharedMateNames, ...r.sharedMateNames])];
            } else {
              recsByCode.set(r.carpoolCode, { ...r });
            }
          }
        }
        return { kidName, recs: [...recsByCode.values()] };
      });

      rows.push({ key: ids.join("+"), label, kids });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [users, recommendations]);

  const driverLoads = useMemo(() => computeDriverLoads(carpools), [carpools]);
  const unusedDrivers = useMemo(() => computeUnusedDrivers(carpools), [carpools]);
  const orphanedKids = useMemo(() => computeOrphanedKids(carpools), [carpools]);
  const seatBalance = useMemo(() => computeSeatBalance(carpools), [carpools]);
  const weeklyGrowth = useMemo(() => computeWeeklyGrowth(carpools), [carpools]);
  const sizeDistribution = useMemo(() => computeSizeDistribution(carpools), [carpools]);
  const dayDistribution = useMemo(() => computeDayDistribution(carpools), [carpools]);
  const kidsPerFamily = useMemo(() => computeKidsPerFamily(users), [users]);
  const multiCarpoolHouseholds = useMemo(
    () => computeMultiCarpoolHouseholds(users, carpools),
    [users, carpools],
  );
  const carpoolCountDistribution = useMemo(
    () => computeCarpoolCountDistribution(users, carpools),
    [users, carpools],
  );
  const distanceHistogram = useMemo(() => computeDistanceHistogram(points, adjacency), [points, adjacency]);
  const carpoolSprawl = useMemo(() => computeCarpoolSprawl(carpools, points), [carpools, points]);

  const soloCarpools = useMemo(() => carpools.filter((c) => c.members.length <= 1).length, [carpools]);
  const avgCarpoolSize = useMemo(
    () => (carpools.length === 0 ? 0 : carpools.reduce((s, c) => s + c.members.length, 0) / carpools.length),
    [carpools],
  );
  const underSuppliedLegs = useMemo(
    () => seatBalance.filter((b) => b.seatsOffered < b.kidsCount).length,
    [seatBalance],
  );

  useEffect(() => {
    if (users.length === 0 && carpools.length === 0) return;

    const homeAddrs = users
      .filter((u) => u.street && u.zip)
      .map((u) => ({
        key: addressKey(u.street, u.zip),
        street: u.street,
        zip: u.zip,
        id: `home:${u.memberId}`,
        label: u.name,
        address: `${u.street}, ${u.zip}`,
      }));
    const carpoolAddrs = carpools
      .filter((c) => c.destination?.street && c.destination.zip)
      .map((c) => ({
        key: addressKey(c.destination!.street, c.destination!.zip),
        street: c.destination!.street,
        zip: c.destination!.zip,
        id: `carpool:${c.code}`,
        label: c.name,
        address: `${c.destination!.street}, ${c.destination!.zip}`,
      }));

    const uniqueByKey = new Map<string, { key: string; street: string; zip: string }>();
    for (const a of [...homeAddrs, ...carpoolAddrs]) uniqueByKey.set(a.key, a);

    let cancelled = false;
    setGeocoding(true);
    geocodeAll([...uniqueByKey.values()], (done, total) => setGeoProgress({ done, total })).then((cache) => {
      if (cancelled) return;
      const homePoints: MapPoint[] = homeAddrs
        .map((a) => ({ id: a.id, label: a.label, address: a.address, kind: "home" as const, point: cache[a.key] }))
        .filter(
          (p): p is { id: string; label: string; address: string; kind: "home"; point: GeoPoint } =>
            p.point != null,
        );
      const carpoolPoints: MapPoint[] = carpoolAddrs
        .map((a) => ({ id: a.id, label: a.label, address: a.address, kind: "carpool" as const, point: cache[a.key] }))
        .filter(
          (p): p is { id: string; label: string; address: string; kind: "carpool"; point: GeoPoint } =>
            p.point != null,
        );

      const homeIds = new Set(homePoints.map((p) => p.id));
      const carpoolIds = new Set(carpoolPoints.map((p) => p.id));
      const links: Record<string, string[]> = {};
      for (const c of carpools) {
        const carpoolId = `carpool:${c.code}`;
        if (!carpoolIds.has(carpoolId)) continue;
        for (const m of c.members) {
          const homeId = `home:${m.id}`;
          if (!homeIds.has(homeId)) continue;
          (links[carpoolId] ??= []).push(homeId);
          (links[homeId] ??= []).push(carpoolId);
        }
      }
      setAdjacency(links);

      setPoints([...homePoints, ...carpoolPoints]);
      setGeocoding(false);
      setGeoProgress(null);
    });
    return () => {
      cancelled = true;
    };
  }, [users, carpools]);

  return (
    <>
      {tab === "overview" && (
                <section className="admin-dataviz-metrics">
                  <div className="admin-dataviz-grid">
                    <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                      <p className="admin-dataviz-metrics-note admin-muted">
                        Snapshot of the whole app right now — see the other tabs for how these break down.
                      </p>
                      <div className="admin-dataviz-stat-row">
                        <StatTile label="Carpools" value={carpools.length} />
                        <StatTile label="Avg. carpool size" value={avgCarpoolSize.toFixed(1)} />
                        <StatTile label="Solo-member carpools" value={soloCarpools} />
                        <StatTile label="Multi-carpool households" value={multiCarpoolHouseholds.length} />
                        <StatTile label="Under-supplied legs" value={underSuppliedLegs} />
                        <StatTile label="Unassigned kids" value={orphanedKids.length} />
                      </div>
                    </div>

                    <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                      <h3>Carpools created per week</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        How many new carpools were created in each week, from the first carpool to today.
                      </p>
                      <VerticalBars data={weeklyGrowth} />
                    </div>

                    <div className="admin-dataviz-widget">
                      <h3>Carpool size distribution</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        How many carpools have exactly 1, 2, 3... members.
                      </p>
                      <VerticalBars data={sizeDistribution} />
                    </div>

                    <div className="admin-dataviz-widget">
                      <h3>Day-of-week distribution</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        How many carpools run on each day of the week.
                      </p>
                      <VerticalBars data={dayDistribution} />
                    </div>
                  </div>
                </section>
              )}

              {tab === "geography" && (
                <section className="admin-dataviz-metrics">
                  <p className="admin-muted">
                    <span style={{ color: "#2563eb" }}>●</span> homes &nbsp;
                    <span style={{ color: "#dc2626" }}>●</span> carpool destinations &nbsp; hover for
                    relationships, click a carpool for its members' area
                    {geocoding && geoProgress && ` — geocoding ${geoProgress.done}/${geoProgress.total}...`}
                  </p>
                  <div ref={fullscreenRef} className="admin-dataviz-map-wrapper">
                    <div className="admin-dataviz-map-controls">
                      <div className="admin-dataviz-toggle-group">
                        <label className="admin-dataviz-graph-toggle">
                          <input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} />
                          Show map
                        </label>
                        <label className="admin-dataviz-graph-toggle">
                          <input
                            type="checkbox"
                            checked={graphMode}
                            onChange={(e) => setGraphMode(e.target.checked)}
                          />
                          Plot all connections
                        </label>
                        <div className="admin-dataviz-toggle-with-menu" ref={blobMenuRef}>
                          <label className="admin-dataviz-graph-toggle">
                            <input
                              type="checkbox"
                              checked={showAllBlobs}
                              onChange={(e) => setShowAllBlobs(e.target.checked)}
                            />
                            All carpool areas (heatmap)
                          </label>
                          <button
                            type="button"
                            className="admin-dataviz-toggle-menu-chevron"
                            aria-label="Heatmap options"
                            aria-expanded={blobMenuOpen}
                            onClick={() => setBlobMenuOpen((o) => !o)}
                          >
                            ▾
                          </button>
                          {blobMenuOpen && (
                            <div className="admin-dataviz-toggle-menu">
                              <label className="admin-dataviz-graph-toggle">
                                <input
                                  type="checkbox"
                                  checked={includeDestinationInBlobs}
                                  onChange={(e) => setIncludeDestinationInBlobs(e.target.checked)}
                                />
                                Include destination
                              </label>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="admin-dataviz-toggle-group">
                        <button type="button" onClick={() => setResetToken((t) => t + 1)}>
                          Reset view
                        </button>
                        <button type="button" onClick={toggleFullscreen}>
                          {isFullscreen ? "Exit full screen" : "Full screen"}
                        </button>
                      </div>
                    </div>
                    <MapView
                      points={points}
                      adjacency={adjacency}
                      graphMode={graphMode}
                      showAllBlobs={showAllBlobs}
                      includeDestinationInBlobs={includeDestinationInBlobs}
                      showMap={showMap}
                      resetToken={resetToken}
                      interactive={isFullscreen}
                    />
                  </div>

                  <div className="admin-dataviz-grid">
                    <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                      <h3>Home-to-destination distance</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        How far each member's home is from their carpool's destination, straight-line
                        (not driving distance).
                      </p>
                      <VerticalBars data={distanceHistogram} height={100} />
                    </div>

                    {carpoolSprawl.length > 0 && (
                      <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                        <h3>Carpool sprawl</h3>
                        <p className="admin-dataviz-metrics-note admin-muted">
                          The farthest distance between any two members' homes within the same carpool —
                          how spread out (vs. tight-knit) each carpool's neighborhood is.
                        </p>
                        <BarList
                          data={carpoolSprawl
                            .slice(0, 10)
                            .map((c) => ({ label: c.name, count: Math.round(c.miles * 10) / 10 }))}
                          unit=" mi"
                        />
                      </div>
                    )}
                  </div>
                </section>
              )}

              {tab === "fairness" && (
                <section className="admin-dataviz-metrics">
                  <p className="admin-muted">Computed from the current data snapshot — no usage/event tracking yet.</p>

                  <div className="admin-dataviz-grid">
                  <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                    <h3>Driving load (weighted score, across all their carpools)</h3>
                    <p className="admin-dataviz-metrics-note admin-muted">
                      A proprietary load score, not a literal kid count: someone else's kid in your car
                      counts {OTHER_KID_WEIGHT}&times; toward your score, your own kid only{" "}
                      {OWN_KID_WEIGHT}&times; — driving your own kid where you were already headed is the
                      baseline, not a favor to anyone. Includes every kid nobody's explicitly assigned a
                      car for yet, credited to their own parent (at the {OWN_KID_WEIGHT}&times; rate) so an
                      unfilled-in carpool doesn't just disappear from the picture. A ride someone else is
                      covering for you — your kid riding in their car — adds nothing to your own score.
                    </p>
                    {driverLoads.length === 0 ? (
                      <p className="admin-muted">No carpools yet.</p>
                    ) : (
                      <BarList
                        data={driverLoads.slice(0, 10).map((d) => ({
                          label: d.name,
                          count: Math.round(d.score * 10) / 10,
                        }))}
                      />
                    )}
                  </div>

                  <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                    <h3>Seat balance (most under-supplied legs first)</h3>
                    <p className="admin-dataviz-metrics-note admin-muted">
                      Seats offered minus kids needing a ride — negative means the leg is short on drivers.
                    </p>
                    {seatBalance.filter((b) => b.kidsCount > 0).length === 0 ? (
                      <p className="admin-muted">No data yet.</p>
                    ) : (
                      <DivergingBarList
                        data={seatBalance
                          .filter((b) => b.kidsCount > 0)
                          .slice(0, 10)
                          .map((b) => ({
                            label: `${b.carpoolName} (${b.leg})`,
                            count: b.seatsOffered - b.kidsCount,
                          }))}
                      />
                    )}
                  </div>

                  {unusedDrivers.length > 0 && (
                    <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                      <h3>Willing but unused drivers ({unusedDrivers.length})</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        Can drive this leg, but has no car assigned.
                      </p>
                      <div className="admin-table-wrap">
                        <table className="admin-table">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Carpool</th>
                              <th>Leg</th>
                            </tr>
                          </thead>
                          <tbody>
                            {unusedDrivers.map((d, i) => (
                              <tr key={i}>
                                <td>{d.name}</td>
                                <td>{d.carpoolName}</td>
                                <td>{d.leg}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  </div>
                </section>
              )}

              {tab === "households" && (
                <section className="admin-dataviz-metrics">
                  <div className="admin-dataviz-grid">
                    <div className="admin-dataviz-widget">
                      <h3>Kids per household</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        How many households have exactly 1, 2, 3... kids enrolled (co-parents counted once,
                        as one household).
                      </p>
                      <PieChart data={kidsPerFamily} />
                    </div>

                    <div className="admin-dataviz-widget">
                      <h3>Carpools per household</h3>
                      <p className="admin-dataviz-metrics-note admin-muted">
                        How many households are in exactly 1, 2, 3... different carpools (co-parents
                        counted once, as one household).
                      </p>
                      <PieChart data={carpoolCountDistribution} />
                    </div>

                    {multiCarpoolHouseholds.length > 0 && (
                      <div className="admin-dataviz-widget admin-dataviz-widget-wide">
                        <h3>Multi-carpool households</h3>
                        <p className="admin-dataviz-metrics-note admin-muted">
                          Households with members in 2 or more different carpools — the app's
                          most-engaged repeat users.
                        </p>
                        <BarList
                          data={multiCarpoolHouseholds
                            .slice(0, 10)
                            .map((h) => ({ label: h.label, count: h.carpoolCount }))}
                          unit=" carpools"
                        />
                      </div>
                    )}
                  </div>
                </section>
              )}

              {tab === "recommendations" && (
                <section className="admin-dataviz-recs">
                  <h2>Recommendations</h2>
                  <p className="admin-muted">
                    People whose carpool-mates are also in carpools they haven't joined — likely the same
                    team/activity split across multiple carpools.
                  </p>
                  <div className="admin-dataviz-threshold-bar">
                    <span className="admin-muted">Min. shared kid-teammates:</span>
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={n === recThreshold ? "active" : ""}
                        onClick={() => setRecThreshold(n)}
                      >
                        {n}+
                      </button>
                    ))}
                  </div>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Kids</th>
                          <th>Recommended carpools</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parentRows.map((row) => (
                          <tr key={row.key}>
                            <td>{row.label}</td>
                            <td>
                              {row.kids.length === 0 ? (
                                <span className="admin-muted">—</span>
                              ) : (
                                row.kids.map((k) => (
                                  <div key={k.kidName} className="admin-dataviz-kid-line">
                                    {k.kidName}
                                  </div>
                                ))
                              )}
                            </td>
                            <td>
                              {row.kids.length === 0 ? (
                                <span className="admin-muted">—</span>
                              ) : (
                                row.kids.map((k) => (
                                  <div key={k.kidName} className="admin-dataviz-kid-line">
                                    {k.recs.length === 0 ? (
                                      <span className="admin-muted">—</span>
                                    ) : (
                                      k.recs.map((r, i) => (
                                        <span
                                          key={r.carpoolCode}
                                          title={`Shared with ${r.sharedMateNames.join(", ")}`}
                                        >
                                          {i > 0 && ", "}
                                          {r.carpoolName}
                                        </span>
                                      ))
                                    )}
                                  </div>
                                ))
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
    </>
  );
}
