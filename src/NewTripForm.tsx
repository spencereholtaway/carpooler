import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { createTrip } from "./useTrips";

export function NewTripForm() {
  const { user } = useAuth();
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  const [seatsTotal, setSeatsTotal] = useState(3);
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
        driverName: user.displayName ?? "Driver",
      });
      setOrigin("");
      setDestination("");
      setDepartureTime("");
      setSeatsTotal(3);
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
