import { useState } from "react";
import { joinCarpool, updateCarpoolSchedule } from "./api";
import { KidPicker } from "./KidPicker";
import { mapsLink } from "./maps";
import { DAYS_OF_WEEK, type Car, type Carpool, type DayOfWeek, type Member } from "./types";

function formatTime(time: string) {
  if (!time) return "no time set";
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function carForKid(cars: Car[], kid: string): string | null {
  return cars.find((c) => c.kids.includes(kid))?.driverId ?? null;
}

function moveKid(cars: Car[], kid: string, driverId: string | null): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  return cleared.map((c) => (c.driverId === driverId ? { ...c, kids: [...c.kids, kid] } : c));
}

function LegEditor({
  label,
  time,
  onTimeChange,
  cars,
  onCarsChange,
  eligibleDrivers,
  allKids,
}: {
  label: string;
  time: string;
  onTimeChange: (time: string) => void;
  cars: Car[];
  onCarsChange: (cars: Car[]) => void;
  eligibleDrivers: Member[];
  allKids: string[];
}) {
  const toggleActive = (driverId: string) => {
    const active = cars.some((c) => c.driverId === driverId);
    if (active) {
      onCarsChange(cars.filter((c) => c.driverId !== driverId));
      return;
    }
    // Assume a driver is taking their own kid(s) by default — unless someone
    // already explicitly moved that kid into a different active car.
    const driver = eligibleDrivers.find((d) => d.id === driverId);
    const alreadyAssigned = new Set(cars.flatMap((c) => c.kids));
    const ownKids = (driver?.kids ?? []).filter(
      (k) => allKids.includes(k) && !alreadyAssigned.has(k)
    );
    onCarsChange([...cars, { driverId, kids: ownKids }]);
  };

  return (
    <div className="mini-form">
      <h3>{label}</h3>
      <div className="form-field">
        <span className="gate-field-label">Time</span>
        <input
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          onInvalid={(e) => e.preventDefault()}
        />
      </div>

      <div className="form-field">
        <span className="gate-field-label">Active cars</span>
        {eligibleDrivers.length === 0 ? (
          <p className="muted">No one has said they can drive yet.</p>
        ) : (
          <div className="kid-tags">
            {eligibleDrivers.map((d) => (
              <button
                type="button"
                key={d.id}
                className={`kid-pick ${cars.some((c) => c.driverId === d.id) ? "active" : ""}`}
                onClick={() => toggleActive(d.id)}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {cars.length > 0 && allKids.length > 0 && (
        <div className="form-field">
          <span className="gate-field-label">Who rides with who</span>
          <div className="car-assign-list">
            {allKids.map((kid) => (
              <div className="car-assign-row" key={kid}>
                <span>{kid}</span>
                <select
                  value={carForKid(cars, kid) ?? ""}
                  onChange={(e) => onCarsChange(moveKid(cars, kid, e.target.value || null))}
                >
                  <option value="">Unassigned</option>
                  {cars.map((c) => (
                    <option key={c.driverId} value={c.driverId}>
                      {eligibleDrivers.find((d) => d.id === c.driverId)?.name ?? "Driver"}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DrivingLeg({
  label,
  time,
  cars,
  members,
  allKids,
  memberId,
  onCarsChange,
}: {
  label: string;
  time: string;
  cars: Car[];
  members: Member[];
  allKids: string[];
  memberId: string;
  onCarsChange: (cars: Car[]) => void;
}) {
  const sorted = [...cars].sort((a) => (a.driverId === memberId ? -1 : 0));
  const nameFor = (id: string) => members.find((m) => m.id === id)?.name ?? "Driver";
  const seatsFor = (id: string) => members.find((m) => m.id === id)?.seats ?? 0;

  return (
    <div className="mini-form">
      <h3>
        {label} <span className="muted">· {formatTime(time)}</span>
      </h3>
      {sorted.length === 0 ? (
        <p className="muted">No one has said they can drive yet.</p>
      ) : (
        <>
          {sorted.map((c) => {
            const free = Math.max(seatsFor(c.driverId) - c.kids.length, 0);
            return (
              <p className="muted" key={c.driverId}>
                <strong>
                  {nameFor(c.driverId)}
                  {c.driverId === memberId ? " (you)" : ""}
                </strong>{" "}
                — {free} seat{free === 1 ? "" : "s"} free
                {c.kids.length > 0 ? ` · driving ${c.kids.join(", ")}` : ""}
              </p>
            );
          })}
          {allKids.length > 0 && (
            <div className="car-assign-list">
              {allKids.map((kid) => (
                <div className="car-assign-row" key={kid}>
                  <span>{kid}</span>
                  <select
                    value={carForKid(cars, kid) ?? ""}
                    onChange={(e) => onCarsChange(moveKid(cars, kid, e.target.value || null))}
                  >
                    <option value="">Unassigned</option>
                    {sorted.map((c) => (
                      <option key={c.driverId} value={c.driverId}>
                        {nameFor(c.driverId)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </>
      )}
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
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const self = carpool.members.find((m) => m.id === memberId);
  const [draftKids, setDraftKids] = useState<string[]>(self?.kids ?? []);

  const [draftDay, setDraftDay] = useState<DayOfWeek>(carpool.day ?? "Monday");
  const [draftDestStreet, setDraftDestStreet] = useState(carpool.destination?.street ?? "");
  const [draftDestZip, setDraftDestZip] = useState(carpool.destination?.zip ?? "");
  const [draftDropOffTime, setDraftDropOffTime] = useState(carpool.dropOff?.time ?? "");
  const [draftDropOffCars, setDraftDropOffCars] = useState<Car[]>(carpool.dropOff?.cars ?? []);
  const [draftPickUpTime, setDraftPickUpTime] = useState(carpool.pickUp?.time ?? "");
  const [draftPickUpCars, setDraftPickUpCars] = useState<Car[]>(carpool.pickUp?.cars ?? []);

  const copyLink = async () => {
    const link = `${window.location.origin}?join=${carpool.code}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const carpoolKids = [...new Set(carpool.members.flatMap((m) => m.kids ?? []))];
  const dropOffEligible = carpool.members.filter((m) => m.canDriveDropOff);
  const pickUpEligible = carpool.members.filter((m) => m.canDrivePickUp);

  const saveKids = async () => {
    if (!self) return;
    setSaving(true);
    try {
      const updated = await joinCarpool(carpool.code, { ...self, kids: draftKids });
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

  const saveSchedule = async () => {
    setSavingSchedule(true);
    try {
      const updated = await updateCarpoolSchedule(
        carpool.code,
        draftDay,
        { street: draftDestStreet, zip: draftDestZip },
        { time: draftDropOffTime, cars: draftDropOffCars },
        { time: draftPickUpTime, cars: draftPickUpCars }
      );
      onCarpoolUpdated(updated);
      setEditingSchedule(false);
    } finally {
      setSavingSchedule(false);
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

  const legSummary = (leg: { time: string; cars?: Car[] } | undefined) => (
    <p className="muted">{formatTime(leg?.time ?? "")}</p>
  );

  return (
    <div className="carpool-detail">
      <button className="back-link" onClick={onBack}>
        &larr; All carpools
      </button>
      <h2>{carpool.name}</h2>

      {self && allKids.length > 0 && (
        <div className="mini-form">
          <div className="mini-form-header">
            <h3>Your kids in this carpool</h3>
            {!editingKids && (
              <button type="button" className="text-link" onClick={() => setEditingKids(true)}>
                edit
              </button>
            )}
          </div>
          {editingKids ? (
            <>
              <KidPicker allKids={allKids} selected={draftKids} onChange={setDraftKids} label="" />
              <button
                type="button"
                className="pill-button small"
                onClick={saveKids}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          ) : (
            <p className="muted">
              {(self.kids ?? []).length > 0 ? self.kids.join(", ") : "None assigned yet."}
            </p>
          )}
        </div>
      )}

      {editingSchedule ? (
        <form
          className="profile-editor-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveSchedule();
          }}
        >
          <div className="mini-form">
            <div className="mini-form-header">
              <h3>Day</h3>
              <button
                type="button"
                className="close-x"
                onClick={() => setEditingSchedule(false)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <select value={draftDay} onChange={(e) => setDraftDay(e.target.value as DayOfWeek)}>
              {DAYS_OF_WEEK.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="mini-form">
            <h3>Destination</h3>
            <div className="form-field">
              <span className="gate-field-label">Street address</span>
              <input
                value={draftDestStreet}
                onChange={(e) => setDraftDestStreet(e.target.value)}
              />
            </div>
            <div className="form-field">
              <span className="gate-field-label">Zip code</span>
              <input
                value={draftDestZip}
                onChange={(e) => setDraftDestZip(e.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>

          <LegEditor
            label="Drop-off"
            time={draftDropOffTime}
            onTimeChange={setDraftDropOffTime}
            cars={draftDropOffCars}
            onCarsChange={setDraftDropOffCars}
            eligibleDrivers={dropOffEligible}
            allKids={carpoolKids}
          />

          <LegEditor
            label="Pick-up"
            time={draftPickUpTime}
            onTimeChange={setDraftPickUpTime}
            cars={draftPickUpCars}
            onCarsChange={setDraftPickUpCars}
            eligibleDrivers={pickUpEligible}
            allKids={carpoolKids}
          />

          <div className="floating-save-bar">
            <button type="submit" className="pill-button" disabled={savingSchedule}>
              {savingSchedule ? "Saving..." : "Save schedule"}
            </button>
          </div>
        </form>
      ) : (
        <div className="mini-form">
          <div className="mini-form-header">
            <h3>Schedule</h3>
            <button type="button" className="text-link" onClick={() => setEditingSchedule(true)}>
              edit
            </button>
          </div>
          <div className="schedule-summary">
            <p>
              <strong>{carpool.day ?? "No day set"}</strong>
            </p>
            {carpool.destination?.street && (
              <p className="muted">
                <a
                  className="address-link"
                  href={mapsLink(carpool.destination.street, carpool.destination.zip)}
                  target="_blank"
                  rel="noreferrer"
                >
                  📍 {carpool.destination.street}
                  {carpool.destination.zip ? `, ${carpool.destination.zip}` : ""}
                </a>
              </p>
            )}
            <p>
              <strong>Drop-off</strong>
            </p>
            {legSummary(carpool.dropOff)}
            <p>
              <strong>Pick-up</strong>
            </p>
            {legSummary(carpool.pickUp)}
          </div>
        </div>
      )}

      {self && (
        <div className="mini-form">
          <div className="mini-form-header">
            <h3>Can you drive?</h3>
          </div>
          <label className="driving-toggle">
            <input
              type="checkbox"
              checked={self.canDriveDropOff}
              onChange={toggleDropOff}
              disabled={togglingDropOff}
            />
            <span>I can drive drop-off</span>
          </label>
          <label className="driving-toggle">
            <input
              type="checkbox"
              checked={self.canDrivePickUp}
              onChange={togglePickUp}
              disabled={togglingPickUp}
            />
            <span>I can drive pick-up</span>
          </label>
        </div>
      )}

      <h3>Who's driving who?</h3>
      <DrivingLeg
        label="Drop-off"
        time={carpool.dropOff?.time ?? ""}
        cars={carpool.dropOff?.cars ?? []}
        members={carpool.members}
        allKids={carpoolKids}
        memberId={memberId}
        onCarsChange={(cars) => updateLegCars("dropOff", cars)}
      />
      <DrivingLeg
        label="Pick-up"
        time={carpool.pickUp?.time ?? ""}
        cars={carpool.pickUp?.cars ?? []}
        members={carpool.members}
        allKids={carpoolKids}
        memberId={memberId}
        onCarsChange={(cars) => updateLegCars("pickUp", cars)}
      />

      <div className="invite-box">
        <span className="invite-label">Invite code</span>
        <span className="invite-code">{carpool.code}</span>
        <button type="button" className="pill-button secondary" onClick={copyLink}>
          {copied ? "Copied!" : "Copy invite link"}
        </button>
      </div>
    </div>
  );
}
