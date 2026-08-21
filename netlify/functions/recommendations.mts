import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Member = { id: string; name: string; kids: string[] };
type Carpool = { code: string; name: string; day: string; members: Member[] };
type ServerProfile = { name: string; kids: string[] };

type RecommendationCard = {
  carpoolCode: string;
  carpoolName: string;
  carpoolDay: string;
  kidNames: string[];
  memberFirstNames: string[];
};

const MIN_SHARED = 2;

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

// Mirrors AdminDataviz.tsx's computeRecommendations (kept as a separate,
// self-contained copy per this codebase's existing convention of not
// sharing code between Netlify functions and the frontend — see the
// kid-centric refactor plan for why that's a known, deliberate gap for now).
// Computes recommendations per kid for the given owners (the caller, plus
// their co-parent if any), scoped so this endpoint never needs to expose
// any other family's raw data — only carpool names/members they'd be
// riding with.
function computeRecommendations(
  owners: { memberId: string; kids: string[] }[],
  carpools: Carpool[],
): { kidName: string; ownerId: string; carpoolCode: string }[] {
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

  const results: { kidName: string; ownerId: string; carpoolCode: string }[] = [];
  for (const owner of owners) {
    const myCarpools = memberCarpoolCodes.get(owner.memberId);
    if (!myCarpools || myCarpools.size === 0) continue;

    for (const kidName of owner.kids) {
      const myKidCarpools = kidCarpoolCodes.get(`${owner.memberId}::${kidName}`);
      if (!myKidCarpools) continue;

      const teammateKidsByCandidate = new Map<string, Set<string>>();
      for (const myCode of myKidCarpools) {
        const sharedCarpool = carpoolByCode.get(myCode);
        if (!sharedCarpool) continue;
        for (const mate of sharedCarpool.members) {
          if (mate.id === owner.memberId) continue;
          for (const mateKidName of mate.kids) {
            for (const candidateCode of kidCarpoolCodes.get(`${mate.id}::${mateKidName}`) ?? []) {
              if (myCarpools.has(candidateCode)) continue;
              if (!teammateKidsByCandidate.has(candidateCode)) teammateKidsByCandidate.set(candidateCode, new Set());
              teammateKidsByCandidate.get(candidateCode)!.add(mateKidName);
            }
          }
        }
      }

      for (const [candidateCode, teammateKids] of teammateKidsByCandidate) {
        if (teammateKids.size >= MIN_SHARED) {
          results.push({ kidName, ownerId: owner.memberId, carpoolCode: candidateCode });
        }
      }
    }
  }
  return results;
}

export default async (req: Request) => {
  const memberId = new URL(req.url).searchParams.get("memberId") ?? "";
  if (!memberId) return new Response("Missing memberId", { status: 400 });

  const store = getStore("carpools", { consistency: "strong" });

  const ownProfile = (await store.get(`profile:${memberId}`, { type: "json" })) as ServerProfile | null;
  if (!ownProfile) return new Response(JSON.stringify({ recs: [] }), { headers: { "Content-Type": "application/json" } });

  const coParentId = (await store.get(`coparent:${memberId}`)) as string | null;
  const coProfile = coParentId
    ? ((await store.get(`profile:${coParentId}`, { type: "json" })) as ServerProfile | null)
    : null;

  const owners = [
    { memberId, kids: ownProfile.kids },
    ...(coParentId && coProfile ? [{ memberId: coParentId, kids: coProfile.kids }] : []),
  ];

  const { blobs: codeBlobs } = await store.list({ prefix: "code:" });
  const carpools = (
    await Promise.all(codeBlobs.map((b) => store.get(b.key, { type: "json" })))
  ).filter(Boolean) as Carpool[];

  const raw = computeRecommendations(owners, carpools);
  const carpoolByCode = new Map(carpools.map((c) => [c.code, c]));

  // Collapse per-kid results into one card per carpool, since the same
  // carpool can be recommended for more than one kid at once.
  const byCarpool = new Map<string, Set<string>>();
  for (const r of raw) {
    if (!byCarpool.has(r.carpoolCode)) byCarpool.set(r.carpoolCode, new Set());
    byCarpool.get(r.carpoolCode)!.add(r.kidName);
  }

  const cards: RecommendationCard[] = [...byCarpool.entries()].map(([code, kidNames]) => {
    const carpool = carpoolByCode.get(code)!;
    return {
      carpoolCode: code,
      carpoolName: carpool.name,
      carpoolDay: carpool.day,
      kidNames: [...kidNames],
      memberFirstNames: carpool.members.map((m) => firstName(m.name)),
    };
  });

  return new Response(JSON.stringify({ recs: cards }), { headers: { "Content-Type": "application/json" } });
};

export const config: Config = {
  path: "/api/recommendations",
};
