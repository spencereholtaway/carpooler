import type {
  Address,
  CarpoolOccurrence,
  CarpoolSeries,
  DayOfWeek,
  Leg,
  Member,
  RecurrenceType,
} from "./types";
import type { LocalProfile } from "./useProfile";

async function unwrap(res: Response) {
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type CarpoolsResult = { carpools: CarpoolSeries[]; occurrences: CarpoolOccurrence[] };
export type CarpoolResult = { carpool: CarpoolSeries; occurrences: CarpoolOccurrence[] };

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

export async function listCarpools(memberId: string): Promise<CarpoolsResult> {
  return unwrap(await fetch(`/api/carpools?memberId=${encodeURIComponent(memberId)}`));
}

export type Recurrence = { type: RecurrenceType; daysOfWeek?: DayOfWeek[]; startDate: string };

export async function createCarpool(
  name: string,
  recurrence: Recurrence,
  destination: Address,
  dropOff: Leg,
  pickUp: Leg,
  member: Member,
  timezone: string
): Promise<CarpoolResult> {
  return unwrap(
    await fetch("/api/carpools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, recurrence, destination, dropOff, pickUp, member, timezone }),
    })
  );
}

export async function joinCarpool(code: string, member: Member): Promise<CarpoolResult> {
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
  carpoolDay: string;
  kidNames: string[];
  memberFirstNames: string[];
};

export async function getRecommendations(memberId: string): Promise<RecommendationCard[]> {
  const { recs } = await unwrap(await fetch(`/api/recommendations?memberId=${encodeURIComponent(memberId)}`));
  return recs;
}

// "This and all future, starting <startDate>" — the only edit scope that
// applies to a day/time/driver-default change. `startDate` today closes and
// reopens the current era in place; a future date splits it. See EditScope
// in types.ts for why there's no "all, including past" for schedule fields.
export async function updateCarpoolSchedule(
  code: string,
  recurrence: Recurrence,
  dropOff: Leg,
  pickUp: Leg
): Promise<CarpoolResult> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        scope: "thisAndFuture",
        startDate: recurrence.startDate,
        type: recurrence.type,
        daysOfWeek: recurrence.daysOfWeek,
        dropOff,
        pickUp,
      }),
    })
  );
}

// "All, including past" — only ever offered for name/destination, since a
// label isn't a fact of history the way a schedule field is.
export async function updateCarpoolLabel(
  code: string,
  fields: { name?: string; destination?: Address; timezone?: string }
): Promise<CarpoolResult> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, scope: "all", ...fields }),
    })
  );
}

// "Just this one" — overrides a single occurrence's drop-off and/or pick-up,
// never touching the series defaults or any other date.
export async function updateOccurrence(
  code: string,
  date: string,
  fields: { dropOff?: Leg; pickUp?: Leg }
): Promise<CarpoolOccurrence> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, scope: "occurrence", date, ...fields }),
    })
  );
}

// "All" — a genuine retroactive correction, every occurrence past and
// future, overriding even individually-overridden ones. For "we always had
// the wrong time on file," not a real schedule change.
export async function updateTimeEverywhere(
  code: string,
  leg: "dropOff" | "pickUp",
  time: string
): Promise<CarpoolResult> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, scope: "allTime", leg, time }),
    })
  );
}

// "Just this one," when the day itself changed — reschedules a single
// occurrence to a different date without touching the recurring pattern.
// Throws (409) if the target date already has a real occurrence on it.
export async function moveOccurrence(
  code: string,
  fromDate: string,
  toDate: string,
  fields: { dropOff?: Leg; pickUp?: Leg }
): Promise<CarpoolResult> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, scope: "moveOccurrence", fromDate, toDate, ...fields }),
    })
  );
}

// "My kid isn't doing it this week" — pulls one kid out of every car for a
// single occurrence (skipped: true), or re-adds them to the default pool
// (skipped: false). Never touches anyone else's seats/eligibility.
export async function skipKid(
  code: string,
  date: string,
  kid: string,
  skipped: boolean,
  memberId: string
): Promise<CarpoolOccurrence> {
  return unwrap(
    await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, scope: "skipKid", date, kid, skipped, memberId }),
    })
  );
}
