import { useState } from "react";
import { joinCarpool, updateCarpoolSchedule } from "./api";
import { KidPicker } from "./KidPicker";
import { mapsLink } from "./maps";
import { DAYS_OF_WEEK, type Carpool, type DayOfWeek } from "./types";

function formatTime(time: string) {
  if (!time) return "no time set";
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
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
  const [editingKids, setEditingKids] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDriving, setTogglingDriving] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const self = carpool.members.find((m) => m.id === memberId);
  const [draftKids, setDraftKids] = useState<string[]>(self?.kids ?? []);

  const [draftDay, setDraftDay] = useState<DayOfWeek>(carpool.day ?? "Monday");
  const [draftDestStreet, setDraftDestStreet] = useState(carpool.destination?.street ?? "");
  const [draftDestZip, setDraftDestZip] = useState(carpool.destination?.zip ?? "");
  const [draftDropOffTime, setDraftDropOffTime] = useState(carpool.dropOff?.time ?? "");
  const [draftDropOffDriver, setDraftDropOffDriver] = useState(carpool.dropOff?.driverId ?? "");
  const [draftPickUpTime, setDraftPickUpTime] = useState(carpool.pickUp?.time ?? "");
  const [draftPickUpDriver, setDraftPickUpDriver] = useState(carpool.pickUp?.driverId ?? "");

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

  const toggleDriving = async () => {
    if (!self) return;
    setTogglingDriving(true);
    try {
      const updated = await joinCarpool(carpool.code, { ...self, isDriving: !self.isDriving });
      onCarpoolUpdated(updated);
    } finally {
      setTogglingDriving(false);
    }
  };

  const saveSchedule = async () => {
    setSavingSchedule(true);
    try {
      const updated = await updateCarpoolSchedule(
        carpool.code,
        draftDay,
        { street: draftDestStreet, zip: draftDestZip },
        { time: draftDropOffTime, driverId: draftDropOffDriver || null },
        { time: draftPickUpTime, driverId: draftPickUpDriver || null }
      );
      onCarpoolUpdated(updated);
      setEditingSchedule(false);
    } finally {
      setSavingSchedule(false);
    }
  };

  const driverName = (id: string | null) => carpool.members.find((m) => m.id === id)?.name;

  return (
    <div className="carpool-detail">
      <button className="back-link" onClick={onBack}>
        &larr; All carpools
      </button>
      <h2>{carpool.name}</h2>

      <div className="mini-form">
        <div className="mini-form-header">
          <h3>Schedule</h3>
          {!editingSchedule && (
            <button type="button" className="text-link" onClick={() => setEditingSchedule(true)}>
              edit
            </button>
          )}
        </div>
        {editingSchedule ? (
          <>
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
            <div className="field-row">
              <div className="form-field street-field">
                <span className="gate-field-label">Destination street</span>
                <input
                  value={draftDestStreet}
                  onChange={(e) => setDraftDestStreet(e.target.value)}
                />
              </div>
              <div className="form-field zip-field">
                <span className="gate-field-label">Zip code</span>
                <input
                  value={draftDestZip}
                  onChange={(e) => setDraftDestZip(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="form-field">
              <span className="gate-field-label">Drop-off time</span>
              <input
                type="time"
                value={draftDropOffTime}
                onChange={(e) => setDraftDropOffTime(e.target.value)}
              />
            </div>
            <div className="form-field">
              <span className="gate-field-label">Drop-off driver</span>
              <select value={draftDropOffDriver} onChange={(e) => setDraftDropOffDriver(e.target.value)}>
                <option value="">Not assigned</option>
                {carpool.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <span className="gate-field-label">Pick-up time</span>
              <input
                type="time"
                value={draftPickUpTime}
                onChange={(e) => setDraftPickUpTime(e.target.value)}
              />
            </div>
            <div className="form-field">
              <span className="gate-field-label">Pick-up driver</span>
              <select value={draftPickUpDriver} onChange={(e) => setDraftPickUpDriver(e.target.value)}>
                <option value="">Not assigned</option>
                {carpool.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="pill-button small"
              onClick={saveSchedule}
              disabled={savingSchedule}
            >
              {savingSchedule ? "Saving..." : "Save"}
            </button>
          </>
        ) : (
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
            <p className="muted">
              Drop-off {formatTime(carpool.dropOff?.time ?? "")}
              {carpool.dropOff?.driverId ? ` · ${driverName(carpool.dropOff.driverId)} driving` : ""}
            </p>
            <p className="muted">
              Pick-up {formatTime(carpool.pickUp?.time ?? "")}
              {carpool.pickUp?.driverId ? ` · ${driverName(carpool.pickUp.driverId)} driving` : ""}
            </p>
          </div>
        )}
      </div>

      <h3>Members</h3>
      <ul className="member-list">
        {carpool.members.map((m) => (
          <li key={m.id}>
            <span className="member-name">
              {m.name}
              {m.isDriving && <span className="driving-badge">🚗 Driving</span>}
            </span>
            <span className="member-meta">
              {(m.seats ?? 0) > 0 ? `${m.seats} seat${m.seats === 1 ? "" : "s"} free` : "no extra seats"}
              {(m.kids ?? []).length > 0 ? ` · ${m.kids.join(", ")}` : ""}
            </span>
            {m.street && (
              <a
                className="address-link"
                href={mapsLink(m.street, m.zip)}
                target="_blank"
                rel="noreferrer"
              >
                📍 {m.street}
                {m.zip ? `, ${m.zip}` : ""}
              </a>
            )}
          </li>
        ))}
      </ul>

      {self && (
        <div className="mini-form">
          <div className="mini-form-header">
            <h3>Are you driving?</h3>
          </div>
          <label className="driving-toggle">
            <input
              type="checkbox"
              checked={self.isDriving}
              onChange={toggleDriving}
              disabled={togglingDriving}
            />
            <span>I&rsquo;m driving for this carpool</span>
          </label>
        </div>
      )}

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
    </div>
  );
}
