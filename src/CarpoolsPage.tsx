import { useEffect, useRef, useState, type FormEvent } from "react";
import { createCarpool, joinCarpool, listCarpools } from "./api";
import { DAYS_OF_WEEK, type Carpool, type DayOfWeek } from "./types";
import type { LocalProfile } from "./useProfile";

type Group = { key: string; label: string; kid: string; carpools: Carpool[] };

function selfKidsIn(carpool: Carpool, memberId: string): string[] {
  return carpool.members.find((m) => m.id === memberId)?.kids ?? [];
}

// One section per kid on the profile, always present (even with zero
// carpools yet) — a carpool with multiple kids shows up under each of them.
function buildSections(carpools: Carpool[], memberId: string, allKids: string[]): Group[] {
  return allKids.map((kid) => ({
    key: kid,
    label: `${kid}'s Carpools`,
    kid,
    carpools: carpools.filter((c) => selfKidsIn(c, memberId).includes(kid)),
  }));
}

export function CarpoolsPage({
  memberId,
  profile,
  onOpenCarpool,
}: {
  memberId: string;
  profile: LocalProfile;
  onOpenCarpool: (carpool: Carpool) => void;
}) {
  const [carpools, setCarpools] = useState<Carpool[]>([]);
  const [loading, setLoading] = useState(true);
  const cameViaInviteLink = useRef(
    /^\d{6}$/.test(new URLSearchParams(window.location.search).get("join") ?? "")
  ).current;

  // At most one section's join/create form is open at a time, identified by
  // that section's kid plus which action was clicked.
  const [openForm, setOpenForm] = useState<{ kid: string; type: "join" | "create" } | null>(
    cameViaInviteLink && profile.kids[0] ? { kid: profile.kids[0], type: "join" } : null
  );
  const [newName, setNewName] = useState("");
  const [day, setDay] = useState<DayOfWeek>("Monday");
  const [destStreet, setDestStreet] = useState("");
  const [destZip, setDestZip] = useState("");
  const [dropOffTime, setDropOffTime] = useState("");
  const [pickUpTime, setPickUpTime] = useState("");
  const [joinCode, setJoinCode] = useState(
    () => new URLSearchParams(window.location.search).get("join") ?? ""
  );
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const joinInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openForm?.type === "create") createInputRef.current?.focus();
    if (openForm?.type === "join" && !cameViaInviteLink) joinInputRef.current?.focus();
  }, [openForm, cameViaInviteLink]);

  useEffect(() => {
    listCarpools(memberId)
      .then(setCarpools)
      .finally(() => setLoading(false));
  }, [memberId]);

  const openSectionForm = (kid: string, type: "join" | "create") => {
    setError(null);
    setNewName("");
    setJoinCode("");
    setDay("Monday");
    setDestStreet("");
    setDestZip("");
    setDropOffTime("");
    setPickUpTime("");
    setOpenForm({ kid, type });
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!openForm) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const member = {
        id: memberId,
        name: profile.name,
        seats: profile.seats,
        kids: [openForm.kid],
        isDriving: true,
        street: profile.street,
        zip: profile.zip,
      };
      const destination = { street: destStreet, zip: destZip };
      const dropOff = { time: dropOffTime, driverId: dropOffTime ? memberId : null };
      const pickUp = { time: pickUpTime, driverId: pickUpTime ? memberId : null };
      onOpenCarpool(await createCarpool(trimmed, day, destination, dropOff, pickUp, member));
      setOpenForm(null);
    } catch {
      setError("Couldn't create that carpool. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    if (!openForm) return;
    const code = joinCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError("Codes are 6 digits.");
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const member = {
        id: memberId,
        name: profile.name,
        seats: profile.seats,
        kids: [openForm.kid],
        isDriving: false,
        street: profile.street,
        zip: profile.zip,
      };
      onOpenCarpool(await joinCarpool(code, member));
      setOpenForm(null);
    } catch {
      setError("No carpool found with that code.");
    } finally {
      setJoining(false);
    }
  };

  const groups = buildSections(carpools, memberId, profile.kids);

  return (
    <div className="carpools-page">
      {loading && <p className="muted">Loading...</p>}

      {!loading &&
        groups.map((group) => (
          <section className="carpools-list" key={group.key}>
            <h2>{group.label}</h2>
            {group.carpools.length === 0 && (
              <p className="muted">No carpools for {group.kid} yet.</p>
            )}
            {group.carpools.map((c) => (
              <button key={c.code} className="carpool-row" onClick={() => onOpenCarpool(c)}>
                <span className="carpool-row-name">{c.name}</span>
                <span className="carpool-row-meta">
                  {c.members.length} member{c.members.length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
            <div className="section-actions">
              <button
                type="button"
                className="pill-button secondary small"
                onClick={() => openSectionForm(group.kid, "join")}
              >
                Join a carpool
              </button>
              <button
                type="button"
                className="pill-button secondary small"
                onClick={() => openSectionForm(group.kid, "create")}
              >
                Start a carpool
              </button>
            </div>
            {error && openForm?.kid === group.kid && <p className="form-error">{error}</p>}

            {openForm?.kid === group.kid && openForm.type === "join" && (
              <form className="mini-form primary pop-in" onSubmit={handleJoin}>
                <div className="mini-form-header">
                  <h3>Join with a code for {group.kid}</h3>
                  <button
                    type="button"
                    className="close-x"
                    onClick={() => setOpenForm(null)}
                    aria-label="Close"
                  >
                    &times;
                  </button>
                </div>
                <input
                  ref={joinInputRef}
                  placeholder="6-digit code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  required
                />
                <button type="submit" className="pill-button" disabled={joining}>
                  {joining ? "Joining..." : "Join"}
                </button>
              </form>
            )}

            {openForm?.kid === group.kid && openForm.type === "create" && (
              <form className="mini-form pop-in" onSubmit={handleCreate}>
                <div className="mini-form-header">
                  <h3>Start a carpool for {group.kid}</h3>
                  <button
                    type="button"
                    className="close-x"
                    onClick={() => setOpenForm(null)}
                    aria-label="Close"
                  >
                    &times;
                  </button>
                </div>
                <input
                  ref={createInputRef}
                  placeholder="e.g. Lincoln Elementary mornings"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
                <div className="form-field">
                  <span className="gate-field-label">Day</span>
                  <select value={day} onChange={(e) => setDay(e.target.value as DayOfWeek)}>
                    {DAYS_OF_WEEK.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="form-field street-field">
                    <span className="gate-field-label">Destination street</span>
                    <input value={destStreet} onChange={(e) => setDestStreet(e.target.value)} />
                  </div>
                  <div className="form-field zip-field">
                    <span className="gate-field-label">Zip code</span>
                    <input
                      value={destZip}
                      onChange={(e) => setDestZip(e.target.value)}
                      inputMode="numeric"
                    />
                  </div>
                </div>
                <div className="field-row">
                  <div className="form-field">
                    <span className="gate-field-label">Drop-off time</span>
                    <input
                      type="time"
                      value={dropOffTime}
                      onChange={(e) => setDropOffTime(e.target.value)}
                    />
                  </div>
                  <div className="form-field">
                    <span className="gate-field-label">Pick-up time</span>
                    <input
                      type="time"
                      value={pickUpTime}
                      onChange={(e) => setPickUpTime(e.target.value)}
                    />
                  </div>
                </div>
                <button type="submit" className="pill-button" disabled={creating}>
                  {creating ? "Creating..." : "Create"}
                </button>
              </form>
            )}
          </section>
        ))}
    </div>
  );
}
