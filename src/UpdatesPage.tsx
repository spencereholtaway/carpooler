import { useEffect, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { listUpdates, type Update } from "./api";

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function UpdatesPage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [updates, setUpdates] = useState<Update[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(false);
    listUpdates()
      .then(setUpdates)
      .catch(() => setError(true));
  }, [open]);

  return (
    <BottomSheet open={open} onClose={onClose} title="What's new">
      {error ? (
        <p className="form-error">Couldn't load updates.</p>
      ) : updates === null ? (
        <p className="admin-muted">Loading...</p>
      ) : updates.length === 0 ? (
        <p className="admin-muted">No updates yet.</p>
      ) : (
        <ul className="updates-list">
          {updates.map((u) => (
            <li key={u.id} className="updates-list-item">
              <p className="updates-list-date">{formatDate(u.createdAt)}</p>
              <p className="updates-list-text">{u.text}</p>
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}
