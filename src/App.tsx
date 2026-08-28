import { useState } from "react";
import "./index.css";
import { useBackable } from "./useBackable";
import { useProfile } from "./useProfile";
import { ProfileGate } from "./ProfileGate";
import { ProfileEditor } from "./ProfileEditor";
import { CarpoolsPage } from "./CarpoolsPage";
import { CarpoolDetail } from "./CarpoolDetail";
import { AdminPage } from "./AdminPage";
import { FeedbackBanner, useFeedbackBannerVisible } from "./FeedbackBanner";
import type { CarpoolOccurrence, CarpoolSeries } from "./types";
import type { CarpoolResult } from "./api";

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
  const { visible: feedbackBannerVisible, dismiss: dismissFeedbackBanner } = useFeedbackBannerVisible();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [carpools, setCarpools] = useState<CarpoolSeries[] | null>(null);
  const [occurrences, setOccurrences] = useState<CarpoolOccurrence[] | null>(null);

  // Tie the two top-level screens/overlays to browser history so the back
  // button and iOS/Android edge-swipe close them instead of leaving the app.
  const closeCarpool = useBackable(Boolean(selectedCode), () => {
    setSelectedCode(null);
    setSelectedDate(null);
  });
  const closeProfileEditor = useBackable(editingProfile, () => setEditingProfile(false));

  // Replaces every occurrence belonging to `code` with `fresh` — every
  // mutation endpoint returns the *complete* current occurrence list for the
  // series it touched, so this is a full replace, not a per-date merge.
  const mergeOccurrences = (code: string, fresh: CarpoolOccurrence[]) => {
    setOccurrences((prev) => [...(prev ?? []).filter((o) => o.code !== code), ...fresh]);
  };

  // Keep the already-fresh result of a create/join/edit around locally instead
  // of re-fetching the whole list on every back-navigation — that refetch is
  // what made the list feel slow, and re-reading data we just wrote risked
  // showing a stale pre-edit version if the read landed before it propagated.
  const upsertCarpool = ({ carpool, occurrences: fresh }: CarpoolResult) => {
    setSelectedCode(carpool.code);
    setCarpools((prev) => {
      if (!prev) return [carpool];
      const exists = prev.some((c) => c.code === carpool.code);
      return exists ? prev.map((c) => (c.code === carpool.code ? carpool : c)) : [...prev, carpool];
    });
    mergeOccurrences(carpool.code, fresh);
  };

  // Same as upsertCarpool, but also remembers which specific occurrence date
  // was tapped in the list, so the detail view opens on that date instead of
  // always falling back to the nearest upcoming one.
  const openCarpool = (result: CarpoolResult, date?: string) => {
    upsertCarpool(result);
    setSelectedDate(date ?? null);
  };

  // Same cache refresh as upsertCarpool, but never navigates — used when a
  // profile edit re-syncs every carpool the member is in, which may include
  // carpools other than (or none of) whichever one is currently open.
  const refreshCarpool = ({ carpool, occurrences: fresh }: CarpoolResult) => {
    setCarpools((prev) => {
      if (!prev) return prev;
      const exists = prev.some((c) => c.code === carpool.code);
      return exists ? prev.map((c) => (c.code === carpool.code ? carpool : c)) : [...prev, carpool];
    });
    mergeOccurrences(carpool.code, fresh);
  };

  // A single occurrence changed ("just this one" edit scope) — merge that
  // one date back into the cache without touching any other occurrence.
  const updateOneOccurrence = (occurrence: CarpoolOccurrence) => {
    setOccurrences((prev) =>
      (prev ?? []).map((o) => (o.code === occurrence.code && o.date === occurrence.date ? occurrence : o))
    );
  };

  // Drop a carpool from the cached list once we've left (or it's been
  // deleted because we were the last member) — nothing to upsert back in.
  const removeCarpool = (code: string) => {
    setCarpools((prev) => (prev ? prev.filter((c) => c.code !== code) : prev));
    setOccurrences((prev) => (prev ? prev.filter((o) => o.code !== code) : prev));
    setSelectedCode((prev) => (prev === code ? null : prev));
  };

  const selectedCarpool = carpools?.find((c) => c.code === selectedCode) ?? null;
  const selectedOccurrences = (occurrences ?? []).filter((o) => o.code === selectedCode);

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
      {feedbackBannerVisible && <FeedbackBanner onDismiss={dismissFeedbackBanner} />}
      <div className={`app-shell-topper ${feedbackBannerVisible ? "app-shell-topper-with-banner" : ""}`}>
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
      <main
        className={`app-shell-main ${wide ? "app-shell-main-wide" : ""} ${
          feedbackBannerVisible ? "app-shell-main-with-banner" : ""
        }`}
      >
        {selectedCarpool ? (
          <CarpoolDetail
            series={selectedCarpool}
            occurrences={selectedOccurrences}
            initialDate={selectedDate}
            memberId={memberId}
            allKids={profile.kids}
            onBack={closeCarpool}
            onCarpoolUpdated={upsertCarpool}
            onOccurrenceUpdated={updateOneOccurrence}
            onCarpoolLeft={removeCarpool}
          />
        ) : (
          <CarpoolsPage
            memberId={memberId}
            profile={profile}
            onOpenCarpool={openCarpool}
            carpools={carpools}
            occurrences={occurrences}
            onCarpoolsLoaded={(result) => {
              setCarpools(result.carpools);
              setOccurrences(result.occurrences);
            }}
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
