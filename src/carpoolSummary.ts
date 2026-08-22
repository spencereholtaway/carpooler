import type { Car, Carpool, Member } from "./types";

export function formatTime(time: string) {
  if (!time) return "no time set";
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

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
export function computeKidDefaults<M extends { id: string; kids: string[] }>(
  members: M[]
): Map<string, string> {
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
export function resolveKidDrivers<M extends { id: string; kids: string[] }>(
  cars: Car[],
  members: M[],
  kidDefaults: Map<string, string>
): Map<string, string> {
  const kidToDriver = new Map<string, string>();
  for (const car of cars) for (const k of car.kids) kidToDriver.set(k, car.driverId);

  // A member having *some* car in this leg doesn't mean their own kid is
  // covered — that car might be empty (e.g. a kid toggled off and back on
  // via admin never re-syncs the car). assignedElsewhere already excludes
  // any kid actually sitting in a car, including this member's own, so it's
  // safe to check every member here rather than skipping ones with a car.
  const assignedElsewhere = new Set(kidToDriver.keys());
  for (const m of members) {
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
  leg: "dropOff" | "pickUp",
  selfKids: string[],
  members: Member[],
  drivenBySelf: string[],
  bothWaysKids: string[],
  bothWaysByDriver: Map<string, string[]>
): string[] {
  const sentences: string[] = [];
  const soloKids = drivenBySelf.filter((k) => !bothWaysKids.includes(k));
  if (soloKids.length > 0) {
    sentences.push(
      leg === "dropOff"
        ? `You're taking ${joinList(soloKids)} there.`
        : `You're picking ${joinList(soloKids)} up.`
    );
  }

  const otherGroups = new Map<string, string[]>();
  const unarranged: string[] = [];
  for (const kid of selfKids) {
    if (drivenBySelf.includes(kid)) continue;
    const driverId = kidToDriver.get(kid);
    if (driverId) {
      // Already covered by that driver's own dedicated "both ways" line.
      if (bothWaysByDriver.get(driverId)?.includes(kid)) continue;
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

// The blisspoolAI line(s) for a carpool from this member's point of view,
// joined with "\n" — shared between the full carpool detail view and the
// compact carpools list. A driver (self or someone else) whose drop-off and
// pick-up legs are the exact same set of kids gets a combined "both ways"
// line instead of two separate ones.
export function summarizeCarpool(carpool: Carpool, memberId: string): string {
  const self = carpool.members.find((m) => m.id === memberId);
  if (!self) return "";

  const kidDefaults = computeKidDefaults(carpool.members);
  const allCarpoolKids = [...new Set(carpool.members.flatMap((m) => m.kids))];

  const dropOffDrivers = resolveKidDrivers(carpool.dropOff?.cars ?? [], carpool.members, kidDefaults);
  const pickUpDrivers = resolveKidDrivers(carpool.pickUp?.cars ?? [], carpool.members, kidDefaults);

  // "Both ways" only applies when a driver's two legs are the exact same
  // set of kids — a driver taking Mo, Miles, and William there but only
  // picking up Miles and William isn't driving "both ways", they're just
  // driving different kids on each leg, so each leg reports its own list.
  const driverIds = new Set([...dropOffDrivers.values(), ...pickUpDrivers.values()]);
  const bothWaysByDriver = new Map<string, string[]>();
  for (const driverId of driverIds) {
    const dropOffKids = allCarpoolKids.filter((k) => dropOffDrivers.get(k) === driverId);
    const pickUpKids = allCarpoolKids.filter((k) => pickUpDrivers.get(k) === driverId);
    const sameKids =
      dropOffKids.length > 0 &&
      dropOffKids.length === pickUpKids.length &&
      dropOffKids.every((k) => pickUpKids.includes(k));
    if (sameKids) bothWaysByDriver.set(driverId, dropOffKids);
  }

  const dropOffSelf = allCarpoolKids.filter((k) => dropOffDrivers.get(k) === memberId);
  const pickUpSelf = allCarpoolKids.filter((k) => pickUpDrivers.get(k) === memberId);
  const bothWaysKids = bothWaysByDriver.get(memberId) ?? [];

  // Only mention another driver's own "both ways" arrangement when it
  // involves one of self's kids — other families' pickups aren't self's
  // business, even when they happen to also be a both-ways drive.
  const otherBothWaysLines = [...bothWaysByDriver.entries()]
    .filter(([driverId]) => driverId !== memberId)
    .map(([driverId, kids]) => {
      const relevantKids = kids.filter((k) => self.kids.includes(k));
      if (relevantKids.length === 0) return null;
      const name = carpool.members.find((m) => m.id === driverId)?.name ?? "Someone";
      return `${name} is driving ${joinList(relevantKids)} both ways.`;
    })
    .filter((line): line is string => line !== null);

  return [
    bothWaysKids.length > 0 ? `You're driving ${joinList(bothWaysKids)} both ways.` : "",
    ...otherBothWaysLines,
    legSentences(dropOffDrivers, "dropOff", self.kids, carpool.members, dropOffSelf, bothWaysKids, bothWaysByDriver).join(" "),
    legSentences(pickUpDrivers, "pickUp", self.kids, carpool.members, pickUpSelf, bothWaysKids, bothWaysByDriver).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

// How many free seats *other* members are offering across a leg, summed —
// mirrors DrivingLeg's "free" calculation per car (car.seats minus kids
// already riding who aren't that driver's own), but only counts cars this
// member doesn't drive themselves. Only evaluated at all when this member is
// driving that same leg (see openSeatsFromOthers) — if their kid is already
// riding with someone else, that other driver's spare seats aren't telling
// them anything they can act on.
function legOtherOpenSeats(cars: Car[], members: Member[], memberId: string): number {
  let total = 0;
  for (const car of cars) {
    if (car.driverId === memberId) continue;
    const driverKids = new Set(members.find((m) => m.id === car.driverId)?.kids ?? []);
    const otherKidsInCar = car.kids.filter((k) => !driverKids.has(k)).length;
    total += Math.max(car.seats - otherKidsInCar, 0);
  }
  return total;
}

// The most free seats other members are offering on a leg this member is
// themselves driving — flags "you don't have to drive this leg, someone
// else already has room" for the specific drive that's actually theirs to
// give up. "Driving" here means the same thing the AI summary line means:
// resolveKidDrivers says one of their own kids currently rides with them,
// whether that's an explicit car or just the default "you're always good
// for your own kid" fallback with no car at all — a defaulted parent with
// zero commitment is exactly who most benefits from being told someone
// else already has room. A leg where their kid already rides with someone
// else has no driving decision to reconsider, so it's skipped even if some
// other car on it happens to have room.
export function openSeatsFromOthers(carpool: Carpool, memberId: string): number {
  const self = carpool.members.find((m) => m.id === memberId);
  if (!self) return 0;
  const kidDefaults = computeKidDefaults(carpool.members);
  const dropOffCars = carpool.dropOff?.cars ?? [];
  const pickUpCars = carpool.pickUp?.cars ?? [];
  const dropOffDrivers = resolveKidDrivers(dropOffCars, carpool.members, kidDefaults);
  const pickUpDrivers = resolveKidDrivers(pickUpCars, carpool.members, kidDefaults);
  const selfDrivesLeg = (drivers: Map<string, string>) => self.kids.some((k) => drivers.get(k) === memberId);
  return Math.max(
    selfDrivesLeg(dropOffDrivers) ? legOtherOpenSeats(dropOffCars, carpool.members, memberId) : 0,
    selfDrivesLeg(pickUpDrivers) ? legOtherOpenSeats(pickUpCars, carpool.members, memberId) : 0
  );
}
