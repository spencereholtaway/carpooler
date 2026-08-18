export type Member = {
  id: string;
  name: string;
  seats: number;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
  street: string;
  zip: string;
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
};
