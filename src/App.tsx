import { useState } from "react";
import "./index.css";
import { useBackable } from "./useBackable";
import { useProfile } from "./useProfile";
import { ProfileGate } from "./ProfileGate";
import { ProfileEditor } from "./ProfileEditor";
import { CarpoolsPage } from "./CarpoolsPage";
import { CarpoolDetail } from "./CarpoolDetail";
import { AdminPage } from "./AdminPage";
import type { Carpool } from "./types";

// Apple's set draws these nose-left, except the race car which is nose-right;
// flip that one so every car visually faces the direction it's driving.
const CARS: { emoji: string; facing: "left" | "right" }[] = [
  { emoji: "🚗", facing: "left" },
  { emoji: "🚙", facing: "left" },
  { emoji: "🚕", facing: "left" },
  { emoji: "🚓", facing: "left" },
  { emoji: "🏎️", facing: "right" },
];

function FlyingCars() {
  return (
    <div className="flying-cars" aria-hidden="true">
      {Array.from({ length: 10 }).map((_, i) => {
        const car = CARS[i % CARS.length];
        const top = Math.random() * 100;
        const duration = 18 + Math.random() * 14;
        const delay = Math.random() * -30;
        const size = 18 + Math.random() * 20;
        return (
          <span
            key={i}
            className="flying-car"
            style={{
              top: `${top}vh`,
              fontSize: `clamp(${size * 0.6}px, ${size / 10}vw, ${size}px)`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
            }}
          >
            <span className={car.facing === "right" ? "flip" : ""}>{car.emoji}</span>
          </span>
        );
      })}
    </div>
  );
}

function AmbientOrbs() {
  return (
    <div className="ambient-orbs" aria-hidden="true">
      <span className="orb orb-a" />
      <span className="orb orb-b" />
      <span className="orb orb-c" />
    </div>
  );
}

function App() {
  const { profile, memberId, loading, saveProfile, clearProfile, adoptMemberId } = useProfile();
  const [selectedCarpool, setSelectedCarpool] = useState<Carpool | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [carpools, setCarpools] = useState<Carpool[] | null>(null);

  // Tie the two top-level screens/overlays to browser history so the back
  // button and iOS/Android edge-swipe close them instead of leaving the app.
  const closeCarpool = useBackable(Boolean(selectedCarpool), () => setSelectedCarpool(null));
  const closeProfileEditor = useBackable(editingProfile, () => setEditingProfile(false));

  // Keep the already-fresh result of a create/join/edit around locally instead
  // of re-fetching the whole list on every back-navigation — that refetch is
  // what made the list feel slow, and re-reading data we just wrote risked
  // showing a stale pre-edit version if the read landed before it propagated.
  const upsertCarpool = (updated: Carpool) => {
    setSelectedCarpool(updated);
    setCarpools((prev) => {
      if (!prev) return prev;
      const exists = prev.some((c) => c.code === updated.code);
      return exists ? prev.map((c) => (c.code === updated.code ? updated : c)) : [...prev, updated];
    });
  };

  // Same cache refresh as upsertCarpool, but never navigates — used when a
  // profile edit re-syncs every carpool the member is in, which may include
  // carpools other than (or none of) whichever one is currently open.
  const refreshCarpool = (updated: Carpool) => {
    setSelectedCarpool((prev) => (prev && prev.code === updated.code ? updated : prev));
    setCarpools((prev) => {
      if (!prev) return prev;
      const exists = prev.some((c) => c.code === updated.code);
      return exists ? prev.map((c) => (c.code === updated.code ? updated : c)) : [...prev, updated];
    });
  };

  // Drop a carpool from the cached list once we've left (or it's been
  // deleted because we were the last member) — nothing to upsert back in.
  const removeCarpool = (code: string) => {
    setCarpools((prev) => (prev ? prev.filter((c) => c.code !== code) : prev));
  };

  if (window.location.pathname === "/admin") {
    return <AdminPage />;
  }

  if (loading) return null;

  if (!profile || !memberId) {
    return (
      <div className="hero-page">
        <AmbientOrbs />
        <FlyingCars />
        <div className="hero-content">
          <h1 className="hero-title">blisspool</h1>
          {memberId && (
            <ProfileGate
              memberId={memberId}
              onSubmit={saveProfile}
              onRecoverMemberId={adoptMemberId}
            />
          )}
        </div>
      </div>
    );
  }

  const wide = Boolean(selectedCarpool);

  return (
    <div className="app-shell">
      <AmbientOrbs />
      <div className="app-shell-topper">
        <div className="app-shell-topper-inner app-shell-topper-inner-wide">
          <button
            type="button"
            className="app-shell-title"
            onClick={() => {
              closeProfileEditor();
              closeCarpool();
            }}
          >
            blisspool
          </button>
          <div className="app-shell-user">
            <span>
              Hi,{" "}
              <button className="text-link" onClick={() => setEditingProfile(true)}>
                {profile.name.split(" ")[0]}
              </button>
            </span>
            <button
              className="text-link"
              onClick={() => {
                closeCarpool();
                clearProfile();
              }}
            >
              not you?
            </button>
          </div>
        </div>
      </div>
      <main className={`app-shell-main ${wide ? "app-shell-main-wide" : ""}`}>
        {selectedCarpool ? (
          <CarpoolDetail
            carpool={selectedCarpool}
            memberId={memberId}
            allKids={profile.kids}
            onBack={closeCarpool}
            onCarpoolUpdated={upsertCarpool}
            onCarpoolLeft={removeCarpool}
          />
        ) : (
          <CarpoolsPage
            memberId={memberId}
            profile={profile}
            onOpenCarpool={upsertCarpool}
            carpools={carpools}
            setCarpools={setCarpools}
          />
        )}
      </main>
      {editingProfile && (
        <ProfileEditor
          memberId={memberId}
          profile={profile}
          onSaved={saveProfile}
          onCarpoolUpdated={refreshCarpool}
          onClose={closeProfileEditor}
        />
      )}
    </div>
  );
}

export default App;
