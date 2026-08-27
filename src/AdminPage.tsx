import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { computeKidDefaults, resolveKidDrivers } from "./carpoolSummary";
import { AdminDatavizPanel, DATAVIZ_TABS, type DatavizTab } from "./AdminDataviz";
import {
  COMMON_TIMEZONES,
  DAYS_OF_WEEK,
  currentEra,
  detectTimezone,
  pickRepresentativeOccurrence,
  todayISO,
  toCarpoolView,
  type CarpoolOccurrence,
  type CarpoolSeries,
  type DayOfWeek,
  type RecurrenceType,
} from "./types";

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
  coParentCode?: string | null;
  isTestAccount?: boolean;
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
  timezone: string;
  recurrenceType: RecurrenceType;
  daysOfWeek: DayOfWeek[];
  eraStartDate: string;
};

type AdminUpdate = { id: string; text: string; createdAt: number };

// The admin GET now returns CarpoolSeries + CarpoolOccurrence separately —
// converted back into the flat AdminCarpool shape (the series' nearest
// upcoming occurrence's dropOff/pickUp, plus the series' current era's
// recurrence fields) at this one fetch boundary, so every existing admin
// edit/view below keeps working unchanged against "the current schedule,"
// same as it did when that shape came straight off the wire.
function toAdminCarpools(series: CarpoolSeries[], occurrences: CarpoolOccurrence[]): AdminCarpool[] {
  const byCode = new Map<string, CarpoolOccurrence[]>();
  for (const o of occurrences) {
    if (!byCode.has(o.code)) byCode.set(o.code, []);
    byCode.get(o.code)!.push(o);
  }
  return series.map((s) => {
    const view = toCarpoolView(s, pickRepresentativeOccurrence(byCode.get(s.code) ?? []));
    const era = currentEra(s);
    return { ...view, timezone: s.timezone, recurrenceType: era.type, daysOfWeek: era.daysOfWeek, eraStartDate: era.startDate };
  });
}

// Mirrors CarpoolDetail's LegToggleRow: seats double as the driving toggle
// (0 = not driving this leg, 1+ = driving with that many free seats), so
// admin edits the same one number the real app writes instead of a separate
// checkbox that only ever set seats to a hardcoded 1.
function SeatStepper({ seats, onChange }: { seats: number; onChange: (seats: number) => void }) {
  return (
    <span className="seat-stepper-compact">
      <button type="button" onClick={() => onChange(Math.max(0, seats - 1))} disabled={seats === 0} aria-label="Fewer seats">
        &minus;
      </button>
      <span className="seat-count">{seats}</span>
      <button type="button" onClick={() => onChange(Math.min(8, seats + 1))} disabled={seats >= 8} aria-label="More seats">
        +
      </button>
    </span>
  );
}

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

// Ranks a value's match quality against a query: a word-start hit (e.g.
// matching "Hol" in "Holtaway") outranks a plain mid-word substring hit,
// and no match at all returns null. Case-insensitive.
function fieldMatchQuality(value: string, query: string): 0 | 1 | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (!lower.includes(query)) return null;
  const words = lower.split(/\s+/).filter(Boolean);
  return words.some((w) => w.startsWith(query)) ? 0 : 1;
}

// Table search spans every visible column, but ranks hits by field
// priority first (e.g. a name match always outranks an address match)
// and match quality second (word-start beats mid-word substring) — so
// the most identifying field wins ties within the same priority tier.
function rankFields(fields: { value: string; priority: number }[], query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best: number | null = null;
  for (const { value, priority } of fields) {
    const quality = fieldMatchQuality(value, q);
    if (quality === null) continue;
    const rank = priority * 2 + quality;
    if (best === null || rank < best) best = rank;
  }
  return best;
}

function findSubstringMatches(value: string, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const lower = value.toLowerCase();
  const indices: number[] = [];
  let from = 0;
  while (from <= lower.length - q.length) {
    const found = lower.indexOf(q, from);
    if (found === -1) break;
    indices.push(found);
    from = found + q.length;
  }
  return indices;
}

