export type Rider = {
  uid: string;
  name: string;
};

export type Profile = {
  name: string;
  seats: number; // seats they can offer when driving
  kids: string; // free-text, e.g. "Ava, Sam"
};

export type Trip = {
  id: string;
  destination: string;
  origin: string;
  departureTime: string; // ISO string, entered by the driver
  seatsTotal: number;
  driverId: string;
  driverName: string;
  riders: Rider[];
  createdAt: number;
};
