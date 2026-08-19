import { useEffect, useState, type FormEvent, type ReactNode } from "react";

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

function CopyableCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="admin-mono admin-copy-code" onClick={copy} title="Click to copy">
      {copied ? "Copied!" : value}
    </button>
  );
}

function SidePanel({
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
    <div className="admin-panel-backdrop" onClick={onClose}>
      <div className="admin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="admin-panel-header">
          <h3>{title}</h3>
          <button type="button" className="admin-panel-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="admin-panel-body">{children}</div>
        {footer && <div className="admin-panel-footer">{footer}</div>}
      </div>
    </div>
  );
}

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
  const [savingUser, setSavingUser] = useState(false);
  const startEditUser = (u: AdminUser) => {
    setEditingUser(u.memberId);
    setUserDraft({ ...u });
  };
  const saveUser = async () => {
    if (!userDraft) return;
    setSavingUser(true);
    try {
      await callAdmin("updateUser", {
        memberId: userDraft.memberId,
        name: userDraft.name,
        seats: Number(userDraft.seats) || 0,
        kids: userDraft.kids,
        street: userDraft.street,
        zip: userDraft.zip,
      });
      setEditingUser(null);
    } finally {
      setSavingUser(false);
    }
  };
  const deleteUser = async (memberId: string) => {
    if (!confirm("Delete this user? This removes them from any carpools too.")) return;
    await callAdmin("deleteUser", { memberId });
  };

  const [editingCarpool, setEditingCarpool] = useState<string | null>(null);
  const [carpoolDraft, setCarpoolDraft] = useState<AdminCarpool | null>(null);
  const [savingCarpool, setSavingCarpool] = useState(false);
  const startEditCarpool = (c: AdminCarpool) => {
    setEditingCarpool(c.code);
    setCarpoolDraft({ ...c, destination: { ...(c.destination ?? { street: "", zip: "" }) } });
    setAddMemberSelection("");
  };
  const saveCarpool = async () => {
    if (!carpoolDraft) return;
    setSavingCarpool(true);
    try {
      await callAdmin("updateCarpool", {
        code: carpoolDraft.code,
        name: carpoolDraft.name,
        day: carpoolDraft.day,
        destination: carpoolDraft.destination,
      });
      setEditingCarpool(null);
    } finally {
      setSavingCarpool(false);
    }
  };
  const deleteCarpool = async (code: string) => {
    if (!confirm("Delete this carpool entirely?")) return;
    await callAdmin("deleteCarpool", { code });
    setEditingCarpool(null);
  };
  const removeMember = async (code: string, memberId: string) => {
    if (!confirm("Remove this member from the carpool?")) return;
    await callAdmin("removeMember", { code, memberId });
  };

  const [addMemberSelection, setAddMemberSelection] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const addMember = async (code: string) => {
    if (!addMemberSelection) return;
    setAddingMember(true);
    try {
      await callAdmin("addMember", { code, memberId: addMemberSelection });
      setAddMemberSelection("");
    } finally {
      setAddingMember(false);
    }
  };

  // The panel's carpool data needs to reflect the latest load (e.g. after
  // adding/removing a member), not the stale snapshot captured when it opened.
  const liveEditingCarpool = editingCarpool ? carpools.find((c) => c.code === editingCarpool) : null;

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
                {users.map((u) => (
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {carpools.map((c) => (
                  <tr key={c.code}>
                    <td>{c.name}</td>
                    <td>{c.day ?? "—"}</td>
                    <td>
                      {c.destination?.street ? `${c.destination.street}, ${c.destination.zip}` : "—"}
                    </td>
                    <td>{c.dropOff?.time || "—"}</td>
                    <td>{c.pickUp?.time || "—"}</td>
                    <td>
                      {c.members.length > 0 ? (
                        <div className="admin-member-list">
                          {c.members.map((m) => (
                            <div key={m.id}>{m.name}</div>
                          ))}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <CopyableCode value={c.code} />
                    </td>
                    <td>
                      <button onClick={() => startEditCarpool(c)}>Edit</button>{" "}
                      <button onClick={() => deleteCarpool(c.code)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </main>

      <SidePanel
        open={editingUser !== null}
        onClose={() => setEditingUser(null)}
        title="Edit user"
        footer={
          <>
            <button onClick={saveUser} disabled={savingUser}>
              {savingUser ? "Saving..." : "Save"}
            </button>{" "}
            <button onClick={() => setEditingUser(null)}>Cancel</button>
          </>
        }
      >
        {userDraft && (
          <div className="admin-panel-form">
            <label>
              Name
              <input
                value={userDraft.name}
                onChange={(e) => setUserDraft({ ...userDraft, name: e.target.value })}
              />
            </label>
            <label>
              Kids (comma separated)
              <input
                value={userDraft.kids.join(", ")}
                onChange={(e) =>
                  setUserDraft({
                    ...userDraft,
                    kids: e.target.value.split(",").map((k) => k.trim()).filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              Seats
              <input
                type="number"
                value={userDraft.seats}
                onChange={(e) => setUserDraft({ ...userDraft, seats: Number(e.target.value) })}
              />
            </label>
            <label>
              Street
              <input
                value={userDraft.street}
                onChange={(e) => setUserDraft({ ...userDraft, street: e.target.value })}
              />
            </label>
            <label>
              Zip
              <input
                value={userDraft.zip}
                onChange={(e) => setUserDraft({ ...userDraft, zip: e.target.value })}
              />
            </label>
            <p className="admin-mono">{userDraft.memberId}</p>
          </div>
        )}
      </SidePanel>

      <SidePanel
        open={editingCarpool !== null}
        onClose={() => setEditingCarpool(null)}
        title="Edit carpool"
        footer={
          <>
            <button onClick={saveCarpool} disabled={savingCarpool}>
              {savingCarpool ? "Saving..." : "Save"}
            </button>{" "}
            <button onClick={() => setEditingCarpool(null)}>Cancel</button>
          </>
        }
      >
        {carpoolDraft && liveEditingCarpool && (
          <div className="admin-panel-form">
            <label>
              Name
              <input
                value={carpoolDraft.name}
                onChange={(e) => setCarpoolDraft({ ...carpoolDraft, name: e.target.value })}
              />
            </label>
            <label>
              Day
              <input
                value={carpoolDraft.day}
                onChange={(e) => setCarpoolDraft({ ...carpoolDraft, day: e.target.value })}
              />
            </label>
            <label>
              Destination street
              <input
                value={carpoolDraft.destination?.street ?? ""}
                onChange={(e) =>
                  setCarpoolDraft({
                    ...carpoolDraft,
                    destination: { street: e.target.value, zip: carpoolDraft.destination?.zip ?? "" },
                  })
                }
              />
            </label>
            <label>
              Destination zip
              <input
                value={carpoolDraft.destination?.zip ?? ""}
                onChange={(e) =>
                  setCarpoolDraft({
                    ...carpoolDraft,
                    destination: { street: carpoolDraft.destination?.street ?? "", zip: e.target.value },
                  })
                }
              />
            </label>
            <p>
              <CopyableCode value={carpoolDraft.code} />
            </p>

            <div className="admin-panel-members">
              <h4>Members</h4>
              {liveEditingCarpool.members.map((m) => (
                <span key={m.id} className="admin-member-chip">
                  {m.name}{" "}
                  <button
                    className="admin-chip-remove"
                    title="Remove from carpool"
                    onClick={() => removeMember(liveEditingCarpool.code, m.id)}
                  >
                    &times;
                  </button>
                </span>
              ))}
              <div className="admin-add-member-row">
                <select value={addMemberSelection} onChange={(e) => setAddMemberSelection(e.target.value)}>
                  <option value="">Add user...</option>
                  {users
                    .filter((u) => !liveEditingCarpool.members.some((m) => m.id === u.memberId))
                    .map((u) => (
                      <option key={u.memberId} value={u.memberId}>
                        {u.name}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => addMember(liveEditingCarpool.code)}
                  disabled={!addMemberSelection || addingMember}
                >
                  {addingMember ? "Adding..." : "Add"}
                </button>
              </div>
            </div>
          </div>
        )}
      </SidePanel>
    </div>
  );
}