// Like HighlightedName, but highlights any substring match (not just
// word-start ones), since table search now matches mid-word too.
function HighlightedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const matches = findSubstringMatches(text, q);
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((idx, i) => {
    parts.push(text.slice(cursor, idx));
    parts.push(<mark key={i} className="admin-search-match">{text.slice(idx, idx + q.length)}</mark>);
    cursor = idx + q.length;
  });
  parts.push(text.slice(cursor));
  return <>{parts}</>;
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
    parts.push(<mark key={i} className="admin-search-match">{name.slice(idx, idx + q.length)}</mark>);
    cursor = idx + q.length;
  });
  parts.push(name.slice(cursor));
  return <>{parts}</>;
}

// A small chain-link icon marking a kid as shared between parents, with
// every parent's name (this row's parent included) in the hover tooltip —
// e.g. "Spencer Holtaway & Lindsey Holtaway" — instead of a text suffix.
function CoParentLink({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <span className="admin-coparent-link" title={names.join(" & ")}>
      🔗
    </span>
  );
}

// Groups users into households by the confirmed co-parent link only
// (coParentId, set via the "Link" action in the edit panel) — not by
// merely sharing a kid name, since that's just a hint for an admin to
// notice and confirm, not proof the two users are actually the same
// household. coParentId is a single pairwise link, so groups are only
// ever size 1 or 2.
function groupUsersByCoParent(users: AdminUser[]): AdminUser[][] {
  const byId = new Map(users.map((u) => [u.memberId, u]));
  const seen = new Set<string>();
  const groups: AdminUser[][] = [];
  users.forEach((u) => {
    if (seen.has(u.memberId)) return;
    seen.add(u.memberId);
    const partner = u.coParentId ? byId.get(u.coParentId) : undefined;
    if (partner && !seen.has(partner.memberId)) {
      seen.add(partner.memberId);
      groups.push([u, partner]);
    } else {
      groups.push([u]);
    }
  });
  return groups;
}

function combinedKids(group: AdminUser[]): string[] {
  return Array.from(new Set(group.flatMap((u) => u.kids ?? [])));
}

// Sort key for "last name alphabetical" default ordering — the last
// whitespace-separated word of the name, so "Spencer Holtaway" sorts under H.
function lastNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words[words.length - 1] ?? name).toLowerCase();
}

function formatAddress(u: AdminUser): string {
  if (!u.street && !u.zip) return "—";
  return [u.street, u.zip].filter(Boolean).join(", ");
}

// Co-parents usually share one address, but not always (e.g. divorced
// co-parents each with their own place) — so collapse to a single line
// only when every member's address actually matches, otherwise show each
// member's own address on its own line, in the same order as their name.
function groupAddressLines(group: AdminUser[]): string[] {
  const addresses = group.map((u) => `${u.street}||${u.zip}`);
  const allSame = addresses.every((a) => a === addresses[0]);
  return allSame ? [formatAddress(group[0])] : group.map(formatAddress);
}

type TestAccountFilter = "all" | "test" | "real";

// A group counts as a "test" group if any member in it is flagged — a
// household with a real co-parent and a test co-parent is rare enough that
// erring toward showing it under "Test" (rather than hiding it) is the
// safer default for an admin scanning for accounts to clean up.
function groupIsTestAccount(group: AdminUser[]): boolean {
  return group.some((u) => u.isTestAccount);
}

function matchesTestAccountFilter(group: AdminUser[], filter: TestAccountFilter): boolean {
  if (filter === "all") return true;
  return groupIsTestAccount(group) === (filter === "test");
}

