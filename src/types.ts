export type Rider = {
  uid: string;
  name: string;
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
