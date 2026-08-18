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

type AdminMember = {
  id: string;
  name: string;
  seats: number;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
};
type AdminCarpool = {
  code: string;
  name: string;
  day: string;
  destination?: { street: string; zip: string };
  dropOff?: { time: string; cars: { driverId: string; kids: string[] }[] };
  pickUp?: { time: string; cars: { driverId: string; kids: string[] }[] };
  members: AdminMember[];
  createdAt: number;
};

export function AdminPage() {
  useEffect(() => {
    document.title = "Admin | Blisspool";
  }, []);

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

  const callAdmin = async (action: string, payload: unknown) => {
    const res = await fetch("/api/admin/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action, payload }),
    });
    if (!res.ok) throw new Error(await res.text());
    await load(key);
  };

  const [newUser, setNewUser] = useState({ name: "", seats: "1", kids: "", street: "", zip: "" });
  const [addingUser, setAddingUser] = useState(false);
  const createUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!newUser.name.trim()) return;
    setAddingUser(true);
    try {
      await callAdmin("createUser", {
        name: newUser.name.trim(),
        seats: Number(newUser.seats) || 0,
        kids: newUser.kids.split(",").map((k) => k.trim()).filter(Boolean),
        street: newUser.street,
        zip: newUser.zip,
      });
      setNewUser({ name: "", seats: "1", kids: "", street: "", zip: "" });
    } finally {
      setAddingUser(false);
    }
  };

  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState<AdminUser | null>(null);
  const startEditUser = (u: AdminUser) => {
    setEditingUser(u.memberId);
    setUserDraft({ ...u });
  };
  const saveUser = async () => {
    if (!userDraft) return;
    await callAdmin("updateUser", {
      memberId: userDraft.memberId,
      name: userDraft.name,
      seats: Number(userDraft.seats) || 0,
      kids: userDraft.kids,
      street: userDraft.street,
      zip: userDraft.zip,
    });
    setEditingUser(null);
  };
  const deleteUser = async (memberId: string) => {
    if (!confirm("Delete this user? This removes them from any carpools too.")) return;
    await callAdmin("deleteUser", { memberId });
  };

  const [editingCarpool, setEditingCarpool] = useState<string | null>(null);
  const [carpoolDraft, setCarpoolDraft] = useState<AdminCarpool | null>(null);
  const startEditCarpool = (c: AdminCarpool) => {
    setEditingCarpool(c.code);
    setCarpoolDraft({ ...c, destination: { ...(c.destination ?? { street: "", zip: "" }) } });
  };
  const saveCarpool = async () => {
    if (!carpoolDraft) return;
    await callAdmin("updateCarpool", {
      code: carpoolDraft.code,
      name: carpoolDraft.name,
      day: carpoolDraft.day,
      destination: carpoolDraft.destination,
    });
    setEditingCarpool(null);
  };
  const deleteCarpool = async (code: string) => {
    if (!confirm("Delete this carpool entirely?")) return;
    await callAdmin("deleteCarpool", { code });
  };
  const removeMember = async (code: string, memberId: string) => {
    if (!confirm("Remove this member from the carpool?")) return;
    await callAdmin("removeMember", { code, memberId });
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
            <form className="admin-add-row" onSubmit={createUser}>
              <input
                placeholder="Name"
                value={newUser.name}
                onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              />
              <input
                placeholder="Kids (comma separated)"
                value={newUser.kids}
                onChange={(e) => setNewUser({ ...newUser, kids: e.target.value })}
              />
              <input
                type="number"
                placeholder="Seats"
                value={newUser.seats}
                onChange={(e) => setNewUser({ ...newUser, seats: e.target.value })}
              />
              <input
                placeholder="Street"
                value={newUser.street}
                onChange={(e) => setNewUser({ ...newUser, street: e.target.value })}
              />
              <input
                placeholder="Zip"
                value={newUser.zip}
                onChange={(e) => setNewUser({ ...newUser, zip: e.target.value })}
              />
              <button type="submit" disabled={addingUser}>
                {addingUser ? "Adding..." : "Add user"}
              </button>
            </form>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kids</th>
                  <th>Seats</th>
                  <th>Street</th>
                  <th>Zip</th>
                  <th>Member ID</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) =>
                  editingUser === u.memberId && userDraft ? (
                    <tr key={u.memberId}>
                      <td>
                        <input
                          value={userDraft.name}
                          onChange={(e) => setUserDraft({ ...userDraft, name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          value={userDraft.kids.join(", ")}
                          onChange={(e) =>
                            setUserDraft({
                              ...userDraft,
                              kids: e.target.value.split(",").map((k) => k.trim()).filter(Boolean),
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={userDraft.seats}
                          onChange={(e) => setUserDraft({ ...userDraft, seats: Number(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          value={userDraft.street}
                          onChange={(e) => setUserDraft({ ...userDraft, street: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          value={userDraft.zip}
                          onChange={(e) => setUserDraft({ ...userDraft, zip: e.target.value })}
                        />
                      </td>
                      <td className="admin-mono">{u.memberId}</td>
                      <td>
                        <button onClick={saveUser}>Save</button>{" "}
                        <button onClick={() => setEditingUser(null)}>Cancel</button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={u.memberId}>
                      <td>{u.name}</td>
                      <td>{u.kids?.join(", ") || "—"}</td>
                      <td>{u.seats}</td>
                      <td>{u.street || "—"}</td>
                      <td>{u.zip || "—"}</td>
                      <td className="admin-mono">{u.memberId}</td>
                      <td>
                        <button onClick={() => startEditUser(u)}>Edit</button>{" "}
                        <button onClick={() => deleteUser(u.memberId)}>Delete</button>
                      </td>
                    </tr>
                  )
                )}
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {carpools.map((c) =>
                  editingCarpool === c.code && carpoolDraft ? (
                    <tr key={c.code}>
                      <td>
                        <input
                          value={carpoolDraft.name}
                          onChange={(e) => setCarpoolDraft({ ...carpoolDraft, name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          value={carpoolDraft.day}
                          onChange={(e) => setCarpoolDraft({ ...carpoolDraft, day: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="Street"
                          value={carpoolDraft.destination?.street ?? ""}
                          onChange={(e) =>
                            setCarpoolDraft({
                              ...carpoolDraft,
                              destination: { street: e.target.value, zip: carpoolDraft.destination?.zip ?? "" },
                            })
                          }
                        />
                        <input
                          placeholder="Zip"
                          value={carpoolDraft.destination?.zip ?? ""}
                          onChange={(e) =>
                            setCarpoolDraft({
                              ...carpoolDraft,
                              destination: { street: carpoolDraft.destination?.street ?? "", zip: e.target.value },
                            })
                          }
                        />
                      </td>
                      <td>{c.dropOff?.time || "—"}</td>
                      <td>{c.pickUp?.time || "—"}</td>
                      <td>{c.members.map((m) => m.name).join(", ")}</td>
                      <td className="admin-mono">{c.code}</td>
                      <td>
                        <button onClick={saveCarpool}>Save</button>{" "}
                        <button onClick={() => setEditingCarpool(null)}>Cancel</button>
                      </td>
                    </tr>
                  ) : (
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
                      <td>
                        {c.members.map((m) => (
                          <span key={m.id} className="admin-member-chip">
                            {m.name}{" "}
                            <button
                              className="admin-chip-remove"
                              title="Remove from carpool"
                              onClick={() => removeMember(c.code, m.id)}
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                      </td>
                      <td className="admin-mono">{c.code}</td>
                      <td>
                        <button onClick={() => startEditCarpool(c)}>Edit</button>{" "}
                        <button onClick={() => deleteCarpool(c.code)}>Delete</button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
