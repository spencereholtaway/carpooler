import { useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import { useProfile } from "./useProfile";
import { useTrips } from "./useTrips";
import { NewTripForm } from "./NewTripForm";
import { TripCard } from "./TripCard";
import { ProfileForm } from "./ProfileForm";
import "./index.css";

function Header({
  name,
  onEditProfile,
}: {
  name?: string;
  onEditProfile?: () => void;
}) {
  return (
    <header className="app-header">
      <h1>Carpooler</h1>
      {name && (
        <div className="auth-controls">
          <span>{name}</span>
          <button className="secondary" onClick={onEditProfile}>
            Edit profile
          </button>
        </div>
      )}
    </header>
  );
}

function TripsPage() {
  const { user, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading } = useProfile(user?.uid);
  const { trips, loading: tripsLoading } = useTrips();
  const [editingProfile, setEditingProfile] = useState(false);

  if (authLoading || (user && profileLoading)) return null;

  if (!user) return null;

  if (!profile || editingProfile) {
    return (
      <>
        <Header name={profile?.name} />
        <main>
          <ProfileForm
            uid={user.uid}
            existing={profile}
            onSaved={() => setEditingProfile(false)}
          />
        </main>
      </>
    );
  }

  return (
    <>
      <Header name={profile.name} onEditProfile={() => setEditingProfile(true)} />
      <main>
        <NewTripForm profile={profile} />
        <section className="trip-list">
          <h2>Upcoming trips</h2>
          {tripsLoading && <p>Loading trips...</p>}
          {!tripsLoading && trips.length === 0 && <p>No trips posted yet.</p>}
          {trips.map((trip) => (
            <TripCard key={trip.id} trip={trip} profile={profile} />
          ))}
        </section>
      </main>
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <TripsPage />
    </AuthProvider>
  );
}

export default App;
