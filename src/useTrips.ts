import { useEffect, useState } from "react";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import type { Rider, Trip } from "./types";

const tripsCol = collection(db, "trips");

export function useTrips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(tripsCol, orderBy("departureTime", "asc"));
    return onSnapshot(q, (snap) => {
      setTrips(
        snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Trip)
      );
      setLoading(false);
    });
  }, []);

  return { trips, loading };
}

export async function createTrip(input: {
  destination: string;
  origin: string;
  departureTime: string;
  seatsTotal: number;
  driverId: string;
  driverName: string;
}) {
  await addDoc(tripsCol, {
    ...input,
    riders: [] as Rider[],
    createdAt: Date.now(),
  });
}

export async function joinTrip(tripId: string, rider: Rider) {
  await updateDoc(doc(db, "trips", tripId), {
    riders: arrayUnion(rider),
  });
}

export async function leaveTrip(tripId: string, rider: Rider) {
  await updateDoc(doc(db, "trips", tripId), {
    riders: arrayRemove(rider),
  });
}

export async function deleteTrip(tripId: string) {
  await deleteDoc(doc(db, "trips", tripId));
}
