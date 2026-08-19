import { useState, type ReactNode } from "react";
import { joinCarpool, updateCarpoolSchedule } from "./api";
import { KidPicker } from "./KidPicker";
import { mapsLink } from "./maps";
import type { Car, Carpool, Member } from "./types";

function formatTime(time: string) {
  if (!time) return "no time set";
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function moveKid(cars: Car[], kid: string, driverId: string | null): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  return cleared.map((c) => (c.driverId === driverId ? { ...c, kids: [...c.kids, kid] } : c));
}

function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="bottom-sheet-header">
          <h3>{title}</h3>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="bottom-sheet-body">{children}</div>
        {footer && <div className="bottom-sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}

function LegToggleRow({
  label,
  time,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  time: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`leg-toggle-row ${checked ? "checked" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={checked}
    >
      <span className="leg-toggle-info">
        <strong>{label}</strong>
        <span className="muted">{formatTime(time)}</span>
      </span>
      <span className="leg-check-group">
        <span className="leg-check-label">I can drive</span>
        <span className="leg-check" aria-hidden="true">
          {checked && (
            <svg viewBox="0 0 16 16" width="11" height="11">
              <path
                d="M3 8.5L6.2 11.5L13 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </span>
    </button>
  );
}

function DrivingLeg({
  label,
  time,
  cars,
  members,
  memberId,
  eligibleFor,
  movingKid,
  onCarsChange,
}: {
  label: string;
  time: string;
  cars: Car[];
  members: Member[];
  memberId: string;
  eligibleFor: (m: Member) => boolean;
  movingKid: string | null;
  onCarsChange: (cars: Car[]) => void;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const myKids = new Set(members.find((m) => m.id === memberId)?.kids ?? []);

  // Not driving a leg doesn't mean your kid has no ride — it defaults to
  // riding with you, unless someone has explicitly moved them into another
  // active car for that leg.
  const assignedElsewhere = new Set(cars.flatMap((c) => c.kids));

  const rowData = members.map((m) => {
    const car = cars.find((c) => c.driverId === m.id);
    const kids = car ? car.kids : m.kids.filter((k) => !assignedElsewhere.has(k));
    const eligible = eligibleFor(m);
    // A member's seat count is already "free seats for other people's kids" —
    // their own kid(s) riding along don't eat into it.
    const others = kids.filter((k) => !m.kids.includes(k)).length;
    const free = eligible ? Math.max(m.seats - others, 0) : 0;
    const isSelf = m.id === memberId;
    const alreadyHere = movingKid !== null && kids.includes(movingKid);
    const canMoveHere = movingKid !== null && !alreadyHere && (isSelf || (eligible && free > 0));
    return { m, kids, eligible, free, isSelf, canMoveHere };
  });

  // You first, then cars with free seats, then everyone else.
  const rows = [...rowData].sort((a, b) => {
    const rank = (r: (typeof rowData)[number]) => (r.isSelf ? 0 : r.eligible && r.free > 0 ? 1 : 2);
    return rank(a) - rank(b);
  });

  return (
    <div className="mini-form">
      <div className="driving-leg-header">
        <h3 className="bliss-heading">{label}</h3>
        <span className="driving-leg-time muted">{formatTime(time)}</span>
      </div>
      <div className="driving-row-list">
        {rows.map(({ m, kids, eligible, free, isSelf, canMoveHere }) => {
          const expanded = canMoveHere && expandedRow === m.id;
          return (
            <div
              className={`driving-row ${canMoveHere ? "tappable" : ""}`}
              key={m.id}
              onClick={() => canMoveHere && setExpandedRow(expanded ? null : m.id)}
            >
              <div className="driving-row-top">
                <div className="driving-row-main">
                  <strong>{isSelf ? "You" : m.name}</strong>
                  <div className="driving-row-kids">
                    {kids.length === 0 && <span className="muted">Nobody</span>}
                    {kids
                      .filter((k) => myKids.has(k))
                      .map((k) => (
                        <span className="my-kid-pill" key={k}>
                          {k}
                        </span>
                      ))}
                    {kids.some((k) => !myKids.has(k)) && (
                      <span className="muted">{kids.filter((k) => !myKids.has(k)).join(", ")}</span>
                    )}
                  </div>
                </div>
                <span className={`seat-status ${eligible ? "" : "off"}`}>
                  {eligible ? `${free} free seat${free === 1 ? "" : "s"}` : "No free seats"}
                </span>
              </div>
              {expanded && (
                <button
                  type="button"
                  className="pill-button small move-here-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCarsChange(moveKid(cars, movingKid as string, m.id));
                  }}
                >
                  Move {movingKid} here
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CarpoolDetail({
  carpool,
  memberId,
  allKids,
  onBack,
  onCarpoolUpdated,
}: {
  carpool: Carpool;
  memberId: string;
  allKids: string[];
  onBack: () => void;
  onCarpoolUpdated: (carpool: Carpool) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editingKids, setEditingKids] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDropOff, setTogglingDropOff] = useState(false);
  const [togglingPickUp, setTogglingPickUp] = useState(false);
  const [movingKid, setMovingKid] = useState<string | null>(null);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [dialogKid, setDialogKid] = useState<string | null>(null);

  const self = carpool.members.find((m) => m.id === memberId);
  const [draftKids, setDraftKids] = useState<string[]>(self?.kids ?? []);
  const [draftName, setDraftName] = useState(carpool.name);

  const openKidsEditor = () => {
    setDraftKids(self?.kids ?? []);
    setDraftName(carpool.name);
    setEditingKids(true);
  };

  const copyLink = async () => {
    const link = `${window.location.origin}?join=${carpool.code}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // With only one kid there's no ambiguity to resolve, so skip the picker
  // dialog entirely and let the driving rows' move buttons act on them directly.
  const effectiveMovingKid = self?.kids.length === 1 ? self.kids[0] : movingKid;

  const saveKids = async () => {
    if (!self) return;
    setSaving(true);
    try {
      let updated = carpool;
      if (draftName.trim() && draftName !== carpool.name) {
        updated = await updateCarpoolSchedule(
          carpool.code,
          carpool.day,
          carpool.destination,
          carpool.dropOff,
          carpool.pickUp,
          draftName.trim()
        );
      }
      updated = await joinCarpool(carpool.code, { ...self, kids: draftKids });
      onCarpoolUpdated(updated);
      setEditingKids(false);
    } finally {
      setSaving(false);
    }
  };

  const toggleDropOff = async () => {
    if (!self) return;
    setTogglingDropOff(true);
    try {
      const updated = await joinCarpool(carpool.code, {
        ...self,
        canDriveDropOff: !self.canDriveDropOff,
      });
      onCarpoolUpdated(updated);
    } finally {
      setTogglingDropOff(false);
    }
  };

  const togglePickUp = async () => {
    if (!self) return;
    setTogglingPickUp(true);
    try {
      const updated = await joinCarpool(carpool.code, {
        ...self,
        canDrivePickUp: !self.canDrivePickUp,
      });
      onCarpoolUpdated(updated);
    } finally {
      setTogglingPickUp(false);
    }
  };

  const updateLegCars = async (leg: "dropOff" | "pickUp", cars: Car[]) => {
    const updated = await updateCarpoolSchedule(
      carpool.code,
      carpool.day,
      carpool.destination,
      leg === "dropOff" ? { time: carpool.dropOff?.time ?? "", cars } : carpool.dropOff,
      leg === "pickUp" ? { time: carpool.pickUp?.time ?? "", cars } : carpool.pickUp
    );
    onCarpoolUpdated(updated);
    setMovingKid(null);
  };

  return (
    <div className="carpool-detail">
      <button className="back-link" onClick={onBack}>
        &larr; All carpools
      </button>
      <div className="carpool-name-row">
        <h2>{carpool.name}</h2>
        {self && (
          <button type="button" className="text-link" onClick={openKidsEditor}>
            edit
          </button>
        )}
      </div>
      {self && allKids.length > 0 && (
        <p className="muted carpool-kids-line">
          {(self.kids ?? []).length > 0 ? self.kids.join(", ") : "No kids assigned yet"}
        </p>
      )}

      <div className="schedule-summary">
        <div className="schedule-summary-heading">
          <p className="bliss-heading">{carpool.day ?? "No day set"}</p>
          {carpool.destination?.street && (
            <p className="muted">
              <a
                className="address-link"
                href={mapsLink(carpool.destination.street, carpool.destination.zip)}
                target="_blank"
                rel="noreferrer"
              >
                {carpool.destination.street}
                {carpool.destination.zip ? `, ${carpool.destination.zip}` : ""}
              </a>
            </p>
          )}
        </div>
        <div className="schedule-legs">
          <LegToggleRow
            label="Drop-off"
            time={carpool.dropOff?.time ?? ""}
            checked={self?.canDriveDropOff ?? false}
            disabled={!self || togglingDropOff}
            onToggle={toggleDropOff}
          />
          <LegToggleRow
            label="Pick-up"
            time={carpool.pickUp?.time ?? ""}
            checked={self?.canDrivePickUp ?? false}
            disabled={!self || togglingPickUp}
            onToggle={togglePickUp}
          />
        </div>
      </div>

      <h3 className="bliss-heading">Who's driving who?</h3>
      {self && self.kids.length > 1 && (
        <div className="move-kid-control">
          <div className="move-kid-trigger">
            <button
              type="button"
              className="pill-button small secondary"
              onClick={() => {
                setDialogKid(movingKid);
                setShowMoveDialog((v) => !v);
              }}
            >
              {movingKid ? `Moving ${movingKid}` : "Move a kid"}
            </button>
            {movingKid && (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setMovingKid(null);
                  setShowMoveDialog(false);
                }}
              >
                cancel
              </button>
            )}
          </div>
          {showMoveDialog && (
            <div className="move-kid-dialog pop-in">
              <span className="gate-field-label">Which kid?</span>
              <div className="kid-tags">
                {self.kids.map((kid) => (
                  <button
                    type="button"
                    key={kid}
                    className={`kid-pick ${dialogKid === kid ? "active" : ""}`}
                    onClick={() => setDialogKid(dialogKid === kid ? null : kid)}
                  >
                    {kid}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="pill-button small"
                disabled={!dialogKid}
                onClick={() => {
                  setMovingKid(dialogKid);
                  setShowMoveDialog(false);
                }}
              >
                Move
              </button>
            </div>
          )}
        </div>
      )}
      <DrivingLeg
        key={`dropOff-${effectiveMovingKid ?? "none"}`}
        label="Drop-off"
        time={carpool.dropOff?.time ?? ""}
        cars={carpool.dropOff?.cars ?? []}
        members={carpool.members}
        memberId={memberId}
        eligibleFor={(m) => m.canDriveDropOff}
        movingKid={effectiveMovingKid}
        onCarsChange={(cars) => updateLegCars("dropOff", cars)}
      />
      <DrivingLeg
        key={`pickUp-${effectiveMovingKid ?? "none"}`}
        label="Pick-up"
        time={carpool.pickUp?.time ?? ""}
        cars={carpool.pickUp?.cars ?? []}
        members={carpool.members}
        memberId={memberId}
        eligibleFor={(m) => m.canDrivePickUp}
        movingKid={effectiveMovingKid}
        onCarsChange={(cars) => updateLegCars("pickUp", cars)}
      />

      <div className="invite-box">
        <span className="invite-label">Invite code</span>
        <span className="invite-code">{carpool.code}</span>
        <button type="button" className="pill-button secondary" onClick={copyLink}>
          {copied ? "Copied!" : "Copy invite link"}
        </button>
      </div>

      <BottomSheet
        open={editingKids}
        onClose={() => setEditingKids(false)}
        title="Edit carpool"
        footer={
          <button type="button" className="pill-button" onClick={saveKids} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Carpool name</span>
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </div>
        <KidPicker
          allKids={allKids}
          selected={draftKids}
          onChange={setDraftKids}
          label="Which of your kids is in this carpool?"
        />
      </BottomSheet>
    </div>
  );
}
