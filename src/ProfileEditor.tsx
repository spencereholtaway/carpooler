import { useEffect, useState, type KeyboardEvent } from "react";
import { claimName, getHousehold, joinCarpool, listCarpools, setHouseholdCombined } from "./api";
import type { LocalProfile } from "./useProfile";
import type { Carpool } from "./types";
import { BottomSheet } from "./BottomSheet";

export function ProfileEditor({
  memberId,
  profile,
  onSaved,
  onCarpoolUpdated,
  onClose,
}: {
  memberId: string;
  profile: LocalProfile;
  onSaved: (profile: LocalProfile) => void;
  onCarpoolUpdated: (carpool: Carpool) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [street, setStreet] = useState(profile.street);
  const [zip, setZip] = useState(profile.zip);
  const [kidInput, setKidInput] = useState("");
  const [kids, setKids] = useState<string[]>(profile.kids);
  const [nameError, setNameError] = useState<string | null>(null);
  const [kidsError, setKidsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [household, setHousehold] = useState<{
    code: string;
    coParentId: string | null;
    coParentName: string | null;
    combined: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [savingCombined, setSavingCombined] = useState(false);
  const [calendarCopied, setCalendarCopied] = useState(false);

  useEffect(() => {
    getHousehold(memberId).then(setHousehold);
  }, [memberId]);

  const copyCoParentLink = async () => {
    if (!household) return;
    await navigator.clipboard.writeText(`${window.location.origin}?coparent=${household.code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The `v` param exists only to bust Google/Apple's calendar-subscription
  // cache — feed content changes alone (like renaming X-WR-CALNAME) don't
  // reliably make a calendar app re-fetch an already-subscribed URL, so we
  // bump this whenever we need existing subscribers to get a guaranteed
  // fresh pull. The value is otherwise ignored by the feed handler.
  const CALENDAR_FEED_VERSION = 2;
  const calendarHttpUrl = `${window.location.origin}/api/calendar?memberId=${memberId}&v=${CALENDAR_FEED_VERSION}`;
  const calendarWebcalUrl = calendarHttpUrl.replace(/^https?:\/\//, "webcal://");

  // Google doesn't offer a reliable deep link that pre-fills its "Add by
  // URL" field (the old render?cid= trick gets rejected as an invalid
  // calendar id by Google's current frontend) — so copy the link for them
  // and land them on that settings screen instead of guessing at a hack.
  const addToGoogleCalendar = async () => {
    await navigator.clipboard.writeText(calendarHttpUrl);
    setCalendarCopied(true);
    setTimeout(() => setCalendarCopied(false), 2000);
    window.open("https://calendar.google.com/calendar/r/settings/addbyurl", "_blank", "noreferrer");
  };

  const toggleCombined = async () => {
    if (!household) return;
    setSavingCombined(true);
    try {
      const { combined } = await setHouseholdCombined(memberId, !household.combined);
      setHousehold((h) => (h ? { ...h, combined } : h));
    } finally {
      setSavingCombined(false);
    }
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

  const handleSubmit = async () => {
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
        kids,
        street: street.trim(),
        zip: zip.trim(),
      };

      // Keep every carpool's copy of this member's info in sync (each carpool's
      // kids/driving stay as they were there — only shared profile fields change).
      // Also feed each result back up so an already-open carpool (e.g. the one
      // this edit was opened from) doesn't keep showing pre-edit values like
      // name until the user navigates away and back. Per-leg car capacity
      // lives on the carpool itself now, so it isn't touched here.
      const carpools = await listCarpools(memberId);
      await Promise.all(
        carpools.map(async (c) => {
          const self = c.members.find((m) => m.id === memberId);
          if (!self) return;
          const updatedCarpool = await joinCarpool(c.code, {
            ...self,
            name: updated.name,
            street: updated.street,
            zip: updated.zip,
          });
          onCarpoolUpdated(updatedCarpool);
        })
      );

      onSaved(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      title="Your profile"
      footer={
        <button type="button" className="pill-button" onClick={handleSubmit} disabled={saving}>
          {saving ? "Saving..." : "Save changes"}
        </button>
      }
    >
      <div className="mini-form">
        <h4>Name</h4>
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
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={household.combined}
                disabled={savingCombined}
                onChange={toggleCombined}
              />
              We share driving as one household
            </label>
            <p className="muted">
              Marks you as a combined household in shared carpools, instead of treating each of
              you as a separate default driver.
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

      <div className="invite-box">
        <span className="invite-label">Your driving calendar</span>
        <p className="muted">
          Subscribe to see who's driving your kids, where, and when — it updates automatically as
          carpools change.
        </p>
        <div className="calendar-subscribe-list">
          <div className="calendar-subscribe-item">
            <h5>Adding to Apple Calendar</h5>
            <p className="muted">
              Tap the button below — Calendar will open and ask you to confirm the subscription.
            </p>
            <a className="pill-button secondary small" href={calendarWebcalUrl}>
              Add to Apple Calendar
            </a>
          </div>
          <div className="calendar-subscribe-item">
            <h5>Adding to Google Calendar</h5>
            <p className="muted">
              Copy the link below, then paste it into the "From URL" box that opens (Settings &rarr;
              Add calendar &rarr; From URL).
            </p>
            <button type="button" className="pill-button secondary small" onClick={addToGoogleCalendar}>
              {calendarCopied ? "Copied!" : "Copy calendar link"}
            </button>
          </div>
        </div>
      </div>

      <div className="mini-form">
        <h4>Address</h4>
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={street} onChange={(e) => setStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      <div className="mini-form">
        <h4>Your kids</h4>
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
    </BottomSheet>
  );
}
