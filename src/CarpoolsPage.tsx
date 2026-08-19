import { useEffect, useRef, useState } from "react";
import { createCarpool, joinCarpool, listCarpools } from "./api";
import { BottomSheet } from "./BottomSheet";
import { KidPicker } from "./KidPicker";
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

  const [openDialog, setOpenDialog] = useState<"join" | "create" | null>(
    cameViaInviteLink ? "join" : null
  );
  // Which of the parent's kids the join/create dialog currently has selected
  // — not tied to any one section, so either flow can cover any combination.
  const [selectedKids, setSelectedKids] = useState<string[]>(profile.kids);
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
  const joinInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openDialog === "join" && !cameViaInviteLink) joinInputRef.current?.focus();
  }, [openDialog, cameViaInviteLink]);

  useEffect(() => {
    listCarpools(memberId)
      .then(setCarpools)
      .finally(() => setLoading(false));
  }, [memberId]);

  const openJoin = () => {
    setError(null);
    setJoinCode("");
    setSelectedKids(profile.kids);
    setOpenDialog("join");
  };

  const openCreate = () => {
    setError(null);
    setNewName("");
    setDay("Monday");
    setDestStreet("");
    setDestZip("");
    setDropOffTime("");
    setPickUpTime("");
    setSelectedKids(profile.kids);
    setOpenDialog("create");
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || selectedKids.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const member = {
        id: memberId,
        name: profile.name,
        seats: profile.seats,
        kids: selectedKids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      };
      const destination = { street: destStreet, zip: destZip };
      const dropOff = { time: dropOffTime, cars: [] };
      const pickUp = { time: pickUpTime, cars: [] };
      onOpenCarpool(await createCarpool(trimmed, day, destination, dropOff, pickUp, member));
      setOpenDialog(null);
    } catch {
      setError("Couldn't create that carpool. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const code = joinCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError("Codes are 6 digits.");
      return;
    }
    if (selectedKids.length === 0) {
      setError("Pick at least one kid.");
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const member = {
        id: memberId,
        name: profile.name,
        seats: profile.seats,
        kids: selectedKids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      };
      onOpenCarpool(await joinCarpool(code, member));
      setOpenDialog(null);
    } catch {
      setError("No carpool found with that code.");
    } finally {
      setJoining(false);
    }
  };

  const groups = buildSections(carpools, memberId, profile.kids);

  return (
    <div className="carpools-page">
      <div className="section-actions">
        <button type="button" className="pill-button secondary small" onClick={openJoin}>
          Join a carpool
        </button>
        <button type="button" className="pill-button secondary small" onClick={openCreate}>
          Start a carpool
        </button>
      </div>

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
          </section>
        ))}

      <BottomSheet
        open={openDialog === "join"}
        onClose={() => setOpenDialog(null)}
        title="Join a carpool"
        footer={
          <button type="button" className="pill-button" onClick={handleJoin} disabled={joining}>
            {joining ? "Joining..." : "Join"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Invite code</span>
          <input
            ref={joinInputRef}
            placeholder="6-digit code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
          />
        </div>
        <KidPicker
          allKids={profile.kids}
          selected={selectedKids}
          onChange={setSelectedKids}
          label="Which of your kids are joining this carpool?"
        />
        {error && <p className="form-error">{error}</p>}
      </BottomSheet>

      <BottomSheet
        open={openDialog === "create"}
        onClose={() => setOpenDialog(null)}
        title="Start a carpool"
        footer={
          <button
            type="button"
            className="pill-button"
            onClick={handleCreate}
            disabled={creating || !newName.trim() || selectedKids.length === 0}
          >
            {creating ? "Creating..." : "Create carpool"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Carpool name</span>
          <input
            placeholder="e.g. Lincoln Elementary mornings"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
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
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={destStreet} onChange={(e) => setDestStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={destZip} onChange={(e) => setDestZip(e.target.value)} inputMode="numeric" />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Drop-off time</span>
          <input
            type="time"
            value={dropOffTime}
            onChange={(e) => setDropOffTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Pick-up time</span>
          <input
            type="time"
            value={pickUpTime}
            onChange={(e) => setPickUpTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
        </div>
        <KidPicker
          allKids={profile.kids}
          selected={selectedKids}
          onChange={setSelectedKids}
          label="Which of your kids are in this carpool?"
        />
        {error && <p className="form-error">{error}</p>}
      </BottomSheet>
    </div>
  );
}
