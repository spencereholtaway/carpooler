import { useEffect, useState } from "react";
import { getHousehold, joinCarpool, updateCarpoolSchedule } from "./api";
import { BottomSheet } from "./BottomSheet";
import { computeKidDefaults, formatTime, joinList, summarizeCarpool } from "./carpoolSummary";
import { KidPicker } from "./KidPicker";
import { mapsLink } from "./maps";
import { DAYS_OF_WEEK, type Car, type Carpool, type DayOfWeek, type Member } from "./types";
import { useTypewriter } from "./useTypewriter";

function moveKid(cars: Car[], kid: string, driverId: string | null): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  // A member who isn't marked as driving this leg has no car entry at all —
  // moving a kid to them (e.g. their own kid, regardless of that toggle)
  // needs to create one rather than silently no-op.
  if (!cleared.some((c) => c.driverId === driverId)) {
    return [...cleared, { driverId, kids: [kid] }];
  }
  return cleared.map((c) => (c.driverId === driverId ? { ...c, kids: [...c.kids, kid] } : c));
}

// A kid only needs offering, not auto-moving: they're already claimed by
// someone else's explicit car for this leg, so joining as a driver doesn't
// pull them along automatically (see syncCar server-side) — this surfaces
// that gap so the parent can choose instead of it happening silently.
function kidsToOfferMove(cars: Car[], selfId: string, selfKids: string[]): string[] {
  return selfKids.filter((k) => {
    const car = cars.find((c) => c.kids.includes(k));
    return car !== undefined && car.driverId !== selfId;
  });
}

