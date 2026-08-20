export type Member = {
  id: string;
  name: string;
  seats: number;
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