// Users tab: match spans name, kids, and address, in that priority order,
// so a hit on name always outranks a hit on kids, which always outranks a
// hit on address — the most identifying field decides the sort order. With
// no search text, groups default to last-name-alphabetical order instead of
// whatever order the server happened to return them in.
function filterUserGroups(
  groups: AdminUser[][],
  query: string,
  testFilter: TestAccountFilter = "all"
): AdminUser[][] {
  const filtered = groups.filter((group) => matchesTestAccountFilter(group, testFilter));
  const q = query.trim();
  if (!q) {
    return filtered
      .slice()
      .sort((a, b) => lastNameOf(a[0].name).localeCompare(lastNameOf(b[0].name)));
  }
  return filtered
    .map((group) => {
      const fields = [
        ...group.map((u) => ({ value: u.name, priority: 0 })),
        ...combinedKids(group).map((k) => ({ value: k, priority: 1 })),
        ...groupAddressLines(group).map((a) => ({ value: a, priority: 2 })),
      ];
      return { group, rank: rankFields(fields, q) };
    })
    .filter((r): r is { group: AdminUser[]; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.group[0].name.localeCompare(b.group[0].name))
    .map((r) => r.group);
}

// Carpools tab: match spans name, members, and destination address, in
// that priority order, with day/code as a lower-priority catch-all — a
// member or address hit still ranks below a name hit.
function filterCarpools(carpools: AdminCarpool[], query: string): AdminCarpool[] {
  const q = query.trim();
  if (!q) return carpools;
  return carpools
    .map((c) => {
      const destination = c.destination?.street ? `${c.destination.street}, ${c.destination.zip}` : "";
      const fields = [
        { value: c.name, priority: 0 },
        ...c.members.map((m) => ({ value: m.name, priority: 1 })),
        { value: destination, priority: 2 },
        { value: c.day ?? "", priority: 3 },
        { value: c.code, priority: 3 },
      ];
      return { c, rank: rankFields(fields, q) };
    })
    .filter((r): r is { c: AdminCarpool; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    .map((r) => r.c);
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
  // Same resolution the AI summary and the by-parent view use, so this
  // picker's "(default)" placeholder always names the actual default
  // driver — not just whichever parent happens to be listed first for a
  // shared kid, which parentsOf(kid)[0] alone can't tell apart from.
  const kidDefaults = computeKidDefaults(carpool.members);
  const kidToDriver = resolveKidDrivers(cars, carpool.members, kidDefaults);
  const driverFor = (kid: string) => cars.find((c) => c.kids.includes(kid))?.driverId ?? "";
  const parentsOf = (kid: string) => carpool.members.filter((m) => m.kids.includes(kid)).map((m) => m.name);

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
              const parents = parentsOf(kid);
              const defaultDriverId = kidToDriver.get(kid);
              const defaultDriverName =
                carpool.members.find((m) => m.id === defaultDriverId)?.name ?? parents[0] ?? "";
              const defaultLabel = `${defaultDriverName} (default)`;
              return (
                <tr key={kid}>
                  <td>
                    <div className="admin-kid-cell">
                      <strong>{kid}</strong>
                      <span className="admin-kid-parent">
                        {parents[0]}
                        <CoParentLink names={parents} />
                      </span>
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
  const allKids = Array.from(new Set(carpool.members.flatMap((m) => m.kids))).sort((a, b) =>
    a.localeCompare(b)
  );
  const kidDefaults = computeKidDefaults(carpool.members);
  const kidToDriver = resolveKidDrivers(cars, carpool.members, kidDefaults);
  // A card belongs here if this member is either an explicit driver (has a
  // car in this leg, even an empty one offering seats) or is currently the
  // resolved default driver for at least one kid — same "you're always
  // good for your own kid" fallback the AI summary and the by-kid view
  // already use. Filtering by the canDrive toggle alone (the old behavior)
  // silently dropped every default-only parent from this view entirely.
  const cardDriverIds = new Set([...cars.map((c) => c.driverId), ...kidToDriver.values()]);
  const drivers = carpool.members.filter((m) => cardDriverIds.has(m.id));

  return (
    <div className="admin-panel-leg-assignments">
      <h4>{label} cars</h4>
      {drivers.length === 0 ? (
        <p className="admin-muted">No one can drive {label.toLowerCase()} yet.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table admin-driving-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kids in car</th>
                <th>Add kid</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const kids = allKids
                  .filter((k) => kidToDriver.get(k) === d.id)
                  .slice()
                  .sort((a, b) => a.localeCompare(b));
                const addOptions = allKids
                  .filter((k) => kidToDriver.get(k) !== d.id)
                  .map((k) => ({ id: k, name: k }));
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>
                      <div className="admin-car-card-kids">
                        {kids.length === 0 ? (
                          <span className="admin-muted">Nobody</span>
                        ) : (
                          kids.map((k) => {
                            // Explicit only if this specific kid sits in
                            // this driver's own car — a driver can have a
                            // real car and still be the *default* ride for
                            // one of their other kids nobody's explicitly
                            // moved yet.
                            const isDefault = !cars.some(
                              (c) => c.driverId === d.id && c.kids.includes(k)
                            );
                            return (
                              <span className="admin-member-chip" key={k}>
                                {k}
                                {isDefault && <span className="admin-muted"> (default)</span>}{" "}
                                {!isDefault && (
                                  <button
                                    type="button"
                                    className="admin-chip-remove"
                                    title="Unassign"
                                    onClick={() => onMoveKid(k, null)}
                                  >
                                    &times;
                                  </button>
                                )}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
  const [tab, setTab] = useState<"users" | "carpools" | "updates" | "dataviz">("users");
  const [datavizTab, setDatavizTab] = useState<DatavizTab>("geography");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [carpools, setCarpools] = useState<AdminCarpool[]>([]);
  // Kept alongside the flattened AdminCarpool list (which collapses every
  // carpool down to one representative occurrence) so the per-date lookup
  // below has the raw, per-date data to pick from.
  const [occurrences, setOccurrences] = useState<CarpoolOccurrence[]>([]);
  const [updates, setUpdates] = useState<AdminUpdate[]>([]);
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
      setCarpools(toAdminCarpools(data.carpools, data.occurrences ?? []));
      setOccurrences(data.occurrences ?? []);
      const updatesRes = await fetch("/api/updates");
      if (updatesRes.ok) setUpdates((await updatesRes.json()).updates);
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

  const callUpdates = async (action: string, payload: unknown) => {
    const res = await fetch("/api/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action, payload }),
    });
    if (!res.ok) throw new Error(await res.text());
    await load(key);
  };

  const [newUpdateText, setNewUpdateText] = useState("");
  const [addingUpdate, setAddingUpdate] = useState(false);
  const createUpdate = async () => {
    if (!newUpdateText.trim()) return;
    setAddingUpdate(true);
    try {
      await callUpdates("createUpdate", { text: newUpdateText.trim() });
      setNewUpdateText("");
    } finally {
      setAddingUpdate(false);
    }
  };

  const [editingUpdate, setEditingUpdate] = useState<string | null>(null);
  const [updateDraftText, setUpdateDraftText] = useState("");
  const [savingUpdate, setSavingUpdate] = useState(false);
  const startEditUpdate = (u: AdminUpdate) => {
    setEditingUpdate(u.id);
    setUpdateDraftText(u.text);
  };
  const saveUpdate = async () => {
    if (!editingUpdate) return;
    setSavingUpdate(true);
    try {
      await callUpdates("updateUpdate", { id: editingUpdate, text: updateDraftText });
      setEditingUpdate(null);
    } finally {
      setSavingUpdate(false);
    }
  };
  const deleteUpdate = async (id: string) => {
    if (!confirm("Delete this update?")) return;
    await callUpdates("deleteUpdate", { id });
  };

  const [newUser, setNewUser] = useState({ name: "", kids: "", street: "", zip: "", isTestAccount: false });
  const [addingUser, setAddingUser] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const openAddUser = () => {
    setNewUser({ name: "", kids: "", street: "", zip: "", isTestAccount: false });
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
        isTestAccount: newUser.isTestAccount,
      });
      setAddUserOpen(false);
    } finally {
      setAddingUser(false);
    }
  };

  const [userSearch, setUserSearch] = useState("");
  const [testAccountFilter, setTestAccountFilter] = useState<TestAccountFilter>("all");
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
        isTestAccount: userDraft.isTestAccount,
      });
      setEditingUser(null);
    } finally {
      setSavingUser(false);
    }
  };
  const deleteUser = async (memberId: string) => {
    if (!confirm("Delete this user? This removes them from any carpools too.")) return;
    await callAdmin("deleteUser", { memberId });
    setEditingUser(null);
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
  // "" means "the current/nearest occurrence" (the existing editable view);
  // picking a date switches to a read-only look at that exact occurrence,
  // so a driver/kid mismatch on a specific date (like a stale skip) can
  // actually be seen instead of only ever inferred from the recurring default.
  const [selectedOccDate, setSelectedOccDate] = useState<string>("");
  const startEditCarpool = (c: AdminCarpool) => {
    setEditingCarpool(c.code);
    setSelectedOccDate("");
    setCarpoolDraft({
      ...c,
      destination: { ...(c.destination ?? { street: "", zip: "" }) },
      dropOff: { time: c.dropOff?.time ?? "", cars: c.dropOff?.cars ?? [] },
      pickUp: { time: c.pickUp?.time ?? "", cars: c.pickUp?.cars ?? [] },
      timezone: c.timezone || detectTimezone(),
      recurrenceType: c.recurrenceType,
      daysOfWeek: c.daysOfWeek,
      eraStartDate: c.eraStartDate,
    });
    setAddMemberSelection("");
    setHouseholdKidSearch("");
    setLegTab("dropOff");
    setLegViewMode("kid");
  };
  // Calls the same /api/carpools/schedule endpoint the real edit-carpool
  // sheet uses (CarpoolDetail's updateCarpoolSchedule/updateCarpoolLabel),
  // instead of admin-data's own flat day/time mutation, so admin can change
  // recurrence type, day(s), and one-off dates the exact same way a user
  // can — including the "this and all future, starting <date>" era-split
  // semantics that a single mutate-in-place field can't express.
  const callSchedule = async (payload: unknown) => {
    const res = await fetch("/api/carpools/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
  };
  const saveCarpool = async () => {
    if (!carpoolDraft) return;
    setSavingCarpool(true);
    try {
      await callSchedule({
        code: carpoolDraft.code,
        scope: "all",
        name: carpoolDraft.name,
        destination: carpoolDraft.destination,
        timezone: carpoolDraft.timezone,
      });
      // A day-of-week/frequency/time change can never be retroactive — it
      // always takes effect starting today (or the picked date, for a
      // one-off), same as the "This event forward" scope in the real app.
      const startDate = carpoolDraft.recurrenceType === "oneoff" ? carpoolDraft.eraStartDate : todayISO();
      await callSchedule({
        code: carpoolDraft.code,
        scope: "thisAndFuture",
        startDate,
        type: carpoolDraft.recurrenceType,
        daysOfWeek: carpoolDraft.recurrenceType === "oneoff" ? undefined : carpoolDraft.daysOfWeek,
        dropOff: { time: carpoolDraft.dropOff?.time ?? "", cars: carpoolDraft.dropOff?.cars ?? [] },
        pickUp: { time: carpoolDraft.pickUp?.time ?? "", cars: carpoolDraft.pickUp?.cars ?? [] },
      });
      await load(key);
      setEditingCarpool(null);
    } finally {
      setSavingCarpool(false);
    }
  };
  const setMemberSeats = (code: string, memberId: string, leg: "dropOff" | "pickUp", seats: number) =>
    callAdmin("setMemberSeats", { code, memberId, leg, seats });
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

  const toggleHouseholdKid = (code: string, memberIds: string[], kid: string, on: boolean) =>
    callAdmin("toggleHouseholdKid", { code, memberIds, kid, on });
  const [householdKidSearch, setHouseholdKidSearch] = useState("");

  // The panel's carpool data needs to reflect the latest load (e.g. after
  // adding/removing a member), not the stale snapshot captured when it opened.
  const liveEditingCarpool = editingCarpool ? carpools.find((c) => c.code === editingCarpool) : null;
  const editingCarpoolOccurrences = editingCarpool
    ? occurrences.filter((o) => o.code === editingCarpool).sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const viewedOccurrence = selectedOccDate
    ? editingCarpoolOccurrences.find((o) => o.date === selectedOccDate) ?? null
    : null;
  // Viewing a specific date swaps in that occurrence's actual dropOff/pickUp
  // (and exposes its skippedKids) without touching the editable "current"
  // view underneath — this is a read-only lens, not a new edit surface.
  const displayEditingCarpool =
    liveEditingCarpool && viewedOccurrence
      ? { ...liveEditingCarpool, dropOff: viewedOccurrence.dropOff, pickUp: viewedOccurrence.pickUp }
      : liveEditingCarpool;
  // Same idea for the user panel: co-parent link/unlink/combine happen
  // immediately, so the panel needs the freshly reloaded user, not the
  // snapshot captured when it opened.
  const liveEditingUser = editingUser ? users.find((u) => u.memberId === editingUser) : null;
  const userCarpools = liveEditingUser
    ? carpools.filter((c) => c.members.some((m) => m.id === liveEditingUser.memberId))
    : [];

  const filteredUserGroups = filterUserGroups(groupUsersByCoParent(users), userSearch, testAccountFilter);

  // The top-level test-account filter also scopes DataViz: a carpool
  // counts as "test" if any member is flagged (same permissive rule
  // groupIsTestAccount uses for the Users list), so a mixed household
  // doesn't silently vanish from either view.
  const testMemberIds = new Set(users.filter((u) => u.isTestAccount).map((u) => u.memberId));
  const datavizUsers =
    testAccountFilter === "all"
      ? users
      : users.filter((u) => Boolean(u.isTestAccount) === (testAccountFilter === "test"));
  const datavizCarpools =
    testAccountFilter === "all"
      ? carpools
      : carpools.filter(
          (c) => c.members.some((m) => testMemberIds.has(m.id)) === (testAccountFilter === "test")
        );
  const filteredCarpools = filterCarpools(carpools, carpoolSearch);

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
          <div className="admin-tabs-row">
            <nav className="admin-tabs">
              <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
                Users ({users.length})
              </button>
              <button className={tab === "carpools" ? "active" : ""} onClick={() => setTab("carpools")}>
                Carpools ({carpools.length})
              </button>
              <button className={tab === "updates" ? "active" : ""} onClick={() => setTab("updates")}>
                Updates ({updates.length})
              </button>
              <button className={tab === "dataviz" ? "active" : ""} onClick={() => setTab("dataviz")}>
                DataViz
              </button>
            </nav>
            <select
              className="admin-filter-select admin-header-filter"
              value={testAccountFilter}
              onChange={(e) => setTestAccountFilter(e.target.value as TestAccountFilter)}
            >
              <option value="all">All</option>
              <option value="real">No text</option>
              <option value="test">Test</option>
            </select>
          </div>
          {tab === "dataviz" && (
            <nav className="admin-subtabs">
              {DATAVIZ_TABS.map((t) => (
                <button
                  key={t.key}
                  className={datavizTab === t.key ? "active" : ""}
                  onClick={() => setDatavizTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          )}
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
                  <th>Address</th>
                </tr>
              </thead>
              <tbody>
                {filteredUserGroups.map((group) => {
                  const kids = combinedKids(group);
                  const addressLines = groupAddressLines(group);
                  return (
                    <tr key={group.map((u) => u.memberId).join("-")}>
                      <td>
                        <div className="admin-name-links">
                          {group.map((u) => (
                            <span
                              key={u.memberId}
                              className="admin-name-link"
                              onClick={() => startEditUser(u)}
                            >
                              <HighlightedText text={u.name} query={userSearch} />
                              {u.isTestAccount && <span className="admin-muted"> (test)</span>}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {kids.length === 0 ? (
                          "—"
                        ) : (
                          <div className="admin-kid-lines">
                            {kids.map((kid) => (
                              <div key={kid}><HighlightedText text={kid} query={userSearch} /></div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="admin-kid-lines">
                          {addressLines.map((line, i) => (
                            <div key={i}><HighlightedText text={line} query={userSearch} /></div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
                    <td><HighlightedText text={c.name} query={carpoolSearch} /></td>
                    <td>{c.day ? <HighlightedText text={c.day} query={carpoolSearch} /> : "—"}</td>
                    <td>
                      {c.destination?.street ? (
                        <HighlightedText text={`${c.destination.street}, ${c.destination.zip}`} query={carpoolSearch} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{c.dropOff?.time || "—"}</td>
                    <td>{c.pickUp?.time || "—"}</td>
                    <td>
                      {c.members.length > 0 ? (
                        <div className="admin-member-list">
                          {c.members.map((m) => (
                            <div key={m.id}><HighlightedText text={m.name} query={carpoolSearch} /></div>
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

        {!loading && tab === "updates" && (
          <>
            <div className="admin-list-toolbar admin-add-update-row">
              <input
                type="text"
                className="admin-search-input"
                placeholder="New update text..."
                value={newUpdateText}
                onChange={(e) => setNewUpdateText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createUpdate();
                }}
              />
              <button type="button" onClick={createUpdate} disabled={addingUpdate || !newUpdateText.trim()}>
                {addingUpdate ? "Adding..." : "+ Add update"}
              </button>
            </div>
            <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Text</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {updates.map((u) => (
                  <tr key={u.id} className="admin-row-clickable" onClick={() => startEditUpdate(u)}>
                    <td>{u.text}</td>
                    <td>{new Date(u.createdAt).toLocaleString()}</td>
                    <td>
                      <button onClick={(e) => { e.stopPropagation(); deleteUpdate(u.id); }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}

        {!loading && tab === "dataviz" && (
          <AdminDatavizPanel users={datavizUsers} carpools={datavizCarpools} subTab={datavizTab} />
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
            <button onClick={() => setEditingUser(null)}>Cancel</button>{" "}
            <button onClick={() => editingUser && deleteUser(editingUser)}>Delete</button>
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
            <label className="admin-checkbox-label">
              <input
                type="checkbox"
                checked={userDraft.isTestAccount ?? false}
                onChange={(e) => setUserDraft({ ...userDraft, isTestAccount: e.target.checked })}
              />
              Test account (not a real carpooler)
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
                <p>
                  Invite code:{" "}
                  {liveEditingUser.coParentCode ? (
                    <CopyableCode value={liveEditingUser.coParentCode} />
                  ) : (
                    "Not generated yet"
                  )}
                </p>
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
          <label className="admin-checkbox-label">
            <input
              type="checkbox"
              checked={newUser.isTestAccount}
              onChange={(e) => setNewUser({ ...newUser, isTestAccount: e.target.checked })}
            />
            Test account (not a real carpooler)
          </label>
        </div>
      </SidePanel>

      <SidePanel
        open={editingUpdate !== null}
        onClose={() => setEditingUpdate(null)}
        title="Edit update"
        footer={
          <>
            <button onClick={saveUpdate} disabled={savingUpdate || !updateDraftText.trim()}>
              {savingUpdate ? "Saving..." : "Save"}
            </button>{" "}
            <button onClick={() => setEditingUpdate(null)}>Cancel</button>
          </>
        }
      >
        <div className="admin-panel-form">
          <label>
            Text
            <textarea
              rows={6}
              value={updateDraftText}
              onChange={(e) => setUpdateDraftText(e.target.value)}
              autoFocus
            />
          </label>
        </div>
      </SidePanel>

      <SidePanel
        open={editingCarpool !== null}
        onClose={() => setEditingCarpool(null)}
        title={carpoolDraft ? `Edit ${carpoolDraft.name}` : "Edit carpool"}
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
                How often
                <div className="segmented-group">
                  {(["weekly", "biweekly", "oneoff"] as RecurrenceType[]).map((t) => (
                    <button
                      type="button"
                      key={t}
                      className={`segmented-btn ${carpoolDraft.recurrenceType === t ? "active" : ""}`}
                      onClick={() => setCarpoolDraft({ ...carpoolDraft, recurrenceType: t })}
                    >
                      {t === "weekly" ? "Every week" : t === "biweekly" ? "Every other week" : "Just once"}
                    </button>
                  ))}
                </div>
              </label>
              {carpoolDraft.recurrenceType === "oneoff" ? (
                <label>
                  Date
                  <input
                    type="date"
                    value={carpoolDraft.eraStartDate}
                    min={todayISO()}
                    onChange={(e) => setCarpoolDraft({ ...carpoolDraft, eraStartDate: e.target.value })}
                  />
                </label>
              ) : (
                <label>
                  Which day(s)
                  <div className="segmented-group">
                    {DAYS_OF_WEEK.map((d) => (
                      <button
                        type="button"
                        key={d}
                        className={`segmented-btn ${carpoolDraft.daysOfWeek.includes(d) ? "active" : ""}`}
                        onClick={() =>
                          setCarpoolDraft({
                            ...carpoolDraft,
                            daysOfWeek: carpoolDraft.daysOfWeek.includes(d)
                              ? carpoolDraft.daysOfWeek.filter((x) => x !== d)
                              : [...carpoolDraft.daysOfWeek, d],
                          })
                        }
                      >
                        {d.slice(0, 3)}
                      </button>
                    ))}
                  </div>
                </label>
              )}
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
              <label>
                Timezone
                <select
                  value={carpoolDraft.timezone}
                  onChange={(e) => setCarpoolDraft({ ...carpoolDraft, timezone: e.target.value })}
                >
                  {(COMMON_TIMEZONES.some((tz) => tz.value === carpoolDraft.timezone)
                    ? COMMON_TIMEZONES
                    : [{ value: carpoolDraft.timezone, label: carpoolDraft.timezone }, ...COMMON_TIMEZONES]
                  ).map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
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

            <div className="admin-panel-members admin-panel-household-kids">
              <h4>Kids in this carpool</h4>
              <input
                type="search"
                className="admin-search-input"
                placeholder="Search parents..."
                value={householdKidSearch}
                onChange={(e) => setHouseholdKidSearch(e.target.value)}
              />
              {filterUserGroups(groupUsersByCoParent(users), householdKidSearch).map((group) => {
                const kids = combinedKids(group);
                if (kids.length === 0) return null;
                const memberIds = group.map((u) => u.memberId);
                return (
                  <div key={memberIds.join("-")} className="admin-household-kid-row">
                    <span className="admin-household-name">
                      {group.map((u) => u.name).join(" & ")}
                    </span>
                    <div className="kid-tags">
                      {kids.map((kid) => {
                        const active = liveEditingCarpool.members.some(
                          (m) => memberIds.includes(m.id) && m.kids.includes(kid)
                        );
                        return (
                          <button
                            type="button"
                            key={kid}
                            className={`kid-pick ${active ? "active" : ""}`}
                            aria-pressed={active}
                            onClick={() =>
                              toggleHouseholdKid(liveEditingCarpool.code, memberIds, kid, !active)
                            }
                          >
                            {kid}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="admin-panel-driving">
              <h4>Who can drive</h4>
              <table className="admin-table admin-driving-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Drop-off free seats</th>
                    <th>Pick-up free seats</th>
                  </tr>
                </thead>
                <tbody>
                  {liveEditingCarpool.members.map((m) => {
                    const dropOffSeats =
                      liveEditingCarpool.dropOff?.cars.find((c) => c.driverId === m.id)?.seats ?? 0;
                    const pickUpSeats =
                      liveEditingCarpool.pickUp?.cars.find((c) => c.driverId === m.id)?.seats ?? 0;
                    return (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td>
                          <SeatStepper
                            seats={dropOffSeats}
                            onChange={(seats) => setMemberSeats(liveEditingCarpool.code, m.id, "dropOff", seats)}
                          />
                        </td>
                        <td>
                          <SeatStepper
                            seats={pickUpSeats}
                            onChange={(seats) => setMemberSeats(liveEditingCarpool.code, m.id, "pickUp", seats)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="admin-occurrence-picker">
              <label>
                Viewing
                <select value={selectedOccDate} onChange={(e) => setSelectedOccDate(e.target.value)}>
                  <option value="">Current schedule (editable)</option>
                  {editingCarpoolOccurrences.map((o) => (
                    <option key={o.date} value={o.date}>
                      {o.date}
                      {o.overridden.dropOff || o.overridden.pickUp ? " (overridden)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {viewedOccurrence && (
                <span className="admin-occurrence-note">
                  Read-only — showing exactly what's assigned on this date.
                  {viewedOccurrence.skippedKids && viewedOccurrence.skippedKids.length > 0
                    ? ` Opted out this date: ${viewedOccurrence.skippedKids.join(", ")}.`
                    : ""}
                </span>
              )}
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
                carpool={displayEditingCarpool ?? liveEditingCarpool}
                leg={legTab}
                label={legTab === "dropOff" ? "Drop-off" : "Pick-up"}
                onMoveKid={
                  viewedOccurrence
                    ? () => {}
                    : (kid, driverId) => moveKid(liveEditingCarpool.code, legTab, kid, driverId)
                }
              />
            ) : (
              <LegAssignmentsByParent
                carpool={displayEditingCarpool ?? liveEditingCarpool}
                leg={legTab}
                label={legTab === "dropOff" ? "Drop-off" : "Pick-up"}
                onMoveKid={
                  viewedOccurrence
                    ? () => {}
                    : (kid, driverId) => moveKid(liveEditingCarpool.code, legTab, kid, driverId)
                }
              />
            )}
          </div>
        )}
      </SidePanel>
    </div>
  );
}