function AiMovePrompt({
  kids,
  legLabel,
  onConfirm,
  onDismiss,
  busy,
}: {
  kids: string[];
  legLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div className="ai-prompt pop-in">
      <span className="ai-summary-badge">
        <span className="ai-summary-sparkle" aria-hidden="true">
          ✨
        </span>
        <span className="ai-summary-name">blisspoolAI</span>
      </span>
      <p className="ai-prompt-text">
        Move {joinList(kids)} into your car for {legLabel}?
      </p>
      <div className="ai-prompt-actions">
        <button type="button" className="pill-button small" onClick={onConfirm} disabled={busy}>
          {busy ? "Moving..." : "Yes"}
        </button>
        <button type="button" className="pill-button small secondary" onClick={onDismiss} disabled={busy}>
          No
        </button>
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
  onCarsChange,
  kidDefaults,
  coParentId,
  householdCombined,
}: {
  label: string;
  time: string;
  cars: Car[];
  members: Member[];
  memberId: string;
  eligibleFor: (m: Member) => boolean;
  onCarsChange: (cars: Car[]) => void;
  kidDefaults: Map<string, string>;
  coParentId: string | null;
  householdCombined: boolean;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Kept mounted a beat after collapsing so its slide/pop-out animation has
  // something to play — expandedRow alone would unmount it instantly.
  const [closingRow, setClosingRow] = useState<string | null>(null);
  const [selectedKids, setSelectedKids] = useState<string[]>([]);
  const [moveError, setMoveError] = useState<string | null>(null);
  const selfKidsList = members.find((m) => m.id === memberId)?.kids ?? [];
  const myKids = new Set(selfKidsList);

  // Not driving a leg doesn't mean your kid has no ride — it defaults to
  // riding with whichever parent owns it by default, unless someone has
  // explicitly moved them into another active car for that leg.
  const assignedElsewhere = new Set(cars.flatMap((c) => c.kids));

  const rowData = members.map((m) => {
    const car = cars.find((c) => c.driverId === m.id);
    const kids = car
      ? car.kids
      : m.kids.filter((k) => !assignedElsewhere.has(k) && kidDefaults.get(k) === m.id);
    const eligible = eligibleFor(m);
    // A member's seat count is already "free seats for other people's kids" —
    // their own kid(s) riding along don't eat into it.
    const others = kids.filter((k) => !m.kids.includes(k)).length;
    const free = eligible ? Math.max(m.seats - others, 0) : 0;
    const isSelf = m.id === memberId;
    const isCoParent = m.id === coParentId;
    // A parent can always move their own kid into their own car or their
    // co-parent's car, even if the driving toggle is off — that toggle only
    // gates offering up free seats to other members' kids.
    const movableKids = selfKidsList.filter((k) => !kids.includes(k));
    const canMoveHere = movableKids.length > 0 && (isSelf || isCoParent || (eligible && free > 0));
    return { m, kids, eligible, free, isSelf, isCoParent, canMoveHere, movableKids };
  });

  // You first, then your co-parent, then cars with free seats, then everyone
  // else — alphabetical by name within each tier.
  const rows = [...rowData].sort((a, b) => {
    const rank = (r: (typeof rowData)[number]) =>
      r.isSelf ? 0 : r.m.id === coParentId ? 1 : r.eligible && r.free > 0 ? 2 : 3;
    const rankDiff = rank(a) - rank(b);
    return rankDiff !== 0 ? rankDiff : a.m.name.localeCompare(b.m.name);
  });

  const closeRow = (id: string) => {
    setClosingRow(id);
    setExpandedRow(null);
    setSelectedKids([]);
    setMoveError(null);
  };

  return (
    <div className="mini-form">
      <div className="driving-leg-header">
        <h3 className="bliss-heading">{label}</h3>
        <span className="driving-leg-time muted">{formatTime(time)}</span>
      </div>
      <div className="driving-row-list">
        {rows.map(({ m, kids, eligible, free, isSelf, isCoParent, canMoveHere, movableKids }) => {
          const expanded = canMoveHere && expandedRow === m.id;
          const closing = canMoveHere && closingRow === m.id;
          const multiPick = movableKids.length > 1;

          // Selecting past this car's free-seat capacity swaps in the new
          // kid for the oldest one already picked (with a note explaining
          // why) rather than silently refusing — a kid's own parent riding
          // along never counts against the driver's seats.
          const toggleSelect = (kid: string) => {
            const costsSeat = !m.kids.includes(kid);
            setSelectedKids((prev) => {
              if (prev.includes(kid)) {
                setMoveError(null);
                return prev.filter((k) => k !== kid);
              }
              const usedSeats = prev.filter((k) => !m.kids.includes(k)).length;
              if (costsSeat && usedSeats >= free) {
                const evictIndex = prev.findIndex((k) => !m.kids.includes(k));
                if (evictIndex === -1) {
                  setMoveError(
                    free === 0 ? "No free seats here." : `Only ${free} free seat${free === 1 ? "" : "s"} here.`
                  );
                  return prev;
                }
                const evicted = prev[evictIndex];
                setMoveError(
                  `Only ${free} free seat${free === 1 ? "" : "s"} here — swapped ${evicted} for ${kid}.`
                );
                return [...prev.slice(0, evictIndex), ...prev.slice(evictIndex + 1), kid];
              }
              setMoveError(null);
              return [...prev, kid];
            });
          };

          const commitMove = (kidsToMove: string[]) => {
            onCarsChange(kidsToMove.reduce((acc, kid) => moveKid(acc, kid, m.id), cars));
            closeRow(m.id);
          };

          return (
            <div
              className={`driving-row ${canMoveHere ? "tappable" : ""}`}
              key={m.id}
              onClick={() => {
                if (!canMoveHere) return;
                if (expandedRow === m.id) {
                  closeRow(m.id);
                } else {
                  if (expandedRow) setClosingRow(expandedRow);
                  setExpandedRow(m.id);
                  setSelectedKids([]);
                  setMoveError(null);
                }
              }}
            >
              <div className="driving-row-top">
                <div className="driving-row-main">
                  <strong>{isSelf ? "You" : m.name}</strong>
                  {!isSelf && householdCombined && coParentId === m.id && (
                    <span className="muted"> · same household</span>
                  )}
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
                <div className="driving-row-actions">
                  <span className={`seat-status ${eligible ? "" : "off"}`}>
                    {eligible
                      ? free > 0
                        ? `${free} free seat${free === 1 ? "" : "s"}`
                        : "No free seats"
                      : isCoParent
                        ? "Coparent"
                        : "Can't carpool"}
                  </span>
                  {(expanded || closing) && !multiPick && (
                    <button
                      type="button"
                      className={`pill-button small move-here-button ${!expanded && closing ? "closing" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitMove(movableKids);
                      }}
                      onAnimationEnd={() => {
                        if (!expanded && closing) setClosingRow((c) => (c === m.id ? null : c));
                      }}
                    >
                      Move {movableKids[0]} here
                    </button>
                  )}
                </div>
              </div>
              {(expanded || closing) && multiPick && (
                <div
                  className={`move-kid-picker ${!expanded && closing ? "closing" : "pop-in"}`}
                  onClick={(e) => e.stopPropagation()}
                  onAnimationEnd={() => {
                    if (!expanded && closing) setClosingRow((c) => (c === m.id ? null : c));
                  }}
                >
                  <div className="kid-tags">
                    {movableKids.map((kid) => (
                      <button
                        type="button"
                        key={kid}
                        className={`kid-pick ${selectedKids.includes(kid) ? "active" : ""}`}
                        onClick={() => toggleSelect(kid)}
                      >
                        {kid}
                      </button>
                    ))}
                  </div>
                  {moveError && <p className="form-error">{moveError}</p>}
                  <button
                    type="button"
                    className="pill-button small"
                    disabled={selectedKids.length === 0}
                    onClick={() => commitMove(selectedKids)}
                  >
                    Move {selectedKids.length > 0 ? joinList(selectedKids) : "kids"} here
                  </button>
                </div>
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
  const [editingCarpool, setEditingCarpool] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDropOff, setTogglingDropOff] = useState(false);
  const [togglingPickUp, setTogglingPickUp] = useState(false);
  const [movePrompt, setMovePrompt] = useState<{ leg: "dropOff" | "pickUp"; kids: string[] } | null>(
    null
  );
  const [applyingMovePrompt, setApplyingMovePrompt] = useState(false);

  const self = carpool.members.find((m) => m.id === memberId);
  // With nobody else to coordinate with yet, "who's driving who" has only
  // one answer — swap that whole section out for a prominent invite instead.
  const soloMember = carpool.members.length === 1;
  const [draftKids, setDraftKids] = useState<string[]>(self?.kids ?? []);
  const [draftName, setDraftName] = useState(carpool.name);
  const [draftDay, setDraftDay] = useState<DayOfWeek>(carpool.day);
  const [draftStreet, setDraftStreet] = useState(carpool.destination?.street ?? "");
  const [draftZip, setDraftZip] = useState(carpool.destination?.zip ?? "");
  const [draftDropOffTime, setDraftDropOffTime] = useState(carpool.dropOff?.time ?? "");
  const [draftPickUpTime, setDraftPickUpTime] = useState(carpool.pickUp?.time ?? "");
  const [household, setHousehold] = useState<{ coParentId: string | null; combined: boolean } | null>(
    null
  );

  useEffect(() => {
    getHousehold(memberId).then(setHousehold);
  }, [memberId]);

  const kidDefaults = computeKidDefaults(carpool.members);
  const youSummary = summarizeCarpool(carpool, memberId);
  const { display: typedSummary, done: typingDone } = useTypewriter(youSummary);

  const openCarpoolEditor = () => {
    setDraftKids(self?.kids ?? []);
    setDraftName(carpool.name);
    setDraftDay(carpool.day);
    setDraftStreet(carpool.destination?.street ?? "");
    setDraftZip(carpool.destination?.zip ?? "");
    setDraftDropOffTime(carpool.dropOff?.time ?? "");
    setDraftPickUpTime(carpool.pickUp?.time ?? "");
    setEditingCarpool(true);
  };

  const copyLink = async () => {
    const link = `${window.location.origin}?join=${carpool.code}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveCarpool = async () => {
    if (!self) return;
    setSaving(true);
    try {
      const updated = await updateCarpoolSchedule(
        carpool.code,
        draftDay,
        { street: draftStreet.trim(), zip: draftZip.trim() },
        { time: draftDropOffTime, cars: carpool.dropOff?.cars ?? [] },
        { time: draftPickUpTime, cars: carpool.pickUp?.cars ?? [] },
        draftName.trim() || undefined
      );
      const withKids = await joinCarpool(updated.code, { ...self, kids: draftKids });
      onCarpoolUpdated(withKids);
      setEditingCarpool(false);
    } finally {
      setSaving(false);
    }
  };

  const toggleDropOff = async () => {
    if (!self) return;
    setTogglingDropOff(true);
    try {
      const turningOn = !self.canDriveDropOff;
      const updated = await joinCarpool(carpool.code, {
        ...self,
        canDriveDropOff: turningOn,
      });
      onCarpoolUpdated(updated);
      if (turningOn) {
        const updatedSelf = updated.members.find((m) => m.id === memberId);
        const offer = kidsToOfferMove(updated.dropOff?.cars ?? [], memberId, updatedSelf?.kids ?? []);
        setMovePrompt(offer.length > 0 ? { leg: "dropOff", kids: offer } : null);
      } else {
        setMovePrompt((p) => (p?.leg === "dropOff" ? null : p));
      }
    } finally {
      setTogglingDropOff(false);
    }
  };

  const togglePickUp = async () => {
    if (!self) return;
    setTogglingPickUp(true);
    try {
      const turningOn = !self.canDrivePickUp;
      const updated = await joinCarpool(carpool.code, {
        ...self,
        canDrivePickUp: turningOn,
      });
      onCarpoolUpdated(updated);
      if (turningOn) {
        const updatedSelf = updated.members.find((m) => m.id === memberId);
        const offer = kidsToOfferMove(updated.pickUp?.cars ?? [], memberId, updatedSelf?.kids ?? []);
        setMovePrompt(offer.length > 0 ? { leg: "pickUp", kids: offer } : null);
      } else {
        setMovePrompt((p) => (p?.leg === "pickUp" ? null : p));
      }
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
  };

  const applyMovePrompt = async () => {
    if (!movePrompt) return;
    setApplyingMovePrompt(true);
    try {
      const currentCars = movePrompt.leg === "dropOff" ? carpool.dropOff?.cars ?? [] : carpool.pickUp?.cars ?? [];
      const cars = movePrompt.kids.reduce((acc, kid) => moveKid(acc, kid, memberId), currentCars);
      await updateLegCars(movePrompt.leg, cars);
    } finally {
      setApplyingMovePrompt(false);
      setMovePrompt(null);
    }
  };

  const dismissMovePrompt = () => setMovePrompt(null);

  return (
    <div className="carpool-detail">
      <div className="carpool-detail-sidebar">
        <button className="back-link" onClick={onBack}>
          &larr; All carpools
        </button>
        <div className="carpool-name-row">
          <h2>{carpool.name}</h2>
          {self && (
            <button type="button" className="text-link" onClick={openCarpoolEditor}>
              edit
            </button>
          )}
        </div>
        {self && youSummary && (
          <div className="ai-summary">
            <span className="ai-summary-badge">
              <span className="ai-summary-sparkle" aria-hidden="true">
                ✨
              </span>
              <span className="ai-summary-name">blisspoolAI</span>
              <span className="ai-summary-live" aria-hidden="true" />
            </span>
            <p className="ai-summary-quote">
              {typedSummary}
              <span
                className={`ai-summary-cursor ${typingDone ? "" : "typing"}`}
                aria-hidden="true"
              />
            </p>
          </div>
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
            <div className="leg-toggle-stack">
              <LegToggleRow
                label="Drop-off"
                time={carpool.dropOff?.time ?? ""}
                checked={self?.canDriveDropOff ?? false}
                disabled={!self || togglingDropOff}
                onToggle={toggleDropOff}
              />
              {movePrompt?.leg === "dropOff" && (
                <AiMovePrompt
                  kids={movePrompt.kids}
                  legLabel="drop-off"
                  onConfirm={applyMovePrompt}
                  onDismiss={dismissMovePrompt}
                  busy={applyingMovePrompt}
                />
              )}
            </div>
            <div className="leg-toggle-stack">
              <LegToggleRow
                label="Pick-up"
                time={carpool.pickUp?.time ?? ""}
                checked={self?.canDrivePickUp ?? false}
                disabled={!self || togglingPickUp}
                onToggle={togglePickUp}
              />
              {movePrompt?.leg === "pickUp" && (
                <AiMovePrompt
                  kids={movePrompt.kids}
                  legLabel="pick-up"
                  onConfirm={applyMovePrompt}
                  onDismiss={dismissMovePrompt}
                  busy={applyingMovePrompt}
                />
              )}
            </div>
          </div>
        </div>

        {!soloMember && (
          <div className="invite-box">
            <span className="invite-label">Invite code</span>
            <span className="invite-code">{carpool.code}</span>
            <button type="button" className="pill-button secondary" onClick={copyLink}>
              {copied ? "Copied!" : "Copy invite link"}
            </button>
          </div>
        )}
      </div>

      <div className="carpool-detail-main">
        {soloMember ? (
          <div className="solo-invite-panel">
            <h3 className="bliss-heading">You're the only one here so far</h3>
            <p className="muted">Share this code to get someone else driving with you.</p>
            <div className="invite-box invite-box-main">
              <span className="invite-label">Invite code</span>
              <span className="invite-code">{carpool.code}</span>
              <button type="button" className="pill-button secondary" onClick={copyLink}>
                {copied ? "Copied!" : "Copy invite link"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="bliss-heading">Who's driving who?</h3>
            <DrivingLeg
              label="Drop-off"
              time={carpool.dropOff?.time ?? ""}
              cars={carpool.dropOff?.cars ?? []}
              members={carpool.members}
              memberId={memberId}
              eligibleFor={(m) => m.canDriveDropOff}
              onCarsChange={(cars) => updateLegCars("dropOff", cars)}
              kidDefaults={kidDefaults}
              coParentId={household?.coParentId ?? null}
              householdCombined={household?.combined ?? false}
            />
            <DrivingLeg
              label="Pick-up"
              time={carpool.pickUp?.time ?? ""}
              cars={carpool.pickUp?.cars ?? []}
              members={carpool.members}
              memberId={memberId}
              eligibleFor={(m) => m.canDrivePickUp}
              onCarsChange={(cars) => updateLegCars("pickUp", cars)}
              kidDefaults={kidDefaults}
              coParentId={household?.coParentId ?? null}
              householdCombined={household?.combined ?? false}
            />
          </>
        )}
      </div>

      <BottomSheet
        open={editingCarpool}
        onClose={() => setEditingCarpool(false)}
        title="Edit carpool"
        footer={
          <button type="button" className="pill-button" onClick={saveCarpool} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Carpool name</span>
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Day</span>
          <select value={draftDay} onChange={(e) => setDraftDay(e.target.value as DayOfWeek)}>
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={draftStreet} onChange={(e) => setDraftStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={draftZip} onChange={(e) => setDraftZip(e.target.value)} inputMode="numeric" />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Drop-off time</span>
          <input
            type="time"
            value={draftDropOffTime}
            onChange={(e) => setDraftDropOffTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Pick-up time</span>
          <input
            type="time"
            value={draftPickUpTime}
            onChange={(e) => setDraftPickUpTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
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
