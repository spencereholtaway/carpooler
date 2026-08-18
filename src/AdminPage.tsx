import { useEffect, useState, type FormEvent } from "react";

const KEY_STORAGE = "blisspool:admin-key";

type AdminUser = {
  memberId: string;
  name: string;
  seats: number;
  kids: string[];
  street: string;
  zip: string;
};

type AdminMember = { id: string; name: string; seats: number; kids: string[]; isDriving: boolean };
type AdminCarpool = {
  code: string;
  name: string;
  day: string;
  destination?: { street: string; zip: string };
  dropOff?: { time: string; driverId: string | null };
  pickUp?: { time: string; driverId: string | null };
  members: AdminMember[];
  createdAt: number;
};

export function AdminPage() {
  const [key, setKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? "");
  const [keyInput, setKeyInput] = useState("");
  const [tab, setTab] = useState<"users" | "carpools">("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [carpools, setCarpools] = useState<AdminCarpool[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (candidateKey: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/data?key=${encodeURIComponent(candidateKey)}`);
      if (res.status === 401) {
        setError("Invalid key.");
        localStorage.removeItem(KEY_STORAGE);
        setKey("");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setUsers(data.users);
      setCarpools(data.carpools);
      localStorage.setItem(KEY_STORAGE, candidateKey);
      setKey(candidateKey);
    } catch {
      setError("Couldn't load admin data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (key) load(key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeySubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    load(keyInput.trim());
  };

  if (!key) {
    return (
      <div className="admin-login">
        <form className="admin-login-box" onSubmit={handleKeySubmit}>
          <h1>Admin</h1>
          <input
            type="password"
            placeholder="Admin key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            autoFocus
          />
          {error && <p className="admin-error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "Checking..." : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-container">
          <span className="admin-logo">Blisspool Admin</span>
          <nav className="admin-tabs">
            <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
              Users ({users.length})
            </button>
            <button className={tab === "carpools" ? "active" : ""} onClick={() => setTab("carpools")}>
              Carpools ({carpools.length})
            </button>
          </nav>
        </div>
      </header>

      <main className="admin-main">
        <div className="admin-container">
        {loading && <p>Loading...</p>}
        {error && <p className="admin-error">{error}</p>}

        {!loading && tab === "users" && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kids</th>
                  <th>Seats</th>
                  <th>Street</th>
                  <th>Zip</th>
                  <th>Member ID</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.memberId}>
                    <td>{u.name}</td>
                    <td>{u.kids?.join(", ") || "—"}</td>
                    <td>{u.seats}</td>
                    <td>{u.street || "—"}</td>
                    <td>{u.zip || "—"}</td>
                    <td className="admin-mono">{u.memberId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && tab === "carpools" && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Day</th>
                  <th>Destination</th>
                  <th>Drop-off</th>
                  <th>Pick-up</th>
                  <th>Members</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {carpools.map((c) => (
                  <tr key={c.code}>
                    <td>{c.name}</td>
                    <td>{c.day ?? "—"}</td>
                    <td>
                      {c.destination?.street
                        ? `${c.destination.street}, ${c.destination.zip}`
                        : "—"}
                    </td>
                    <td>{c.dropOff?.time || "—"}</td>
                    <td>{c.pickUp?.time || "—"}</td>
                    <td>{c.members.map((m) => m.name).join(", ")}</td>
                    <td className="admin-mono">{c.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
