import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { createTrip } from "./useTrips";
import type { Profile } from "./types";

export function NewTripForm({ profile }: { profile: Profile }) {
  const { user } = useAuth();
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  const [seatsTotal, setSeatsTotal] = useState(profile.seats || 1);
  const [submitting, setSubmitting] = useState(false);

  if (!user) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!origin || !destination || !departureTime) return;
    setSubmitting(true);
    try {
      await createTrip({
        origin,
        destination,
        departureTime: new Date(departureTime).toISOString(),
        seatsTotal,
        driverId: user.uid,
        driverName: profile.name,
      });
      setOrigin("");
      setDestination("");
      setDepartureTime("");
      setSeatsTotal(profile.seats || 1);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="new-trip-form" onSubmit={handleSubmit}>
      <h2>Offer a ride</h2>
      <div className="field-row">
        <input
          placeholder="From"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          required
        />
        <input
          placeholder="To"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          required
        />
      </div>
      <div className="field-row">
        <input
          type="datetime-local"
          value={departureTime}
          onChange={(e) => setDepartureTime(e.target.value)}
          required
        />
        <input
          type="number"
          min={1}
          max={8}
          value={seatsTotal}
          onChange={(e) => setSeatsTotal(Number(e.target.value))}
          title="Seats available"
        />
      </div>
      <button type="submit" disabled={submitting}>
        {submitting ? "Posting..." : "Post trip"}
      </button>
    </form>
  );
}
