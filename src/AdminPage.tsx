import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { computeKidDefaults, resolveKidDrivers } from "./carpoolSummary";

const KEY_STORAGE = "blisspool:admin-key";

type AdminUser = {
  memberId: string;
  name: string;
  kids: string[];
  street: string;
  zip: string;
  coParentId?: string | null;
  coParentName?: string | null;
  householdCombined?: boolean;
};

type AdminMember = {
  id: string;
  name: string;
  kids: string[];
  canDriveDropOff: boolean;
  canDrivePickUp: boolean;
};
type AdminCarpool = {
  code: string;
  name: string;
  day: string;
  destination?: { street: string; zip: string };
  dropOff?: { time: string; cars: { driverId: string; kids: string[]; seats: number }[] };
  pickUp?: { time: string; cars: { driverId: string; kids: string[]; seats: number }[] };
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

// Ranks a name against a typed query by which "word" of the name matches
// first: a match on the first word (usually a first name) outranks a match
// on a later word (usually a last name), and both outrank a plain substring
// hit elsewhere in the name. Returns null when nothing matches at all.
function rankNameMatch(name: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words[0].startsWith(q)) return 0;
  if (words.slice(1).some((w) => w.startsWith(q))) return 1;
  return null;
}

// Filters + orders a list by the same word-match ranking NameAutosuggest
// uses, so table search behaves consistently with the lookup dropdowns.
function filterByName<T>(items: T[], query: string, getName: (item: T) => string): T[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map((item) => ({ item, rank: rankNameMatch(getName(item), q) }))
    .filter((r): r is { item: T; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || getName(a.item).localeCompare(getName(b.item)))
    .map((r) => r.item);
}

// Mirrors rankNameMatch: only a match at the start of a word (first name,
// last name, etc.) counts — a query that merely appears mid-word doesn't
// match at all, so it shouldn't get highlighted either.
function findWordStartMatches(name: string, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const lower = name.toLowerCase();
  const indices: number[] = [];
  let from = 0;
  while (from <= lower.length - q.length) {
    const found = lower.indexOf(q, from);
    if (found === -1) break;
    if (found === 0 || /\s/.test(lower[found - 1])) indices.push(found);
    from = found + 1;
  }
  return indices;
}

function HighlightedName({ name, query }: { name: string; query: string }) {
  const q = query.trim();
  const matches = findWordStartMatches(name, q);
  if (matches.length === 0) return <>{name}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((idx, i) => {
    parts.push(name.slice(cursor, idx));
    parts.push(<strong key={i}>{name.slice(idx, idx + q.length)}</strong>);
    cursor = idx + q.length;
  });
  parts.push(name.slice(cursor));
  return <>{parts}</>;
}

function NameAutosuggest({
  options,
  value,
  onChange,
  placeholder,
  allowClear,
  clearLabel = "Unassigned",
}: {
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  clearLabel?: string;
}) {
  const selected = options.find((o) => o.id === value);
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync with the selected option when it changes
  // from outside (e.g. reset after a save) — but not while the dropdown is
  // open and the user is mid-search.
  useEffect(() => {
    if (!open) setQuery(selected?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selected?.name ?? "");
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, selected]);

  const ranked = options
    .map((o) => ({ o, rank: rankNameMatch(o.name, query) }))
    .filter((r): r is { o: { id: string; name: string }; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.o.name.localeCompare(b.o.name))
    .map((r) => r.o);

  const commit = (id: string, name: string) => {
    onChange(id);
    setQuery(name);
    setOpen(false);
  };

  return (
    <div className="admin-autosuggest" ref={containerRef}>
      <input
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, ranked.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const pick = ranked[highlight];
            if (pick) commit(pick.id, pick.name);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery(selected?.name ?? "");
          }
        }}
      />
      {open && (
        <ul className="admin-autosuggest-list">
          {allowClear && (
            <li
              className={value === "" ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                commit("", "");
              }}
            >
              {clearLabel}
            </li>
          )}
          {ranked.length === 0 ? (
            <li className="admin-autosuggest-empty">No matches</li>
          ) : (
            ranked.map((o, i) => (
              <li
                key={o.id}
                className={i === highlight ? "active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(o.id, o.name);
                }}
              >
                <HighlightedName name={o.name} query={query} />
              </li>
            ))
          )}
        </ul>
      )}
    </div>
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

