import { useAuth } from "./AuthContext";
import { deleteTrip, joinTrip, leaveTrip } from "./useTrips";
import type { Profile, Trip } from "./types";

export function TripCard({ trip, profile }: { trip: Trip; profile: Profile }) {
  const { user } = useAuth();
  if (!user) return null;

  const isDriver = trip.driverId === user.uid;
  const isRider = trip.riders.some((r) => r.uid === user.uid);
  const seatsLeft = trip.seatsTotal - trip.riders.length;
  const full = seatsLeft <= 0;

  const rider = { uid: user.uid, name: profile.name };

  return (
    <article className="trip-card">
      <header>
        <h3>
          {trip.origin} &rarr; {trip.destination}
        </h3>
        <span className="when">
          {new Date(trip.departureTime).toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </header>
      <p className="driver">Driver: {trip.driverName}</p>
      <p className="seats">
        {seatsLeft > 0 ? `${seatsLeft} seat(s) left` : "Full"} (
        {trip.riders.length}/{trip.seatsTotal})
      </p>
      {trip.riders.length > 0 && (
        <ul className="riders">
          {trip.riders.map((r) => (
            <li key={r.uid}>{r.name}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        {isDriver && (
          <button className="danger" onClick={() => deleteTrip(trip.id)}>
            Cancel trip
          </button>
        )}
        {!isDriver && !isRider && (
          <button disabled={full} onClick={() => joinTrip(trip.id, rider)}>
            {full ? "Full" : "Join"}
          </button>
        )}
        {!isDriver && isRider && (
          <button className="secondary" onClick={() => leaveTrip(trip.id, rider)}>
            Leave
          </button>
        )}
      </div>
    </article>
  );
}
