import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { claimName, getHousehold, joinCarpool, listCarpools } from "./api";
import type { LocalProfile } from "./useProfile";

export function ProfileEditor({
  memberId,
  profile,
  onSaved,
  onClose,
}: {
  memberId: string;
  profile: LocalProfile;
  onSaved: (profile: LocalProfile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [street, setStreet] = useState(profile.street);
  const [zip, setZip] = useState(profile.zip);
  const [seats, setSeats] = useState(profile.seats);
  const [kidInput, setKidInput] = useState("");
  const [kids, setKids] = useState<string[]>(profile.kids);
  const [nameError, setNameError] = useState<string | null>(null);
  const [kidsError, setKidsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [household, setHousehold] = useState<{
    code: string;
    coParentId: string | null;
    coParentName: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getHousehold(memberId).then(setHousehold);
  }, [memberId]);

  const copyCoParentLink = async () => {
    if (!household) return;
    await navigator.clipboard.writeText(`${window.location.origin}?coparent=${household.code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const addKid = () => {
    const trimmed = kidInput.trim();
    if (!trimmed) return;
    setKids((prev) => [...prev, trimmed]);
    setKidInput("");
    setKidsError(null);
  };

  const handleKidKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKid();
    }
  };

  const removeKid = (index: number) => {
    setKids((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (kids.length === 0) {
      setKidsError("Add at least one kid — carpools are organized by kid.");
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      if (trimmedName.toLowerCase() !== profile.name.toLowerCase()) {
        const result = await claimName(trimmedName, memberId);
        if (result.recovered && result.memberId !== memberId) {
          setNameError("That name's taken — try another.");
          setSaving(false);
          return;
        }
      }

      const updated: LocalProfile = {
        name: trimmedName,
        seats,
        kids,
        street: street.trim(),
        zip: zip.trim(),
      };

      // Keep every carpool's copy of this member's info in sync (each carpool's
      // kids/driving stay as they were there — only shared profile fields change).
      const carpools = await listCarpools(memberId);
      await Promise.all(
        carpools.map((c) => {
          const self = c.members.find((m) => m.id === memberId);
          if (!self) return Promise.resolve();
          return joinCarpool(c.code, {
            ...self,
            name: updated.name,
            seats: updated.seats,
            street: updated.street,
            zip: updated.zip,
          });
        })
      );

      onSaved(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="carpool-detail">
      <button className="back-link" onClick={onClose}>
        &larr; Back
      </button>
      <h2>Your profile</h2>

      <form className="profile-editor-form" onSubmit={handleSubmit}>
        <div className="mini-form">
          <h3>Name</h3>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
          {nameError && <p className="form-error">{nameError}</p>}
        </div>

        <div className="invite-box">
          {household?.coParentName ? (
            <>
              <span className="invite-label">Linked co-parent</span>
              <span className="invite-code linked-coparent-name">{household.coParentName}</span>
              <p className="muted">
                When either of you joins or starts a carpool for a shared kid, the other is added
                automatically (driving stays a separate choice for each of you).
              </p>
            </>
          ) : (
            <>
              <span className="invite-label">Invite your co-parent</span>
              <span className="invite-code">{household?.code ?? "······"}</span>
              <p className="muted">
                Once linked, joining or starting a carpool for a shared kid adds both of you.
              </p>
              <button
                type="button"
                className="pill-button secondary"
                onClick={copyCoParentLink}
                disabled={!household}
              >
                {copied ? "Copied!" : "Copy invite link for co-parent"}
              </button>
            </>
          )}
        </div>

        <div className="mini-form">
          <h3>Address</h3>
          <div className="field-row">
            <div className="form-field street-field">
              <span className="gate-field-label">Street address</span>
              <input value={street} onChange={(e) => setStreet(e.target.value)} />
            </div>
            <div className="form-field zip-field">
              <span className="gate-field-label">Zip code</span>
              <input value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" />
            </div>
          </div>
        </div>

        <div className="mini-form">
          <h3>Your kids</h3>
          <div className="kid-input-row">
            <input
              placeholder="Kid's name, then Enter"
              value={kidInput}
              onChange={(e) => setKidInput(e.target.value)}
              onKeyDown={handleKidKeyDown}
            />
            <button type="button" className="pill-button secondary small" onClick={addKid}>
              Add
            </button>
          </div>
          {kids.length > 0 && (
            <div className="kid-tags">
              {kids.map((kid, i) => (
                <span className="kid-tag pop-in" key={`${kid}-${i}`}>
                  {kid}
                  <button type="button" onClick={() => removeKid(i)} aria-label={`Remove ${kid}`}>
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
          {kidsError && <p className="form-error">{kidsError}</p>}
        </div>

        <div className="mini-form">
          <h3>Free seats in your car</h3>
          <div className="seat-stepper">
            <button
              type="button"
              onClick={() => setSeats((s) => Math.max(0, s - 1))}
              aria-label="Fewer seats"
            >
              &minus;
            </button>
            <span className="seat-count">{seats}</span>
            <button
              type="button"
              onClick={() => setSeats((s) => Math.min(8, s + 1))}
              aria-label="More seats"
            >
              +
            </button>
          </div>
        </div>

        <div className="floating-save-bar">
          <button type="submit" className="pill-button" disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
