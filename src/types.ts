export type Member = {
  id: string;
  name: string;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
  street: string;
  zip: string;
  coparentId?: string | null;
};

export type Car = {
  driverId: string;
  kids: string[];
  seats: number;
};

export type Leg = {
  time: string; // "HH:MM", 24h
  cars: Car[];
};

export const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export type Address = {
  street: string;
  zip: string;
};

// Collapses any run of whitespace (including non-breaking spaces, which look
// identical to a regular space but aren't caught by .trim()) down to a
// single space, so two addresses that render identically also compare and
// geocode identically instead of silently drifting to different map pins.
export function normalizeAddressField(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Legacy shape — a Carpool used to be both the recurrence definition and the
// only occurrence, with one `day` field and one `dropOff`/`pickUp` pair
// shared by every future week forever. Superseded by CarpoolSeries (a
// timeline of RecurrenceEras) + CarpoolOccurrence (one per real date), but
// kept here until every reader/writer of the old shape has migrated.
export type Carpool = {
  code: string;
  name: string;
  day: DayOfWeek;
  destination: Address;
  dropOff: Leg;
  pickUp: Leg;
  members: Member[];
  createdAt: number;
  timezone: string; // IANA zone, e.g. "America/Los_Angeles"
};

export type RecurrenceType = "weekly" | "biweekly" | "oneoff";

// One stretch of a carpool's schedule: which day(s) of the week, how often,
// and what the default drop-off/pick-up assignment is for occurrences
// generated in that stretch. A series holds a *list* of these (not one fixed
// rule) because "move Wednesday practice to Tuesday, starting next month"
// has to close one era and open another rather than overwrite the only rule
// there is — see the "this and all future" edit scope.
export type RecurrenceEra = {
  startDate: string; // ISO date, e.g. "2026-08-24"
  endDate: string | null; // ISO date, inclusive; null = ongoing
  type: RecurrenceType;
  daysOfWeek: DayOfWeek[]; // ignored for "oneoff"; a set, not a single day (e.g. a school run is Mon-Fri)
  defaultDropOff: Leg;
  defaultPickUp: Leg;
};

// The recurring definition + defaults for a carpool. Stored at the same
// `code:{code}` key a legacy Carpool used, so join codes, member carpool
// lists, and the ICS subscription URL are all unaffected by this split.
export type CarpoolSeries = {
  code: string;
  name: string;
  destination: Address;
  recurrenceEras: RecurrenceEra[];
  members: Member[];
  createdAt: number;
  timezone: string;
};

// Which of a CarpoolOccurrence's fields were explicitly changed for that one
// date, as opposed to inherited from the series' current era defaults.
export type OccurrenceOverrides = {
  dropOff: boolean;
  pickUp: boolean;
};

// One concrete dated instance of a series, generated ahead of time so it can
// carry its own persisted state (an override, or a "already counted toward
// driving history" flag) that a purely computed date could never hold.
export type CarpoolOccurrence = {
  code: string;
  date: string; // ISO date, e.g. "2026-09-07"
  dropOff: Leg;
  pickUp: Leg;
  overridden: OccurrenceOverrides;
  historized: boolean;
  // Individually rescheduled to a date its series wouldn't otherwise
  // generate (e.g. "just this Wednesday practice, moved to Thursday").
  moved?: boolean;
  // The date a moved occurrence vacated — never shown, never counted.
  cancelled?: boolean;
  // Kids not participating in this specific occurrence (a trip that day,
  // etc.) — removed from every car on both legs, excluded from the
  // unclaimed-kid-defaults-to-own-parent fallback everywhere it's computed.
  skippedKids?: string[];
  generatedAt: number;
};

// The edit-scope choice every schedule/label edit has to answer. "all" is
// only ever offered for name/destination — see the plan's Edit scope section
// for why day/time/driver-default edits never get a retroactive option.
export type EditScope =
  | { kind: "occurrence"; date: string }
  | { kind: "thisAndFuture"; startDate: string }
  | { kind: "all" };

// Zones we expect carpools to actually be in, shown in a picker. If a
// browser's detected zone isn't one of these, callers should add it as an
// extra option rather than force a pick from this list.
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
];

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function isoWeekdayIndex(dateISO: string): number {
  return (new Date(dateISO + "T00:00:00Z").getUTCDay() + 6) % 7;
}

export function isoWeekday(dateISO: string): DayOfWeek {
  return DAYS_OF_WEEK[isoWeekdayIndex(dateISO)];
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Monday of the calendar week (not rolling 7 days) containing `dateISO`.
export function mondayOfISO(dateISO: string): string {
  return addDaysISO(dateISO, -isoWeekdayIndex(dateISO));
}

// How many calendar weeks separate the Monday of `dateISO`'s week from the
// Monday of `fromISO`'s week — 0 = same week, 1 = the following week, etc.
export function weeksAheadOf(dateISO: string, fromISO: string): number {
  const a = new Date(mondayOfISO(dateISO) + "T00:00:00Z").getTime();
  const b = new Date(mondayOfISO(fromISO) + "T00:00:00Z").getTime();
  return Math.round((a - b) / (7 * 86400000));
}

// "Today" as a calendar date in `timeZone` (defaults to the browser's own
// zone). Deliberately NOT `new Date().toISOString().slice(0, 10)` — that
// converts to UTC first, so anyone west of UTC sees tomorrow's date starting
// in the evening (e.g. 9pm Pacific is already after midnight UTC).
export function todayISO(timeZone?: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timeZone || detectTimezone() });
}

