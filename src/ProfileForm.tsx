import { useState, type FormEvent } from "react";
import type { Profile } from "./types";
import { saveProfile } from "./useProfile";

export function ProfileForm({
  uid,
  existing,
  onSaved,
}: {
  uid: string;
  existing?: Profile | null;
  onSaved?: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [seats, setSeats] = useState(existing?.seats ?? 0);
  const [kids, setKids] = useState(existing?.kids ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name) return;
    setSaving(true);
    try {
      await saveProfile(uid, { name, seats, kids });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="new-trip-form" onSubmit={handleSubmit}>
      <h2>{existing ? "Edit profile" : "Set up your profile"}</h2>
      <input
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <div className="field-row">
        <input
          type="number"
          min={0}
          max={8}
          value={seats}
          onChange={(e) => setSeats(Number(e.target.value))}
          title="Seats you can offer when driving"
        />
        <input
          placeholder="Kids (optional, comma-separated)"
          value={kids}
          onChange={(e) => setKids(e.target.value)}
        />
      </div>
      <button type="submit" disabled={saving}>
        {saving ? "Saving..." : "Save profile"}
      </button>
    </form>
  );
}
