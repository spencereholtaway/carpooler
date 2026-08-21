import type { Address, Carpool, DayOfWeek, Leg, Member } from "./types";
import type { LocalProfile } from "./useProfile";

async function unwrap(res: Response) {
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function claimName(
  name: string,
  memberId: string
): Promise<{ recovered: boolean; memberId: string }> {
  const res = await fetch("/api/claim-name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, memberId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listCarpools(memberId: string): Promise<Carpool[]> {
  return unwrap(await fetch(`/api/carpools?memberId=${encodeURIComponent(memberId)}`));
}

export async function createCarpool(
  name: string,
  day: DayOfWeek,
  destination: Address,
  dropOff: Leg,
  pickUp: Leg,
  member: Member,
  timezone: string
): Promise<Carpool> {
  return unwrap(
    await fetch("/api/carpools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, day, destination, dropOff, pickUp, member, timezone }),
    })
  );
}

export async function joinCarpool(code: string, member: Member): Promise<Carpool> {
  return unwrap(
    await fetch("/api/carpools/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, member }),
    })
  );
}

export async function saveServerProfile(memberId: string, profile: LocalProfile): Promise<void> {
  await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId, profile }),
  });
}

export async function getServerProfile(memberId: string): Promise<Omit<LocalProfile, "name"> | null> {
  const res = await fetch(`/api/profile?memberId=${encodeURIComponent(memberId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getHousehold(
  memberId: string
): Promise<{ code: string; coParentId: string | null; coParentName: string | null; combined: boolean }> {
  return unwrap(await fetch(`/api/household?memberId=${encodeURIComponent(memberId)}`));
}

export async function setHouseholdCombined(
  memberId: string,
  combined: boolean
): Promise<{ combined: boolean }> {
  return unwrap(
    await fetch("/api/household/combine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, combined }),
    })
  );
}

export async function linkHousehold(
  code: string,
  memberId: string
): Promise<{
  coParentId: string;
  coParentName: string | null;
  coParentKids: string[];
  coParentStreet: string | null;
  coParentZip: string | null;
}> {
  return unwrap(
    await fetch("/api/household/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, memberId }),
    })
  );
}

export type Update = { id: string; text: string; createdAt: number };

export async function listUpdates(): Promise<Update[]> {
  const { updates } = await unwrap(await fetch("/api/updates"));
  return updates;
}

export type RecommendationCard = {
  carpoolCode: string;
  carpoolName: string;
  kidNames: string[];
  memberFirstNames: string[];
};

export async function getRecommendations(memberId: string): Promise<RecommendationCard[]> {
  const { recs } = await unwrap(await fetch(`/api/recommendations?memberId=${encodeURIComponent(memberId)}`));
  return recs;
}

export async function updateCarpoolSchedule(
  code: string,
  day: DayOfWeek,
  destination: Address,
  dropOff: Leg,
  pickUp: Leg,
  name?: string,
  timezone?: string
): Promise<Carpool> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, day, destination, dropOff, pickUp, name, timezone }),
    })
  );
}