// "Today, August 25" / "Tomorrow, August 26" / "Wednesday, August 27" — a
// human-readable label for picking one date out of a list, as opposed to
// relativeHeading's terser day-list headings.
export function friendlyDateLabel(dateISO: string): string {
  const today = todayISO();
  const d = new Date(dateISO + "T00:00:00Z");
  const monthDay = d.toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
  if (dateISO === today) return `Today, ${monthDay}`;
  if (dateISO === addDaysISO(today, 1)) return `Tomorrow, ${monthDay}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
  return `${weekday}, ${monthDay}`;
}

// The active era "right now" — the last era (in startDate order) whose
// startDate has already arrived. Mirrors the same lookup every backend
// function that touches a series does server-side.
export function currentEra(series: CarpoolSeries): RecurrenceEra {
  const today = todayISO(series.timezone);
  let found = series.recurrenceEras[0];
  for (const era of series.recurrenceEras) {
    if (era.startDate <= today) found = era;
  }
  return found;
}

// Closest date to `anchorDate` (either direction) whose weekday is
// `targetDay` — used to compute where a single moved occurrence lands (e.g.
// "this Wednesday practice, moved to Thursday" lands on the Thursday
// nearest that same Wednesday, not some arbitrary future Thursday).
export function nearestDateForWeekday(anchorDate: string, targetDay: DayOfWeek): string {
  let best = anchorDate;
  let bestDist = Infinity;
  for (let d = -6; d <= 6; d++) {
    const candidate = addDaysISO(anchorDate, d);
    if (isoWeekday(candidate) !== targetDay) continue;
    if (Math.abs(d) < bestDist) {
      bestDist = Math.abs(d);
      best = candidate;
    }
  }
  return best;
}

// Nearest date at/after `fromISO` whose weekday is in `daysOfWeek` — used to
// suggest (and validate) a schedule edit's "Starting" date. Searches at most
// two weeks out, which always finds a match for any non-empty day set.
export function nextValidDate(daysOfWeek: DayOfWeek[], fromISO: string): string {
  for (let i = 0; i < 14; i++) {
    const d = addDaysISO(fromISO, i);
    if (daysOfWeek.includes(isoWeekday(d))) return d;
  }
  return fromISO;
}

// Adapts a series + one of its occurrences back into the flat legacy Carpool
// shape, so all the existing driver/seat/kid/AI-summary UI (built against
// that shape) keeps working completely unchanged against whichever
// occurrence is currently being viewed. Falls back to empty legs if the
// occurrence isn't loaded yet, so callers never have to null-check `carpool`
// before every hook that reads it.
export function toCarpoolView(series: CarpoolSeries, occurrence: CarpoolOccurrence | undefined): Carpool {
  // Skipped kids are stripped out of each member's kids list for this view
  // only (the real series data is untouched) — every existing driver/AI-
  // summary computation reads from members[].kids and has no idea dates
  // exist, so this is what makes them naturally treat a skipped kid as not
  // part of the carpool for this one occurrence, with zero special-casing
  // anywhere else.
  const skipped = new Set(occurrence?.skippedKids ?? []);
  const members = skipped.size === 0 ? series.members : series.members.map((m) => ({ ...m, kids: m.kids.filter((k) => !skipped.has(k)) }));
  return {
    code: series.code,
    name: series.name,
    day: occurrence ? isoWeekday(occurrence.date) : "Monday",
    destination: series.destination,
    dropOff: occurrence?.dropOff ?? { time: "", cars: [] },
    pickUp: occurrence?.pickUp ?? { time: "", cars: [] },
    members,
    createdAt: series.createdAt,
    timezone: series.timezone,
  };
}

// The occurrence a series should default to showing/editing — the nearest
// one at/after today, falling back to the most recent past one on the
// (should-never-happen) chance none are upcoming.
export function pickRepresentativeOccurrence(
  occurrences: CarpoolOccurrence[],
  timezone?: string
): CarpoolOccurrence | undefined {
  const live = occurrences.filter((o) => !o.cancelled);
  const today = todayISO(timezone);
  const upcoming = live.filter((o) => o.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length > 0) return upcoming[0];
  return [...live].sort((a, b) => b.date.localeCompare(a.date))[0];
}

// Obscures every word after the first in a name (parent or kid) down to its
// initial, for privacy on user-facing screens — "Mary Jane Smith" becomes
// "Mary J. S.". A single-word name passes through unchanged.
export function shortenName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return [parts[0], ...parts.slice(1).map((p) => `${p[0]}.`)].join(" ");
}