function LegAssignments({
  carpool,
  leg,
  label,
  onMoveKid,
}: {
  carpool: AdminCarpool;
  leg: "dropOff" | "pickUp";
  label: string;
  onMoveKid: (kid: string, driverId: string | null) => void;
}) {
  const legData = leg === "dropOff" ? carpool.dropOff : carpool.pickUp;
  const cars = legData?.cars ?? [];
  const drivers = carpool.members.filter((m) => (leg === "dropOff" ? m.canDriveDropOff : m.canDrivePickUp));
  const allKids = Array.from(new Set(carpool.members.flatMap((m) => m.kids))).sort((a, b) =>
    a.localeCompare(b)
  );
  const driverFor = (kid: string) => cars.find((c) => c.kids.includes(kid))?.driverId ?? "";
  const parentOf = (kid: string) => carpool.members.find((m) => m.kids.includes(kid))?.name ?? "";

  return (
    <div className="admin-panel-leg-assignments">
      <h4>{label} cars</h4>
      {allKids.length === 0 ? (
        <p className="admin-muted">No kids in this carpool.</p>
      ) : drivers.length === 0 ? (
        <p className="admin-muted">No one can drive {label.toLowerCase()} yet.</p>
      ) : (
        <table className="admin-table admin-driving-table">
          <thead>
            <tr>
              <th>Kid</th>
              <th>Rides with</th>
            </tr>
          </thead>
          <tbody>
            {allKids.map((kid) => {
              // A kid with no explicit car still has a default ride: their
              // own parent, if that parent is driving this leg — the picker
              // should say so instead of showing a bare "Unassigned".
              const defaultLabel = `${parentOf(kid)} (default)`;
              return (
                <tr key={kid}>
                  <td>
                    <div className="admin-kid-cell">
                      <strong>{kid}</strong>
                      <span className="admin-kid-parent">{parentOf(kid)}</span>
                    </div>
                  </td>
                  <td>
                    <NameAutosuggest
                      options={drivers}
                      value={driverFor(kid)}
                      onChange={(id) => onMoveKid(kid, id || null)}
                      placeholder={defaultLabel}
                      allowClear
                      clearLabel={defaultLabel}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LegAssignmentsByParent({
  carpool,
  leg,
  label,
  onMoveKid,
}: {
  carpool: AdminCarpool;
  leg: "dropOff" | "pickUp";
  label: string;
  onMoveKid: (kid: string, driverId: string | null) => void;
}) {
  const legData = leg === "dropOff" ? carpool.dropOff : carpool.pickUp;
  const cars = legData?.cars ?? [];
  const drivers = carpool.members.filter((m) => (leg === "dropOff" ? m.canDriveDropOff : m.canDrivePickUp));
  const allKids = Array.from(new Set(carpool.members.flatMap((m) => m.kids))).sort((a, b) =>
    a.localeCompare(b)
  );
  const kidDefaults = computeKidDefaults(carpool.members);
  const kidToDriver = resolveKidDrivers(cars, carpool.members, kidDefaults);

  return (
    <div className="admin-panel-leg-assignments">
      <h4>{label} cars</h4>
      {drivers.length === 0 ? (
        <p className="admin-muted">No one can drive {label.toLowerCase()} yet.</p>
      ) : (
        <div className="admin-car-list">
          {drivers.map((d) => {
            const isExplicit = cars.some((c) => c.driverId === d.id);
            const kids = allKids
              .filter((k) => kidToDriver.get(k) === d.id)
              .slice()
              .sort((a, b) => a.localeCompare(b));
            const addOptions = allKids
              .filter((k) => kidToDriver.get(k) !== d.id)
              .map((k) => ({ id: k, name: k }));
            return (
              <div className="admin-car-card" key={d.id}>
                <div className="admin-car-card-header">{d.name}</div>
                <div className="admin-car-card-kids">
                  {kids.length === 0 ? (
                    <span className="admin-muted">Nobody</span>
                  ) : (
                    kids.map((k) => {
                      const isDefault = !isExplicit;
                      return (
                        <span className="admin-member-chip" key={k}>
                          {k}
                          {isDefault && <span className="admin-muted"> (default)</span>}{" "}
                          <button
                            type="button"
                            className="admin-chip-remove"
                            title="Unassign"
                            onClick={() => onMoveKid(k, null)}
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })
                  )}
                </div>
                {addOptions.length > 0 && (
                  <NameAutosuggest
                    key={`add-${leg}-${d.id}-${kids.length}`}
                    options={addOptions}
                    value=""
                    onChange={(kid) => {
                      if (kid) onMoveKid(kid, d.id);
                    }}
                    placeholder="Add kid..."
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
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

  const [newUser, setNewUser] = useState({ name: "", kids: "", street: "", zip: "" });
  const [addingUser, setAddingUser] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const openAddUser = () => {
    setNewUser({ name: "", kids: "", street: "", zip: "" });
    setAddUserOpen(true);
  };
  const createUser = async () => {
    if (!newUser.name.trim()) return;
    setAddingUser(true);
    try {
      await callAdmin("createUser", {
        name: newUser.name.trim(),
        kids: newUser.kids.split(",").map((k) => k.trim()).filter(Boolean),
        street: newUser.street,
        zip: newUser.zip,
      });
      setAddUserOpen(false);
    } finally {
      setAddingUser(false);
    }
  };

  const [userSearch, setUserSearch] = useState("");
  const [carpoolSearch, setCarpoolSearch] = useState("");

  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState<AdminUser | null>(null);
  const [savingUser, setSavingUser] = useState(false);
  const startEditUser = (u: AdminUser) => {
    setEditingUser(u.memberId);
    setUserDraft({ ...u });
    setCoParentSelection("");
  };
  const saveUser = async () => {
    if (!userDraft) return;
    setSavingUser(true);
    try {
      await callAdmin("updateUser", {
        memberId: userDraft.memberId,
        name: userDraft.name,
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

  const [coParentSelection, setCoParentSelection] = useState("");
  const [linkingCoParent, setLinkingCoParent] = useState(false);
  const linkCoParent = async (memberId: string) => {
    if (!coParentSelection) return;
    setLinkingCoParent(true);
    try {
      await callAdmin("linkCoParents", { memberId, coParentId: coParentSelection });
      setCoParentSelection("");
    } finally {
      setLinkingCoParent(false);
    }
  };
  const unlinkCoParent = async (memberId: string) => {
    if (!confirm("Unlink this co-parent household?")) return;
    await callAdmin("unlinkCoParents", { memberId });
  };
  const setHouseholdCombined = (memberId: string, combined: boolean) =>
    callAdmin("setHouseholdCombined", { memberId, combined });

  const [editingCarpool, setEditingCarpool] = useState<string | null>(null);
  const [carpoolDraft, setCarpoolDraft] = useState<AdminCarpool | null>(null);
  const [savingCarpool, setSavingCarpool] = useState(false);
  const [legTab, setLegTab] = useState<"dropOff" | "pickUp">("dropOff");
  const [legViewMode, setLegViewMode] = useState<"kid" | "parent">("kid");
  const startEditCarpool = (c: AdminCarpool) => {
    setEditingCarpool(c.code);
    setCarpoolDraft({
      ...c,
      destination: { ...(c.destination ?? { street: "", zip: "" }) },
      dropOff: { time: c.dropOff?.time ?? "", cars: c.dropOff?.cars ?? [] },
      pickUp: { time: c.pickUp?.time ?? "", cars: c.pickUp?.cars ?? [] },
    });
    setAddMemberSelection("");
    setLegTab("dropOff");
    setLegViewMode("kid");
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
        dropOffTime: carpoolDraft.dropOff?.time ?? "",
        pickUpTime: carpoolDraft.pickUp?.time ?? "",
      });
      setEditingCarpool(null);
    } finally {
      setSavingCarpool(false);
    }
  };
  const setMemberDriving = (code: string, memberId: string, leg: "dropOff" | "pickUp", value: boolean) =>
    callAdmin("setMemberDriving", { code, memberId, leg, value });
  const moveKid = (code: string, leg: "dropOff" | "pickUp", kid: string, driverId: string | null) =>
    callAdmin("moveKid", { code, leg, kid, driverId });
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
  // Same idea for the user panel: co-parent link/unlink/combine happen
  // immediately, so the panel needs the freshly reloaded user, not the
  // snapshot captured when it opened.
  const liveEditingUser = editingUser ? users.find((u) => u.memberId === editingUser) : null;
  const userCarpools = liveEditingUser
    ? carpools.filter((c) => c.members.some((m) => m.id === liveEditingUser.memberId))
    : [];

  const filteredUsers = filterByName(users, userSearch, (u) => u.name);
  const filteredCarpools = filterByName(carpools, carpoolSearch, (c) => c.name);

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
          <>
            <div className="admin-list-toolbar">
              <input
                type="search"
                className="admin-search-input"
                placeholder="Search users..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
              <button type="button" onClick={openAddUser}>
                + Add user
              </button>
            </div>
            <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kids</th>
                  <th>Street</th>
                  <th>Zip</th>
                  <th>Member ID</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.memberId} className="admin-row-clickable" onClick={() => startEditUser(u)}>
                    <td><HighlightedName name={u.name} query={userSearch} /></td>
                    <td>{u.kids?.join(", ") || "—"}</td>
                    <td>{u.street || "—"}</td>
                    <td>{u.zip || "—"}</td>
                    <td className="admin-mono">{u.memberId}</td>
                    <td>
                      <button onClick={(e) => { e.stopPropagation(); deleteUser(u.memberId); }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}

        {!loading && tab === "carpools" && (
          <>
            <div className="admin-list-toolbar">
              <input
                type="search"
                className="admin-search-input"
                placeholder="Search carpools..."
                value={carpoolSearch}
                onChange={(e) => setCarpoolSearch(e.target.value)}
              />
            </div>
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
                {filteredCarpools.map((c) => (
                  <tr key={c.code} className="admin-row-clickable" onClick={() => startEditCarpool(c)}>
                    <td><HighlightedName name={c.name} query={carpoolSearch} /></td>
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <CopyableCode value={c.code} />
                    </td>
                    <td>
                      <button onClick={(e) => { e.stopPropagation(); deleteCarpool(c.code); }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
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

            {liveEditingUser && (
              <div className="admin-panel-carpools">
                <h4>Carpools</h4>
                {userCarpools.length === 0 ? (
                  <p className="admin-muted">Not in any carpools.</p>
                ) : (
                  <div className="admin-user-carpool-list">
                    {userCarpools.map((c) => (
                      <button
                        type="button"
                        key={c.code}
                        className="admin-user-carpool-row"
                        onClick={() => {
                          setEditingUser(null);
                          startEditCarpool(c);
                        }}
                      >
                        <span>{c.name}</span>
                        <span className="admin-muted">{c.day || "No day set"}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {liveEditingUser && (
              <div className="admin-panel-household">
                <h4>Co-parent household</h4>
                {liveEditingUser.coParentId ? (
                  <>
                    <p>
                      Linked with <strong>{liveEditingUser.coParentName ?? "Unknown"}</strong>
                    </p>
                    <label className="admin-checkbox-label">
                      <input
                        type="checkbox"
                        checked={liveEditingUser.householdCombined ?? false}
                        onChange={() =>
                          setHouseholdCombined(
                            liveEditingUser.memberId,
                            !(liveEditingUser.householdCombined ?? false)
                          )
                        }
                      />
                      Drives as one combined household
                    </label>
                    <button type="button" onClick={() => unlinkCoParent(liveEditingUser.memberId)}>
                      Unlink
                    </button>
                  </>
                ) : (
                  <div className="admin-add-member-row">
                    <NameAutosuggest
                      options={users
                        .filter((u) => u.memberId !== liveEditingUser.memberId)
                        .map((u) => ({ id: u.memberId, name: u.name }))}
                      value={coParentSelection}
                      onChange={setCoParentSelection}
                      placeholder="Link to user..."
                    />
                    <button
                      type="button"
                      onClick={() => linkCoParent(liveEditingUser.memberId)}
                      disabled={!coParentSelection || linkingCoParent}
                    >
                      {linkingCoParent ? "Linking..." : "Link"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </SidePanel>

      <SidePanel
        open={addUserOpen}
        onClose={() => setAddUserOpen(false)}
        title="Add user"
        footer={
          <>
            <button onClick={createUser} disabled={addingUser || !newUser.name.trim()}>
              {addingUser ? "Adding..." : "Create"}
            </button>{" "}
            <button onClick={() => setAddUserOpen(false)}>Cancel</button>
          </>
        }
      >
        <div className="admin-panel-form">
          <label>
            Name
            <input
              value={newUser.name}
              onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              autoFocus
            />
          </label>
          <label>
            Kids (comma separated)
            <input
              value={newUser.kids}
              onChange={(e) => setNewUser({ ...newUser, kids: e.target.value })}
            />
          </label>
          <label>
            Street
            <input
              value={newUser.street}
              onChange={(e) => setNewUser({ ...newUser, street: e.target.value })}
            />
          </label>
          <label>
            Zip
            <input value={newUser.zip} onChange={(e) => setNewUser({ ...newUser, zip: e.target.value })} />
          </label>
        </div>
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
            <div className="admin-form-row">
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
                Drop-off time
                <input
                  type="time"
                  value={carpoolDraft.dropOff?.time ?? ""}
                  onChange={(e) =>
                    setCarpoolDraft({
                      ...carpoolDraft,
                      dropOff: { time: e.target.value, cars: carpoolDraft.dropOff?.cars ?? [] },
                    })
                  }
                />
              </label>
              <label>
                Pick-up time
                <input
                  type="time"
                  value={carpoolDraft.pickUp?.time ?? ""}
                  onChange={(e) =>
                    setCarpoolDraft({
                      ...carpoolDraft,
                      pickUp: { time: e.target.value, cars: carpoolDraft.pickUp?.cars ?? [] },
                    })
                  }
                />
              </label>
            </div>
            <div className="admin-form-row">
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
            </div>
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
                <NameAutosuggest
                  options={users
                    .filter((u) => !liveEditingCarpool.members.some((m) => m.id === u.memberId))
                    .map((u) => ({ id: u.memberId, name: u.name }))}
                  value={addMemberSelection}
                  onChange={setAddMemberSelection}
                  placeholder="Add user..."
                />
                <button
                  onClick={() => addMember(liveEditingCarpool.code)}
                  disabled={!addMemberSelection || addingMember}
                >
                  {addingMember ? "Adding..." : "Add"}
                </button>
              </div>
            </div>

            <div className="admin-panel-driving">
              <h4>Who can drive</h4>
              <table className="admin-table admin-driving-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Drop-off</th>
                    <th>Pick-up</th>
                  </tr>
                </thead>
                <tbody>
                  {liveEditingCarpool.members.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={m.canDriveDropOff}
                          onChange={() =>
                            setMemberDriving(liveEditingCarpool.code, m.id, "dropOff", !m.canDriveDropOff)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={m.canDrivePickUp}
                          onChange={() =>
                            setMemberDriving(liveEditingCarpool.code, m.id, "pickUp", !m.canDrivePickUp)
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="admin-leg-tabs-row">
              <div className="admin-leg-tabs">
                <button
                  type="button"
                  className={legTab === "dropOff" ? "active" : ""}
                  onClick={() => setLegTab("dropOff")}
                >
                  Drop-off
                </button>
                <button
                  type="button"
                  className={legTab === "pickUp" ? "active" : ""}
                  onClick={() => setLegTab("pickUp")}
                >
                  Pick-up
                </button>
              </div>
              <div className="admin-leg-tabs admin-leg-view-tabs">
                <button
                  type="button"
                  className={legViewMode === "kid" ? "active" : ""}
                  onClick={() => setLegViewMode("kid")}
                >
                  By kid
                </button>
                <button
                  type="button"
                  className={legViewMode === "parent" ? "active" : ""}
                  onClick={() => setLegViewMode("parent")}
                >
                  By parent
                </button>
              </div>
            </div>
            {legViewMode === "kid" ? (
              <LegAssignments
                carpool={liveEditingCarpool}
                leg={legTab}
                label={legTab === "dropOff" ? "Drop-off" : "Pick-up"}
                onMoveKid={(kid, driverId) => moveKid(liveEditingCarpool.code, legTab, kid, driverId)}
              />
            ) : (
              <LegAssignmentsByParent
                carpool={liveEditingCarpool}
                leg={legTab}
                label={legTab === "dropOff" ? "Drop-off" : "Pick-up"}
                onMoveKid={(kid, driverId) => moveKid(liveEditingCarpool.code, legTab, kid, driverId)}
              />
            )}
          </div>
        )}
      </SidePanel>
    </div>
  );
}
