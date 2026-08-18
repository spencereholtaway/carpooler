import { AuthProvider, useAuth } from "./AuthContext";
import { useTrips } from "./useTrips";
import { NewTripForm } from "./NewTripForm";
import { TripCard } from "./TripCard";
import "./index.css";

function Header() {
  const { user, login, logout, loading } = useAuth();

  return (
    <header className="app-header">
      <h1>Carpooler</h1>
      {!loading && (
        <div className="auth-controls">
          {user ? (
            <>
              <span>{user.displayName}</span>
              <button onClick={logout}>Sign out</button>
            </>
          ) : (
            <button onClick={login}>Sign in with Google</button>
          )}
        </div>
      )}
    </header>
  );
}

function TripsPage() {
  const { user, loading: authLoading } = useAuth();
  const { trips, loading: tripsLoading } = useTrips();

  if (authLoading) return null;

  if (!user) {
    return (
      <main className="signed-out">
        <p>Sign in with Google to see and post carpool trips.</p>
      </main>
    );
  }

  return (
    <main>
      <NewTripForm />
      <section className="trip-list">
        <h2>Upcoming trips</h2>
        {tripsLoading && <p>Loading trips...</p>}
        {!tripsLoading && trips.length === 0 && <p>No trips posted yet.</p>}
        {trips.map((trip) => (
          <TripCard key={trip.id} trip={trip} />
        ))}
      </section>
    </main>
  );
}

function App() {
  return (
    <AuthProvider>
      <Header />
      <TripsPage />
    </AuthProvider>
  );
}

export default App;
