import type { Car, Carpool, Member } from "./types";

export function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// When the same kid is listed on more than one member (shared between linked
// coparents), only the member who joined this carpool first — i.e. appears
// earliest in `members` — gets them by default. Everyone else starts at
// "Nobody" until the kid is explicitly moved to them.
export function computeKidDefaults(members: Member[]): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const m of members) {
    for (const k of m.kids) {
      if (!defaults.has(k)) defaults.set(k, m.id);
    }
  }
  return defaults;
}

// Mirrors DrivingLeg's own per-row resolution: a kid rides in an explicit
// car if one claims them, otherwise they default to riding with whichever
// parent owns them (kidDefaults) even though that parent has no car entry —
// same "you're always good for your own kid" assumption the driving rows
// display, so the summary has to agree with what those rows show.
export function resolveKidDrivers(
  cars: Car[],
  members: Member[],
  kidDefaults: Map<string, string>
): Map<string, string> {
  const kidToDriver = new Map<string, string>();
  for (const car of cars) for (const k of car.kids) kidToDriver.set(k, car.driverId);

  const assignedElsewhere = new Set(kidToDriver.keys());
  for (const m of members) {
    if (cars.some((c) => c.driverId === m.id)) continue;
    for (const k of m.kids) {
      if (!assignedElsewhere.has(k) && kidDefaults.get(k) === m.id) kidToDriver.set(k, m.id);
    }
  }
  return kidToDriver;
}

// Boils a leg's ride assignments down to what actually matters to this one
// member: everyone they're driving (their own kids and anyone else's riding
// along), and — for their own kids they aren't driving — who is, or that
// nobody's arranged it yet.
function legSentences(
  kidToDriver: Map<string, string>,
  allCarpoolKids: string[],
  leg: "dropOff" | "pickUp",
  selfId: string,
  selfKids: string[],
  members: Member[]
): string[] {
  const sentences: string[] = [];
  const drivenBySelf = allCarpoolKids.filter((k) => kidToDriver.get(k) === selfId);
  if (drivenBySelf.length > 0) {
    sentences.push(
      leg === "dropOff"
        ? `You're taking ${joinList(drivenBySelf)} there.`
        : `You're picking ${joinList(drivenBySelf)} up.`
    );
  }

  const otherGroups = new Map<string, string[]>();
  const unarranged: string[] = [];
  for (const kid of selfKids) {
    if (drivenBySelf.includes(kid)) continue;
    const driverId = kidToDriver.get(kid);
    if (driverId) {
      if (!otherGroups.has(driverId)) otherGroups.set(driverId, []);
      otherGroups.get(driverId)!.push(kid);
    } else {
      unarranged.push(kid);
    }
  }
  for (const [driverId, kids] of otherGroups) {
    const name = members.find((m) => m.id === driverId)?.name ?? "Someone";
    sentences.push(
      leg === "dropOff"
        ? `${name} is taking ${joinList(kids)} there.`
        : `${name} is picking ${joinList(kids)} up.`
    );
  }
  if (unarranged.length > 0) {
    sentences.push(`No ride arranged yet for ${joinList(unarranged)}.`);
  }
  return sentences;
}

// The blisspoolAI line(s) for a carpool from this member's point of view —
// one line per leg, joined with "\n" — shared between the full carpool
// detail view and the compact carpools list.
export function summarizeCarpool(carpool: Carpool, memberId: string): string {
  const self = carpool.members.find((m) => m.id === memberId);
  if (!self) return "";

  const kidDefaults = computeKidDefaults(carpool.members);
  const allCarpoolKids = [...new Set(carpool.members.flatMap((m) => m.kids))];

  return [
    legSentences(
      resolveKidDrivers(carpool.dropOff?.cars ?? [], carpool.members, kidDefaults),
      allCarpoolKids,
      "dropOff",
      memberId,
      self.kids,
      carpool.members
    ).join(" "),
    legSentences(
      resolveKidDrivers(carpool.pickUp?.cars ?? [], carpool.members, kidDefaults),
      allCarpoolKids,
      "pickUp",
      memberId,
      self.kids,
      carpool.members
    ).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}
