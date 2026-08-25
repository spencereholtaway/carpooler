import { useEffect, useState } from "react";
import {
  getHousehold,
  joinCarpool,
  moveOccurrence,
  skipKid,
  updateCarpoolLabel,
  updateCarpoolSchedule,
  updateOccurrence,
  updateTimeEverywhere,
  type CarpoolResult,
} from "./api";
import { BottomSheet } from "./BottomSheet";
import { BuyMeACoffeeLink } from "./BuyMeACoffeeLink";
import { computeKidDefaults, formatTime, joinList, resolveKidDrivers, summarizeCarpool } from "./carpoolSummary";
import { KidPicker } from "./KidPicker";
import { computeAutoRoute, type AutoRouteLegKind, type NamedStop } from "./autoRoute";
import { mapsLink, multiStopMapsLink } from "./maps";
import { useBackable } from "./useBackable";
import {
  COMMON_TIMEZONES,
  currentEra,
  DAYS_OF_WEEK,
  detectTimezone,
  friendlyDateLabel,
  nearestDateForWeekday,
  pickRepresentativeOccurrence,
  toCarpoolView,
  todayISO,
  type Address,
  type Car,
  type CarpoolOccurrence,
  type Leg,
  type CarpoolSeries,
  type DayOfWeek,
  type Member,
  type RecurrenceType,
  shortenName,
} from "./types";
import { useTypewriter } from "./useTypewriter";

function moveKid(cars: Car[], kid: string, driverId: string | null, defaultSeats: number): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  // A member who isn't marked as driving this leg has no car entry at all —
  // moving a kid to them (e.g. their own kid, regardless of that toggle)
  // needs to create one (seeded with their usual seat count) rather than
  // silently no-op.
  if (!cleared.some((c) => c.driverId === driverId)) {
    return [...cleared, { driverId, kids: [kid], seats: defaultSeats }];
  }
  return cleared.map((c) => (c.driverId === driverId ? { ...c, kids: [...c.kids, kid] } : c));
}

// A kid only needs offering, not auto-moving: they're already claimed by
// someone else's explicit car for this leg, so joining as a driver doesn't
// pull them along automatically (see syncCar server-side) — this surfaces
// that gap so the parent can choose instead of it happening silently.
function kidsToOfferMove(cars: Car[], selfId: string, selfKids: string[]): string[] {
  return selfKids.filter((k) => {
    const car = cars.find((c) => c.kids.includes(k));
    return car !== undefined && car.driverId !== selfId;
  });
}

function AiMovePrompt({
  kids,
  legLabel,
  onConfirm,
  onDismiss,
  busy,
}: {
  kids: string[];
  legLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div className="ai-prompt pop-in">
      <span className="ai-summary-badge">
        <span className="ai-summary-sparkle" aria-hidden="true">
          ✨
        </span>
        <span className="ai-summary-name">blisspoolAI</span>
      </span>
      <p className="ai-prompt-text">
        Move {joinList(kids)} into your car for {legLabel}?
      </p>
      <div className="ai-prompt-actions">
        <button type="button" className="pill-button small" onClick={onConfirm} disabled={busy}>
          {busy ? "Moving..." : "Yes"}
        </button>
        <button type="button" className="pill-button small secondary" onClick={onDismiss} disabled={busy}>
          No
        </button>
      </div>
    </div>
  );
}

const AUTO_ROUTE_ERROR_COPY: Record<Exclude<Awaited<ReturnType<typeof computeAutoRoute>>, { ok: true }>["reason"], string> = {
  "geolocation-denied": "Location access denied — enable it to use auto-routing.",
  "geolocation-unavailable": "Couldn't get your location. Try again.",
  "geocode-failed": "Couldn't look up one of the addresses. Try again.",
};

// The default way to navigate a leg: figures out a good order to visit the
// "other kids" stops (if any) and hands the whole route to the driver's Maps
// app at once, rather than making them tap through one stop at a time.
type AutoRouteLeg = {
  legKind: AutoRouteLegKind;
  label: string;
  kidHomeStops: NamedStop[];
  bookend: NamedStop;
  extraFixedStop?: NamedStop;
};

function buildAutoRouteLeg(
  legKind: AutoRouteLegKind,
  label: string,
  otherKids: string[],
  kidHome: (kid: string) => Address | undefined,
  bookend: { label: string; address: Address | undefined },
  extraFixedStop?: { label: string; address: Address | undefined },
): AutoRouteLeg | null {
  const kidHomeStops: NamedStop[] = otherKids
    .map((kid) => ({ label: kid, address: kidHome(kid) }))
    .filter((s): s is NamedStop => !!s.address?.street);
  if (!bookend.address?.street) return null;
  if (extraFixedStop && !extraFixedStop.address?.street) return null;
  return { legKind, label, kidHomeStops, bookend: bookend as NamedStop, extraFixedStop: extraFixedStop as NamedStop | undefined };
}

// One button per leg that triggers auto-routing directly — no separate
// per-stop links to tap through. A state-changing button label is too easy
// to miss, so once the route's ready this pops a bottom sheet instead: the
// user's primary intent at that point is opening it in Maps, so that's the
// one action offered there.
function DriveLegButton({ leg }: { leg: AutoRouteLeg }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);

  const handleClick = async () => {
    setState("loading");
    setErrorMsg(null);
    try {
      const result = await computeAutoRoute(leg.legKind, leg.kidHomeStops, leg.bookend, leg.extraFixedStop);
      if (!result.ok) {
        console.error("Auto Route failed:", result.reason);
        setState("error");
        setErrorMsg(AUTO_ROUTE_ERROR_COPY[result.reason]);
        return;
      }
      setReadyUrl(multiStopMapsLink(result.orderedStops.map((s) => s.address)));
      setState("idle");
    } catch (err) {
      // Without this, an unexpected throw here (rather than the ok:false
      // path above) left the button stuck on "Finding best route…" forever
      // with no visible sign anything went wrong.
      console.error("Auto Route threw:", err);
      setState("error");
      setErrorMsg("Something went wrong finding the route. Try again.");
    }
  };

  const closeReadySheet = useBackable(!!readyUrl, () => setReadyUrl(null));

  return (
    <div className="drive-leg">
      <button type="button" className="pill-button drive-leg-button" onClick={handleClick} disabled={state === "loading"}>
        {state === "loading" ? "Finding best route…" : `Drive ${leg.label}`}
      </button>
      {state === "error" && errorMsg && <span className="auto-route-error muted">{errorMsg}</span>}
      <BottomSheet
        open={!!readyUrl}
        onClose={closeReadySheet}
        title="Route ready!"
        footer={
          readyUrl && (
            // Don't navigate here: the geolocation/geocoding that produced
            // readyUrl was async, so by the time it resolved the original
            // click's user-activation window was gone. Without it, iOS
            // Safari won't hand the maps.apple.com link off to the Maps app
            // — it just opens the website instead. This tap gets its own
            // fresh activation, which does get the handoff (same root cause
            // as the window.open popup-blocking issue this replaced).
            <a className="pill-button" href={readyUrl} onClick={closeReadySheet}>
              Open route in Maps
            </a>
          )
        }
      >
        <p>Your {leg.label.toLowerCase()} route is ready to go.</p>
      </BottomSheet>
    </div>
  );
}

// The seat count doubles as the "I can drive" toggle: 0 means you're not
// driving this leg at all, 1+ means you are, with that many free seats for
// other people's kids (your own kid riding along doesn't count against it).
// No separate checkbox — tapping "+" from 0 is how you start driving, and
// dropping the last seat is how you stop.
function LegToggleRow({
  label,
  time,
  seats,
  disabled,
  onChange,
}: {
  label: string;
  time: string;
  seats: number;
  disabled: boolean;
  onChange: (delta: number) => void;
}) {
  const active = seats > 0;
  return (
    <div className={`leg-toggle-row ${active ? "checked" : ""}`}>
      <span className="leg-toggle-info">
        <strong>{label}</strong>
        <span className="muted">{formatTime(time)}</span>
      </span>
      <span className="leg-check-group">
        <span className="leg-check-label">Free seats</span>
        <span className="seat-stepper-compact">
          <button
            type="button"
            onClick={() => onChange(-1)}
            disabled={disabled || seats === 0}
            aria-label="Fewer seats"
          >
            &minus;
          </button>
          <span className="seat-count">{seats}</span>
          <button
            type="button"
            onClick={() => onChange(1)}
            disabled={disabled || seats >= 8}
            aria-label="More seats"
          >
            +
          </button>
        </span>
      </span>
    </div>
  );
}

// Stands in for "who's driving who" once every one of this member's kids has
// been marked not participating this week — there's no driving to show, just
// a way back in per kid (which restores them to the driver's own car with
// whatever seat count they'd had before, per skipKid's un-skip behavior).
function RemovedKidsNotice({
  kids,
  onAddBack,
  togglingKid,
  className,
}: {
  kids: string[];
  onAddBack: (kid: string) => void;
  togglingKid: string | null;
  className?: string;
}) {
  return (
    <div className={`removed-kids-notice${className ? ` ${className}` : ""}`}>
      <p className="removed-kids-notice-text">
        You removed {joinList(kids.map(shortenName))} from this week.
      </p>
      <div className="removed-kids-notice-actions">
        {kids.map((kid) => (
          <button
            key={kid}
            type="button"
            className="pill-button secondary"
            disabled={togglingKid === kid}
            onClick={() => onAddBack(kid)}
          >
            {togglingKid === kid ? "Adding back..." : `Add ${shortenName(kid)} back`}
          </button>
        ))}
      </div>
    </div>
  );
}

function DrivingLeg({
  label,
  time,
  cars,
  members,
  memberId,
  eligibleFor,
  onCarsChange,
  kidDefaults,
  coParentId,
  householdCombined,
}: {
  label: string;
  time: string;
  cars: Car[];
  members: Member[];
  memberId: string;
  eligibleFor: (m: Member) => boolean;
  onCarsChange: (cars: Car[]) => void;
  kidDefaults: Map<string, string>;
  coParentId: string | null;
  householdCombined: boolean;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Kept mounted a beat after collapsing so its slide/pop-out animation has
  // something to play — expandedRow alone would unmount it instantly.
  const [closingRow, setClosingRow] = useState<string | null>(null);
  const [selectedKids, setSelectedKids] = useState<string[]>([]);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [showCantCarpool, setShowCantCarpool] = useState(false);
  const coParentMember = coParentId ? members.find((m) => m.id === coParentId) : undefined;
  const mergeHousehold = householdCombined && !!coParentMember;
  const selfKidsList = members.find((m) => m.id === memberId)?.kids ?? [];
  // Once a household drives as one unit, both parents' kids read as "ours" —
  // no more graying out the co-parent's kid as if it were someone else's.
  const householdKidsList = mergeHousehold ? [...selfKidsList, ...coParentMember.kids] : selfKidsList;
  const myKids = new Set(householdKidsList);

  // Not driving a leg doesn't mean your kid has no ride — it defaults to
  // riding with whichever parent owns it by default, unless someone has
  // explicitly moved them into another active car for that leg.
  const assignedElsewhere = new Set(cars.flatMap((c) => c.kids));

  const rowData = members.map((m) => {
    const car = cars.find((c) => c.driverId === m.id);
    // A car existing doesn't mean this member's own kid is in it — that car
    // might be empty (e.g. a kid toggled off and back on via admin never
    // re-syncs the car). Fold in any of their own kids nobody else has
    // claimed and who default to them, same as a member with no car at all.
    const defaultOwnKids = m.kids.filter((k) => !assignedElsewhere.has(k) && kidDefaults.get(k) === m.id);
    const kids = car ? [...car.kids, ...defaultOwnKids] : defaultOwnKids;
    const eligible = eligibleFor(m);
    // A car's seat count is directly "how many free seats do you have" —
    // seats offered to other people's kids. The driver's own kid(s) riding
    // along don't count against it; only other members' kids do. No car yet
    // (the normal case for anyone not driving) reads as zero free seats.
    const otherKidsInCar = kids.filter((k) => !m.kids.includes(k)).length;
    const free = eligible ? Math.max((car?.seats ?? 0) - otherKidsInCar, 0) : 0;
    const isSelf = m.id === memberId;
    const isCoParent = m.id === coParentId;
    // A parent can always move their own kid into their own car or their
    // co-parent's car, even if the driving toggle is off — that toggle only
    // gates offering up free seats to other members' kids.
    const movableKids = selfKidsList.filter((k) => !kids.includes(k));
    const canMoveHere = movableKids.length > 0 && (isSelf || isCoParent || (eligible && free > 0));
    return {
      m,
      kids,
      eligible,
      free,
      isSelf,
      isCoParent,
      canMoveHere,
      movableKids,
      displayName: isSelf ? "You" : shortenName(m.name),
    };
  });

  // A combined household drives as a single unit — fold the co-parent's row
  // into "You" instead of listing two cards for one household.
  let mergedRowData = rowData;
  if (mergeHousehold) {
    const selfEntry = rowData.find((r) => r.isSelf);
    const coEntry = rowData.find((r) => r.m.id === coParentId);
    if (selfEntry && coEntry) {
      const mergedKids = Array.from(new Set([...selfEntry.kids, ...coEntry.kids]));
      const mergedEligible = selfEntry.eligible || coEntry.eligible;
      const mergedFree = (selfEntry.eligible ? selfEntry.free : 0) + (coEntry.eligible ? coEntry.free : 0);
      const movableKids = Array.from(new Set([...selfEntry.movableKids, ...coEntry.movableKids]));
      const merged = {
        ...selfEntry,
        kids: mergedKids,
        eligible: mergedEligible,
        free: mergedFree,
        movableKids,
        canMoveHere: movableKids.length > 0,
        displayName: `You & ${shortenName(coEntry.m.name)}`,
      };
      mergedRowData = [merged, ...rowData.filter((r) => !r.isSelf && r.m.id !== coParentId)];
    }
  }

  // You first, then your co-parent, then cars with open seats, then cars with
  // no free seats, then everyone who can't carpool at all — alphabetical by
  // name within each tier.
  const rank = (r: (typeof mergedRowData)[number]) =>
    r.isSelf ? 0 : r.m.id === coParentId ? 1 : r.eligible && r.free > 0 ? 2 : r.eligible ? 3 : 4;
  const rows = [...mergedRowData].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    return rankDiff !== 0 ? rankDiff : a.m.name.localeCompare(b.m.name);
  });

  // Members who can't carpool this leg (and aren't you or your co-parent,
  // who always stay visible) just take up space and hide the people you can
  // actually act on — tuck them behind a toggle instead of listing them all.
  const visibleRows = rows.filter((r) => rank(r) < 4);
  const cantCarpoolRows = rows.filter((r) => rank(r) === 4);

  const closeRow = (id: string) => {
    setClosingRow(id);
    setExpandedRow(null);
    setSelectedKids([]);
    setMoveError(null);
  };

  return (
    <div className="mini-form">
      <div className="driving-leg-header">
        <h3 className="bliss-heading">{label}</h3>
        <span className="driving-leg-time muted">{formatTime(time)}</span>
      </div>
      <div className="driving-row-list">
        {visibleRows.map(renderRow)}
        {cantCarpoolRows.length > 0 && (
          <button
            type="button"
            className="cant-carpool-toggle"
            onClick={() => setShowCantCarpool((v) => !v)}
          >
            {showCantCarpool ? "Hide" : "Show"} {cantCarpoolRows.length} who can't carpool
            <span className={`cant-carpool-caret ${showCantCarpool ? "open" : ""}`}>&#9662;</span>
          </button>
        )}
        {showCantCarpool && cantCarpoolRows.map(renderRow)}
      </div>
    </div>
  );

  function renderRow({
    m,
    kids,
    eligible,
    free,
    isCoParent,
    canMoveHere,
    movableKids,
    displayName,
  }: (typeof rows)[number]) {
          const expanded = canMoveHere && expandedRow === m.id;
          const closing = canMoveHere && closingRow === m.id;
          const multiPick = movableKids.length > 1;

          // Selecting past this car's free-seat count swaps in the new kid
          // for the oldest one already picked (with a note explaining why)
          // rather than silently refusing.
          const toggleSelect = (kid: string) => {
            setSelectedKids((prev) => {
              if (prev.includes(kid)) {
                setMoveError(null);
                return prev.filter((k) => k !== kid);
              }
              if (prev.length >= free) {
                if (prev.length === 0) {
                  setMoveError(
                    free === 0 ? "No free seats here." : `Only ${free} free seat${free === 1 ? "" : "s"} here.`
                  );
                  return prev;
                }
                const evicted = prev[0];
                setMoveError(
                  `Only ${free} free seat${free === 1 ? "" : "s"} here — swapped ${evicted} for ${kid}.`
                );
                return [...prev.slice(1), kid];
              }
              setMoveError(null);
              return [...prev, kid];
            });
          };

          const commitMove = (kidsToMove: string[]) => {
            // No profile default to seed from — a car created here (e.g. a
            // parent moving their own kid in before ever toggling "I can
            // drive") starts at the same 1 seat a fresh sign-up would.
            const defaultSeats = cars.find((c) => c.driverId === m.id)?.seats ?? 1;
            onCarsChange(kidsToMove.reduce((acc, kid) => moveKid(acc, kid, m.id, defaultSeats), cars));
            closeRow(m.id);
          };

          return (
            <div
              className={`driving-row ${canMoveHere ? "tappable" : ""}`}
              key={m.id}
              onClick={() => {
                if (!canMoveHere) return;
                if (expandedRow === m.id) {
                  closeRow(m.id);
                } else {
                  if (expandedRow) setClosingRow(expandedRow);
                  setExpandedRow(m.id);
                  setSelectedKids([]);
                  setMoveError(null);
                }
              }}
            >
              <div className="driving-row-top">
                <div className="driving-row-main">
                  <strong>{displayName}</strong>
                  <div className="driving-row-kids">
                    {kids.length === 0 && <span className="muted">Nobody</span>}
                    {kids
                      .filter((k) => myKids.has(k))
                      .map((k) => (
                        <span className="my-kid-pill" key={k}>
                          {shortenName(k)}
                        </span>
                      ))}
                    {kids.some((k) => !myKids.has(k)) && (
                      <span className="muted">
                        {kids
                          .filter((k) => !myKids.has(k))
                          .map(shortenName)
                          .join(", ")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="driving-row-actions">
                  <span className={`seat-status ${eligible ? "" : "off"}`}>
                    {eligible
                      ? free > 0
                        ? `${free} free seat${free === 1 ? "" : "s"}`
                        : "No free seats"
                      : isCoParent
                        ? "Coparent"
                        : "Can't carpool"}
                  </span>
                  {(expanded || closing) && !multiPick && (
                    <button
                      type="button"
                      className={`pill-button small move-here-button ${!expanded && closing ? "closing" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitMove(movableKids);
                      }}
                      onAnimationEnd={() => {
                        if (!expanded && closing) setClosingRow((c) => (c === m.id ? null : c));
                      }}
                    >
                      Move {shortenName(movableKids[0])} here
                    </button>
                  )}
                </div>
              </div>
              {(expanded || closing) && multiPick && (
                <div
                  className={`move-kid-picker ${!expanded && closing ? "closing" : "pop-in"}`}
                  onClick={(e) => e.stopPropagation()}
                  onAnimationEnd={() => {
                    if (!expanded && closing) setClosingRow((c) => (c === m.id ? null : c));
                  }}
                >
                  <div className="kid-tags">
                    {movableKids.map((kid) => (
                      <button
                        type="button"
                        key={kid}
                        className={`kid-pick ${selectedKids.includes(kid) ? "active" : ""}`}
                        onClick={() => toggleSelect(kid)}
                      >
                        {shortenName(kid)}
                      </button>
                    ))}
                  </div>
                  {moveError && <p className="form-error">{moveError}</p>}
                  <button
                    type="button"
                    className="pill-button small"
                    disabled={selectedKids.length === 0}
                    onClick={() => commitMove(selectedKids)}
                  >
                    Move {selectedKids.length > 0 ? joinList(selectedKids) : "kids"} here
                  </button>
                </div>
              )}
            </div>
          );
  }
}

export function CarpoolDetail({
  series,
  occurrences,
  initialDate,
  memberId,
  allKids,
  onBack,
  onCarpoolUpdated,
  onOccurrenceUpdated,
  onCarpoolLeft,
}: {
  series: CarpoolSeries;
  occurrences: CarpoolOccurrence[];
  initialDate?: string | null;
  memberId: string;
  allKids: string[];
  onBack: () => void;
  onCarpoolUpdated: (result: CarpoolResult) => void;
  onOccurrenceUpdated: (occurrence: CarpoolOccurrence) => void;
  onCarpoolLeft: (code: string) => void;
}) {
  // Which upcoming date this screen is showing/editing — defaults to the
  // nearest one, same carpool the old single-schedule app always showed,
  // unless the list handed us the specific date the user tapped.
  // Every driver/seat/kid control below operates on this occurrence via
  // `carpool` (a flat view derived from series+occurrence), completely
  // unchanged from when that shape came straight from the server.
  const upcomingOccurrences = [...occurrences]
    .filter((o) => o.date >= todayISO() && !o.cancelled)
    .sort((a, b) => a.date.localeCompare(b.date));
  const defaultDate = pickRepresentativeOccurrence(occurrences)?.date;
  const [selectedDate, setSelectedDate] = useState(initialDate ?? defaultDate);
  const occurrence = occurrences.find((o) => o.date === selectedDate) ?? occurrences.find((o) => o.date === defaultDate);
  const isEditingDefaultOccurrence = !occurrence || occurrence.date === defaultDate;
  const carpool = toCarpoolView(series, occurrence);

  const [copied, setCopied] = useState(false);
  const [editingCarpool, setEditingCarpool] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDropOff, setTogglingDropOff] = useState(false);
  const [togglingPickUp, setTogglingPickUp] = useState(false);
  const [movePrompt, setMovePrompt] = useState<{ leg: "dropOff" | "pickUp"; kids: string[] } | null>(
    null
  );
  // Changing which day(s) it runs on or its time is genuinely ambiguous —
  // sometimes it's a one-off ("kickoff moved to 8am this week", "just this
  // Wednesday moved to Thursday") and sometimes it's a real change that
  // should stick. Rather than a generic "Save" that then asks, the three
  // scope options are the save buttons themselves, always visible whenever
  // there's a schedule change to apply — "All"/"From this date forward" ask
  // for confirmation first (real, harder-to-undo changes); "Just this one"
  // doesn't (low-impact, easy to revisit).
  const [applyingScope, setApplyingScope] = useState<"all" | "future" | "occurrence" | null>(null);
  const [confirmingScope, setConfirmingScope] = useState<"all" | "future" | null>(null);
  const closeConfirmingScope = useBackable(!!confirmingScope, () => setConfirmingScope(null));
  const [applyingMovePrompt, setApplyingMovePrompt] = useState(false);
  const [togglingSkipKid, setTogglingSkipKid] = useState<string | null>(null);
  // Turning off a leg's driving toggle evicts anyone else's kid riding in
  // that car (see syncCar server-side) — gate that behind an explicit
  // confirmation instead of letting a toggle click silently bounce someone
  // else's kid back to their own parent.
  const [pendingOff, setPendingOff] = useState<{ leg: "dropOff" | "pickUp"; kids: string[] } | null>(
    null
  );
  const [confirmingOff, setConfirmingOff] = useState(false);
  // Deselecting every one of your kids in the edit sheet means you no longer
  // belong to this carpool — gate that behind an explicit confirmation rather
  // than silently zeroing your kids out while your membership row lingers.
  const [pendingLeave, setPendingLeave] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // Both sheets get a browser-history entry so the back button / edge-swipe
  // dismisses them instead of leaving the app.
  const closeCarpoolEditor = useBackable(editingCarpool, () => setEditingCarpool(false));
  const closePendingOff = useBackable(!!pendingOff, () => setPendingOff(null));
  const closePendingLeave = useBackable(pendingLeave, () => setPendingLeave(false));

  const self = carpool.members.find((m) => m.id === memberId);
  // Unlike `self` (whose kids are filtered down for whichever occurrence is
  // being viewed — see toCarpoolView), this is real carpool membership: a
  // kid skipped just for this date must never look "removed from the
  // carpool" to the membership editor below.
  const realSelf = series.members.find((m) => m.id === memberId);
  // With nobody else to coordinate with yet, "who's driving who" has only
  // one answer — swap that whole section out for a prominent invite instead.
  const soloMember = carpool.members.length === 1;
  const [draftKids, setDraftKids] = useState<string[]>(realSelf?.kids ?? []);
  const [draftName, setDraftName] = useState(carpool.name);
  const [draftRecurrenceType, setDraftRecurrenceType] = useState<RecurrenceType>(currentEra(series).type);
  const [draftDaysOfWeek, setDraftDaysOfWeek] = useState<DayOfWeek[]>(currentEra(series).daysOfWeek);
  // Only meaningful for "oneoff" — there's exactly one occurrence, so
  // changing its date just moves it directly, no era/scope question needed.
  const [draftStartDate, setDraftStartDate] = useState(todayISO());
  const [draftDropOffTime, setDraftDropOffTime] = useState(carpool.dropOff?.time ?? "");
  const [draftPickUpTime, setDraftPickUpTime] = useState(carpool.pickUp?.time ?? "");
  const [draftStreet, setDraftStreet] = useState(carpool.destination?.street ?? "");
  const [draftZip, setDraftZip] = useState(carpool.destination?.zip ?? "");
  const [draftTimezone, setDraftTimezone] = useState(carpool.timezone || detectTimezone());
  const draftTimezoneOptions = COMMON_TIMEZONES.some((tz) => tz.value === draftTimezone)
    ? COMMON_TIMEZONES
    : [{ value: draftTimezone, label: draftTimezone }, ...COMMON_TIMEZONES];
  const [household, setHousehold] = useState<{ coParentId: string | null; combined: boolean } | null>(
    null
  );

  useEffect(() => {
    getHousehold(memberId).then(setHousehold);
  }, [memberId]);

  // Opening a carpool from a scrolled-down list position should land the
  // detail view at the top, not wherever the list happened to be scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [carpool.code]);

  // True once every one of this member's real kids has been marked "not
  // doing it this week" for the occurrence being viewed — at that point
  // there's nothing left for "who's driving who" to say about you, so that
  // whole section swaps out for a removed-kids message instead.
  const allMyKidsSkipped =
    !!realSelf && realSelf.kids.length > 0 && realSelf.kids.every((k) => (occurrence?.skippedKids ?? []).includes(k));
  const kidDefaults = computeKidDefaults(carpool.members);
  const youSummary = summarizeCarpool(carpool, memberId);
  const { display: typedSummary, done: typingDone } = useTypewriter(youSummary);

  // Combined households drive as one unit, so a car under either parent's id
  // counts as "you" driving — see the same merge in DrivingLeg.
  const coParentMember = household?.coParentId
    ? carpool.members.find((m) => m.id === household.coParentId)
    : undefined;
  const drivingIds =
    household?.combined && coParentMember ? [memberId, coParentMember.id] : [memberId];
  const myKids = new Set([...(self?.kids ?? []), ...(household?.combined ? coParentMember?.kids ?? [] : [])]);
  const kidHome = (kid: string): Address | undefined => {
    const owner = carpool.members.find((m) => m.kids.includes(kid));
    return owner ? { street: owner.street, zip: owner.zip } : undefined;
  };
  // Same fallback resolveKidDrivers already uses for the AI summary text:
  // a kid with no explicit car entry still defaults to riding with whichever
  // parent owns them, so "you're driving" isn't limited to explicit rows.
  const kidsIAmDriving = (cars: Car[] | undefined) => {
    const kidToDriver = resolveKidDrivers(cars ?? [], carpool.members, kidDefaults);
    return Array.from(kidToDriver.entries())
      .filter(([, driverId]) => drivingIds.includes(driverId))
      .map(([kid]) => kid);
  };
  const dropOffDrivingKids = kidsIAmDriving(carpool.dropOff?.cars);
  const pickUpDrivingKids = kidsIAmDriving(carpool.pickUp?.cars);
  const dropOffOtherKids = dropOffDrivingKids.filter((k) => !myKids.has(k));
  const pickUpOtherKids = pickUpDrivingKids.filter((k) => !myKids.has(k));
  const hasDrivingStops = dropOffDrivingKids.length > 0 || pickUpDrivingKids.length > 0;
  const homeAddress: Address | undefined = self ? { street: self.street, zip: self.zip } : undefined;
  const dropOffLeg =
    dropOffDrivingKids.length > 0
      ? buildAutoRouteLeg("dropOff", "Drop-off", dropOffOtherKids, kidHome, {
          label: carpool.name,
          address: carpool.destination,
        })
      : null;
  const pickUpLeg =
    pickUpDrivingKids.length > 0
      ? buildAutoRouteLeg(
          "pickUp",
          "Pick-up",
          pickUpOtherKids,
          kidHome,
          { label: "Home", address: homeAddress },
          { label: carpool.name, address: carpool.destination },
        )
      : null;
  // Rendered twice (mobile/desktop), same as the AI summary above it — see
  // the CSS toggle at the 900px breakpoint.
  const drivingStops = hasDrivingStops && (
    <>
      {dropOffLeg && <DriveLegButton leg={dropOffLeg} />}
      {pickUpLeg && <DriveLegButton leg={pickUpLeg} />}
    </>
  );

  // Rendered twice (mobile/desktop), same trick as the AI summary and driving
  // stops above — each copy sits right under this member's "who's driving
  // who" text on its own layout instead of down in the "can you drive more
  // kids" block.
  const renderSkipKidLinks = (extraClassName: string) =>
    realSelf && realSelf.kids.length > 0 && occurrence && (
      <div className={`skip-kid-links ${extraClassName}`}>
        {realSelf.kids.map((kid) => {
          const isSkipped = (occurrence.skippedKids ?? []).includes(kid);
          return (
            <button
              key={kid}
              type="button"
              className="text-link"
              disabled={togglingSkipKid === kid}
              onClick={async () => {
                setTogglingSkipKid(kid);
                try {
                  const updatedOcc = await skipKid(carpool.code, occurrence.date, kid, !isSkipped, memberId);
                  onOccurrenceUpdated(updatedOcc);
                } finally {
                  setTogglingSkipKid(null);
                }
              }}
            >
              {togglingSkipKid === kid
                ? "Saving..."
                : isSkipped
                  ? `Add ${shortenName(kid)} back this week`
                  : "Not going this time? Click here"}
            </button>
          );
        })}
      </div>
    );

  const openCarpoolEditor = () => {
    setDraftKids(realSelf?.kids ?? []);
    setDraftName(carpool.name);
    const era = currentEra(series);
    setDraftRecurrenceType(era.type);
    setDraftDaysOfWeek(era.daysOfWeek);
    setDraftStartDate(era.startDate);
    setDraftDropOffTime(era.defaultDropOff.time);
    setDraftPickUpTime(era.defaultPickUp.time);
    setDraftStreet(carpool.destination?.street ?? "");
    setDraftZip(carpool.destination?.zip ?? "");
    setDraftTimezone(carpool.timezone || detectTimezone());
    setEditingCarpool(true);
  };

  const copyLink = async () => {
    const link = `${window.location.origin}?join=${carpool.code}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // What actually changed since the sheet opened, relative to the series'
  // current era — used both to decide whether the scope prompt needs to
  // show at all, and (once a scope is chosen) how to apply it.
  const scheduleDiff = () => {
    const era = currentEra(series);
    const typeChanged = draftRecurrenceType !== era.type;
    const daysChanged =
      draftRecurrenceType !== "oneoff" &&
      JSON.stringify([...draftDaysOfWeek].sort()) !== JSON.stringify([...era.daysOfWeek].sort());
    const dateChanged = draftRecurrenceType === "oneoff" && draftStartDate !== era.startDate;
    const timeChanged = draftDropOffTime !== era.defaultDropOff.time || draftPickUpTime !== era.defaultPickUp.time;
    return {
      era,
      typeChanged,
      daysChanged,
      dateChanged,
      timeChanged,
      structureChanged: typeChanged || daysChanged || dateChanged,
    };
  };

  // "Just this one" only makes sense when there's an unambiguous single
  // target: either nothing about the recurrence structure changed (a pure
  // time correction), or exactly one day is selected so a move has one
  // obvious destination date.
  const justThisOneAvailable = (() => {
    const { typeChanged, daysChanged } = scheduleDiff();
    return !typeChanged && (!daysChanged || draftDaysOfWeek.length === 1);
  })();

  // Applies whichever day(s)/time changes were made under the given scope,
  // then saves the always-unambiguous label + kids fields. Also the path
  // taken when nothing ambiguous changed at all (scope "future" is simply a
  // no-op for the schedule half in that case).
  const commitSave = async (scope: "future" | "all" | "occurrence") => {
    if (!self || !realSelf) return;
    setSaving(true);
    setApplyingScope(scope);
    try {
      const { era, structureChanged, timeChanged } = scheduleDiff();

      if (scope === "occurrence" && occurrence) {
        const movingDay =
          draftRecurrenceType !== "oneoff" &&
          draftDaysOfWeek.length === 1 &&
          JSON.stringify([...draftDaysOfWeek].sort()) !== JSON.stringify([...era.daysOfWeek].sort());
        if (movingDay) {
          const toDate = nearestDateForWeekday(occurrence.date, draftDaysOfWeek[0]);
          const fields: { dropOff?: Leg; pickUp?: Leg } = {};
          if (timeChanged) {
            fields.dropOff = { time: draftDropOffTime, cars: occurrence.dropOff.cars };
            fields.pickUp = { time: draftPickUpTime, cars: occurrence.pickUp.cars };
          }
          const result = await moveOccurrence(carpool.code, occurrence.date, toDate, fields);
          onCarpoolUpdated(result);
          setSelectedDate(toDate);
        } else if (timeChanged) {
          const fields: { dropOff?: Leg; pickUp?: Leg } = {};
          if (draftDropOffTime !== occurrence.dropOff.time) {
            fields.dropOff = { time: draftDropOffTime, cars: occurrence.dropOff.cars };
          }
          if (draftPickUpTime !== occurrence.pickUp.time) {
            fields.pickUp = { time: draftPickUpTime, cars: occurrence.pickUp.cars };
          }
          if (fields.dropOff || fields.pickUp) {
            const updatedOcc = await updateOccurrence(carpool.code, occurrence.date, fields);
            onOccurrenceUpdated(updatedOcc);
          }
        }
      } else if (scope === "all") {
        if (draftDropOffTime !== era.defaultDropOff.time) {
          await updateTimeEverywhere(carpool.code, "dropOff", draftDropOffTime);
        }
        if (draftPickUpTime !== era.defaultPickUp.time) {
          await updateTimeEverywhere(carpool.code, "pickUp", draftPickUpTime);
        }
        if (structureChanged) {
          // A day-of-week/frequency change can never be retroactive — it
          // always takes effect starting today, same as "future" below.
          const startDate = draftRecurrenceType === "oneoff" ? draftStartDate : todayISO();
          const result = await updateCarpoolSchedule(
            carpool.code,
            { type: draftRecurrenceType, daysOfWeek: draftRecurrenceType === "oneoff" ? undefined : draftDaysOfWeek, startDate },
            { time: draftDropOffTime, cars: era.defaultDropOff.cars },
            { time: draftPickUpTime, cars: era.defaultPickUp.cars }
          );
          onCarpoolUpdated(result);
        }
      } else if (structureChanged || timeChanged) {
        const startDate =
          draftRecurrenceType === "oneoff" ? draftStartDate : occurrence ? occurrence.date : todayISO();
        const result = await updateCarpoolSchedule(
          carpool.code,
          { type: draftRecurrenceType, daysOfWeek: draftRecurrenceType === "oneoff" ? undefined : draftDaysOfWeek, startDate },
          { time: draftDropOffTime, cars: era.defaultDropOff.cars },
          { time: draftPickUpTime, cars: era.defaultPickUp.cars }
        );
        onCarpoolUpdated(result);
      }

      await updateCarpoolLabel(carpool.code, {
        name: draftName.trim() || undefined,
        destination: { street: draftStreet.trim(), zip: draftZip.trim() },
        timezone: draftTimezone,
      });
      const withKids = await joinCarpool(carpool.code, { ...realSelf, kids: draftKids });
      onCarpoolUpdated(withKids);
      closeCarpoolEditor();
    } finally {
      setSaving(false);
      setApplyingScope(null);
    }
  };

  // Whether the day(s)/how-often/time actually changed enough to need a
  // scope choice at all — a one-off never does (there's only one
  // occurrence, nothing to disambiguate).
  const scheduleAmbiguous = () => {
    const { era, structureChanged, timeChanged } = scheduleDiff();
    if (!structureChanged && !timeChanged) return false;
    if (era.type === "oneoff" && draftRecurrenceType === "oneoff") return false;
    return true;
  };

  // Whether anything in the sheet actually differs from what's saved —
  // gates showing a Save button at all, so opening the editor and closing it
  // without touching anything doesn't dangle an always-live button.
  const hasUnsavedChanges = () => {
    const { structureChanged, timeChanged } = scheduleDiff();
    const nameChanged = draftName.trim() !== carpool.name;
    const streetChanged = draftStreet.trim() !== (carpool.destination?.street ?? "");
    const zipChanged = draftZip.trim() !== (carpool.destination?.zip ?? "");
    const timezoneChanged = draftTimezone !== (carpool.timezone || detectTimezone());
    const kidsChanged =
      JSON.stringify([...draftKids].sort()) !== JSON.stringify([...(realSelf?.kids ?? [])].sort());
    return (
      structureChanged || timeChanged || nameChanged || streetChanged || zipChanged || timezoneChanged || kidsChanged
    );
  };

  // Saving with no kids left selected doesn't mean "nothing arranged" — it
  // means you're not in this carpool anymore. Confirm that before it happens
  // instead of saving straight through, regardless of which button triggered it.
  const handleScopeClick = (scope: "future" | "all" | "occurrence") => {
    if (draftKids.length === 0) {
      setPendingLeave(true);
      return;
    }
    // "All" and "this and all future" are the two harder-to-undo choices —
    // confirm before applying. "Just this one" doesn't need it: low-impact,
    // easy to revisit from the date switcher.
    if (scope === "all" || scope === "future") {
      setConfirmingScope(scope);
      return;
    }
    commitSave(scope);
  };

  const confirmScopeAndSave = () => {
    if (!confirmingScope) return;
    const scope = confirmingScope;
    closeConfirmingScope();
    commitSave(scope);
  };

  // Nothing schedule-related changed — a plain save, no scope question.
  const handlePlainSave = () => {
    if (draftKids.length === 0) {
      setPendingLeave(true);
      return;
    }
    commitSave("future");
  };

  const confirmLeave = async () => {
    if (!self) return;
    setConfirmingLeave(true);
    try {
      await updateCarpoolLabel(carpool.code, {
        name: draftName.trim() || undefined,
        destination: { street: draftStreet.trim(), zip: draftZip.trim() },
        timezone: draftTimezone,
      });
      // Leaving doesn't ask about schedule scope — whatever day/time edits
      // were made apply "from now on," same as the app always did before a
      // leave flow existed at all.
      const { era, structureChanged, timeChanged } = scheduleDiff();
      if (structureChanged || timeChanged) {
        const startDate = draftRecurrenceType === "oneoff" ? draftStartDate : todayISO();
        await updateCarpoolSchedule(
          carpool.code,
          { type: draftRecurrenceType, daysOfWeek: draftRecurrenceType === "oneoff" ? undefined : draftDaysOfWeek, startDate },
          { time: draftDropOffTime, cars: era.defaultDropOff.cars },
          { time: draftPickUpTime, cars: era.defaultPickUp.cars }
        );
      }
      await joinCarpool(carpool.code, { ...self, kids: [] });
      onCarpoolLeft(carpool.code);
      closePendingLeave();
      closeCarpoolEditor();
      onBack();
    } finally {
      setConfirmingLeave(false);
    }
  };

  const toggleDropOff = async () => {
    if (!self || !realSelf) return;
    setTogglingDropOff(true);
    try {
      const turningOn = !self.canDriveDropOff;
      const result = await joinCarpool(carpool.code, {
        ...realSelf,
        canDriveDropOff: turningOn,
      });
      onCarpoolUpdated(result);
      if (turningOn) {
        const updatedSelf = result.carpool.members.find((m) => m.id === memberId);
        const freshOcc = result.occurrences.find((o) => o.date === occurrence?.date);
        const offer = kidsToOfferMove(freshOcc?.dropOff?.cars ?? [], memberId, updatedSelf?.kids ?? []);
        setMovePrompt(offer.length > 0 ? { leg: "dropOff", kids: offer } : null);
      } else {
        setMovePrompt((p) => (p?.leg === "dropOff" ? null : p));
      }
    } finally {
      setTogglingDropOff(false);
    }
  };

  const togglePickUp = async () => {
    if (!self || !realSelf) return;
    setTogglingPickUp(true);
    try {
      const turningOn = !self.canDrivePickUp;
      const result = await joinCarpool(carpool.code, {
        ...realSelf,
        canDrivePickUp: turningOn,
      });
      onCarpoolUpdated(result);
      if (turningOn) {
        const updatedSelf = result.carpool.members.find((m) => m.id === memberId);
        const freshOcc = result.occurrences.find((o) => o.date === occurrence?.date);
        const offer = kidsToOfferMove(freshOcc?.pickUp?.cars ?? [], memberId, updatedSelf?.kids ?? []);
        setMovePrompt(offer.length > 0 ? { leg: "pickUp", kids: offer } : null);
      } else {
        setMovePrompt((p) => (p?.leg === "pickUp" ? null : p));
      }
    } finally {
      setTogglingPickUp(false);
    }
  };

  // Editing the default/nearest occurrence behaves exactly like the old
  // single-schedule app always did — the change applies today and carries
  // forward. Navigating to view a *different*, further-out date and editing
  // there is how the new "just this one" override gets used: no extra
  // confirmation step, the date you're looking at already tells you the
  // scope.
  const updateLegCars = async (leg: "dropOff" | "pickUp", cars: Car[]) => {
    if (!occurrence) return;
    if (isEditingDefaultOccurrence) {
      const era = currentEra(series);
      const result = await updateCarpoolSchedule(
        carpool.code,
        { type: era.type, daysOfWeek: era.type === "oneoff" ? undefined : era.daysOfWeek, startDate: todayISO() },
        leg === "dropOff" ? { time: occurrence.dropOff.time, cars } : occurrence.dropOff,
        leg === "pickUp" ? { time: occurrence.pickUp.time, cars } : occurrence.pickUp
      );
      onCarpoolUpdated(result);
    } else {
      const fields =
        leg === "dropOff"
          ? { dropOff: { time: occurrence.dropOff.time, cars } }
          : { pickUp: { time: occurrence.pickUp.time, cars } };
      const updatedOcc = await updateOccurrence(carpool.code, occurrence.date, fields);
      onOccurrenceUpdated(updatedOcc);
    }
  };

  const applyMovePrompt = async () => {
    if (!movePrompt) return;
    setApplyingMovePrompt(true);
    try {
      const currentCars = movePrompt.leg === "dropOff" ? carpool.dropOff?.cars ?? [] : carpool.pickUp?.cars ?? [];
      const defaultSeats = currentCars.find((c) => c.driverId === memberId)?.seats ?? 1;
      const cars = movePrompt.kids.reduce((acc, kid) => moveKid(acc, kid, memberId, defaultSeats), currentCars);
      await updateLegCars(movePrompt.leg, cars);
    } finally {
      setApplyingMovePrompt(false);
      setMovePrompt(null);
    }
  };

  const dismissMovePrompt = () => setMovePrompt(null);

  // A car with someone else's kid in it still shows that kid even after this
  // toggle turns off (see syncCar) — check before flipping so we can confirm
  // first instead of surprising the driver.
  const othersKidsInCar = (leg: "dropOff" | "pickUp") => {
    if (!self) return [];
    const cars = (leg === "dropOff" ? carpool.dropOff?.cars : carpool.pickUp?.cars) ?? [];
    const car = cars.find((c) => c.driverId === memberId);
    return car ? car.kids.filter((k) => !self.kids.includes(k)) : [];
  };

  const requestToggleDropOff = () => {
    if (!self) return;
    if (self.canDriveDropOff) {
      const othersKids = othersKidsInCar("dropOff");
      if (othersKids.length > 0) {
        setPendingOff({ leg: "dropOff", kids: othersKids });
        return;
      }
    }
    toggleDropOff();
  };

  const requestTogglePickUp = () => {
    if (!self) return;
    if (self.canDrivePickUp) {
      const othersKids = othersKidsInCar("pickUp");
      if (othersKids.length > 0) {
        setPendingOff({ leg: "pickUp", kids: othersKids });
        return;
      }
    }
    togglePickUp();
  };

  const confirmToggleOff = async () => {
    if (!pendingOff) return;
    setConfirmingOff(true);
    try {
      if (pendingOff.leg === "dropOff") await toggleDropOff();
      else await togglePickUp();
    } finally {
      setConfirmingOff(false);
      closePendingOff();
    }
  };

  const cancelPendingOff = () => closePendingOff();

  // The seat count on each leg's toggle row doubles as on/off: 0 means not
  // driving. Reads back off the same source DrivingLeg uses (car.seats) — no
  // profile default to fall back to, just 1 for the sliver of a moment
  // between flipping the toggle on and the server's car actually existing.
  const legSelfSeats = (leg: "dropOff" | "pickUp") => {
    if (!self) return 0;
    const canDrive = leg === "dropOff" ? self.canDriveDropOff : self.canDrivePickUp;
    if (!canDrive) return 0;
    const cars = (leg === "dropOff" ? carpool.dropOff?.cars : carpool.pickUp?.cars) ?? [];
    return cars.find((c) => c.driverId === memberId)?.seats ?? 1;
  };

  const changeLegSeats = async (leg: "dropOff" | "pickUp", delta: number) => {
    if (!self) return;
    const current = legSelfSeats(leg);
    // Crossing either edge of the 0/1 boundary means turning driving on or
    // off, which goes through the existing toggle flow (including the
    // confirm-eviction prompt when someone else's kid is riding with you) —
    // seat-count-only edits below never touch canDriveDropOff/PickUp.
    if (current === 0 && delta > 0) {
      if (leg === "dropOff") await toggleDropOff();
      else await togglePickUp();
      return;
    }
    if (current === 1 && delta < 0) {
      if (leg === "dropOff") requestToggleDropOff();
      else requestTogglePickUp();
      return;
    }
    const clamped = Math.max(1, Math.min(8, current + delta));
    const cars = (leg === "dropOff" ? carpool.dropOff?.cars : carpool.pickUp?.cars) ?? [];
    const nextCars = cars.some((c) => c.driverId === memberId)
      ? cars.map((c) => (c.driverId === memberId ? { ...c, seats: clamped } : c))
      : [...cars, { driverId: memberId, kids: [], seats: clamped }];
    await updateLegCars(leg, nextCars);
  };

  return (
    <div className="carpool-detail">
      <div className="carpool-detail-sidebar">
        <button className="back-link" onClick={onBack}>
          &larr; All carpools
        </button>
        <div className="carpool-name-row">
          <h2>{carpool.name}</h2>
          {self && (
            <button type="button" className="text-link" onClick={openCarpoolEditor}>
              edit
            </button>
          )}
        </div>
        {upcomingOccurrences.length > 1 && (
          <div className="form-field">
            <select
              className="date-picker-select"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            >
              {upcomingOccurrences.map((o) => (
                <option key={o.date} value={o.date}>
                  {friendlyDateLabel(o.date)}
                </option>
              ))}
            </select>
            {!isEditingDefaultOccurrence && (
              <span className="muted">
                Changing your "can you drive?" status here (or moving a kid between cars) only affects
                this one date — the usual plan is untouched.
              </span>
            )}
          </div>
        )}
        <p className="carpool-subline muted">
          {upcomingOccurrences.length <= 1 && occurrence?.date ? occurrence.date : ""}
          {carpool.dropOff?.time && carpool.pickUp?.time
            ? `${upcomingOccurrences.length <= 1 && occurrence?.date ? ", " : ""}${formatTime(carpool.dropOff.time)} - ${formatTime(carpool.pickUp.time)}`
            : ""}
        </p>
        {carpool.destination?.street && (
          <p className="carpool-subline muted">
            <a
              className="address-link"
              href={mapsLink(carpool.destination.street, carpool.destination.zip)}
              target="_blank"
              rel="noreferrer"
            >
              {carpool.destination.street}
              {carpool.destination.zip ? `, ${carpool.destination.zip}` : ""}
            </a>
          </p>
        )}
        {allMyKidsSkipped && realSelf && occurrence ? (
          <RemovedKidsNotice
            className="removed-kids-notice-mobile-only"
            kids={realSelf.kids}
            onAddBack={async (kid) => {
              setTogglingSkipKid(kid);
              try {
                const updatedOcc = await skipKid(carpool.code, occurrence.date, kid, false, memberId);
                onOccurrenceUpdated(updatedOcc);
              } finally {
                setTogglingSkipKid(null);
              }
            }}
            togglingKid={togglingSkipKid}
          />
        ) : (
          <>
            {self && youSummary && (
              <div className="ai-summary ai-summary-mobile-only">
                <p className="ai-summary-quote">
                  {typedSummary}
                  <span
                    className={`ai-summary-cursor ${typingDone ? "" : "typing"}`}
                    aria-hidden="true"
                  />
                </p>
              </div>
            )}
            {renderSkipKidLinks("skip-kid-links-mobile-only")}
            {hasDrivingStops && (
              <div className="driving-stops-section driving-stops-mobile-only">{drivingStops}</div>
            )}
          </>
        )}

        <div className="schedule-summary">
          <h3 className="bliss-heading can-drive-heading">Can you drive more kids?</h3>
          <div className="schedule-legs">
            <div className="leg-toggle-stack">
              <LegToggleRow
                label="Drop-off"
                time={carpool.dropOff?.time ?? ""}
                seats={legSelfSeats("dropOff")}
                disabled={!self || togglingDropOff || allMyKidsSkipped}
                onChange={(delta) => changeLegSeats("dropOff", delta)}
              />
              {movePrompt?.leg === "dropOff" && (
                <AiMovePrompt
                  kids={movePrompt.kids}
                  legLabel="drop-off"
                  onConfirm={applyMovePrompt}
                  onDismiss={dismissMovePrompt}
                  busy={applyingMovePrompt}
                />
              )}
            </div>
            <div className="leg-toggle-stack">
              <LegToggleRow
                label="Pick-up"
                time={carpool.pickUp?.time ?? ""}
                seats={legSelfSeats("pickUp")}
                disabled={!self || togglingPickUp || allMyKidsSkipped}
                onChange={(delta) => changeLegSeats("pickUp", delta)}
              />
              {movePrompt?.leg === "pickUp" && (
                <AiMovePrompt
                  kids={movePrompt.kids}
                  legLabel="pick-up"
                  onConfirm={applyMovePrompt}
                  onDismiss={dismissMovePrompt}
                  busy={applyingMovePrompt}
                />
              )}
            </div>
          </div>
        </div>

        {!soloMember && (
          <>
            <BuyMeACoffeeLink className="coffee-link-sidebar" />
            <div className="invite-box">
              <span className="invite-label">Carpool invite code</span>
              <span className="invite-code">{carpool.code}</span>
              <button type="button" className="pill-button secondary" onClick={copyLink}>
                {copied ? "Copied!" : "Copy invite link"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="carpool-detail-main">
        {soloMember ? (
          <div className="solo-invite-panel">
            <h3 className="bliss-heading">You're the only one here so far</h3>
            <p className="muted">Share this code to get someone else driving with you.</p>
            <div className="invite-box invite-box-main">
              <span className="invite-label">Carpool invite code</span>
              <span className="invite-code">{carpool.code}</span>
              <button type="button" className="pill-button secondary" onClick={copyLink}>
                {copied ? "Copied!" : "Copy invite link"}
              </button>
            </div>
          </div>
        ) : allMyKidsSkipped && realSelf && occurrence ? (
          <RemovedKidsNotice
            className="removed-kids-notice-desktop-only"
            kids={realSelf.kids}
            onAddBack={async (kid) => {
              setTogglingSkipKid(kid);
              try {
                const updatedOcc = await skipKid(carpool.code, occurrence.date, kid, false, memberId);
                onOccurrenceUpdated(updatedOcc);
              } finally {
                setTogglingSkipKid(null);
              }
            }}
            togglingKid={togglingSkipKid}
          />
        ) : (
          <>
            {self && youSummary ? (
              <div className="ai-summary ai-summary-desktop-only">
                <p className="ai-summary-quote">
                  {typedSummary}
                  <span
                    className={`ai-summary-cursor ${typingDone ? "" : "typing"}`}
                    aria-hidden="true"
                  />
                </p>
              </div>
            ) : (
              <h3 className="bliss-heading">Who's driving who?</h3>
            )}
            {renderSkipKidLinks("skip-kid-links-desktop-only")}
            <DrivingLeg
              label="Drop-off"
              time={carpool.dropOff?.time ?? ""}
              cars={carpool.dropOff?.cars ?? []}
              members={carpool.members}
              memberId={memberId}
              eligibleFor={(m) => m.canDriveDropOff}
              onCarsChange={(cars) => updateLegCars("dropOff", cars)}
              kidDefaults={kidDefaults}
              coParentId={household?.coParentId ?? null}
              householdCombined={household?.combined ?? false}
            />
            <DrivingLeg
              label="Pick-up"
              time={carpool.pickUp?.time ?? ""}
              cars={carpool.pickUp?.cars ?? []}
              members={carpool.members}
              memberId={memberId}
              eligibleFor={(m) => m.canDrivePickUp}
              onCarsChange={(cars) => updateLegCars("pickUp", cars)}
              kidDefaults={kidDefaults}
              coParentId={household?.coParentId ?? null}
              householdCombined={household?.combined ?? false}
            />
            {hasDrivingStops && (
              <div className="driving-stops-section driving-stops-desktop-only">{drivingStops}</div>
            )}
          </>
        )}
      </div>

      <BottomSheet
        open={editingCarpool}
        onClose={closeCarpoolEditor}
        title={`Edit ${carpool.name}`}
        footer={
          scheduleAmbiguous() ? (
            <>
              <span className="sheet-footer-label">Save changes</span>
              <button
                type="button"
                className="pill-button secondary"
                onClick={() => handleScopeClick("all")}
                disabled={saving}
              >
                All events
              </button>
              <button
                type="button"
                className="pill-button secondary"
                onClick={() => handleScopeClick("future")}
                disabled={saving}
              >
                This event forward
              </button>
              {justThisOneAvailable && (
                <button
                  type="button"
                  className="pill-button"
                  onClick={() => handleScopeClick("occurrence")}
                  disabled={saving}
                >
                  {applyingScope === "occurrence" ? "Saving..." : "Just this event"}
                </button>
              )}
            </>
          ) : hasUnsavedChanges() ? (
            <>
              <span className="sheet-footer-label">Save changes</span>
              <button type="button" className="pill-button" onClick={handlePlainSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          ) : undefined
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Carpool name</span>
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">How often</span>
          <div className="segmented-group">
            <button
              type="button"
              className={`segmented-btn ${draftRecurrenceType === "weekly" ? "active" : ""}`}
              onClick={() => setDraftRecurrenceType("weekly")}
            >
              Every week
            </button>
            <button
              type="button"
              className={`segmented-btn ${draftRecurrenceType === "biweekly" ? "active" : ""}`}
              onClick={() => setDraftRecurrenceType("biweekly")}
            >
              Every other week
            </button>
            <button
              type="button"
              className={`segmented-btn ${draftRecurrenceType === "oneoff" ? "active" : ""}`}
              onClick={() => setDraftRecurrenceType("oneoff")}
            >
              Just once
            </button>
          </div>
        </div>
        {draftRecurrenceType !== "oneoff" && (
          <div className="form-field">
            <span className="gate-field-label">Which day(s)</span>
            <div className="segmented-group">
              {DAYS_OF_WEEK.map((d) => (
                <button
                  type="button"
                  key={d}
                  className={`segmented-btn ${draftDaysOfWeek.includes(d) ? "active" : ""}`}
                  onClick={() =>
                    setDraftDaysOfWeek((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
                  }
                >
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
        )}
        {draftRecurrenceType === "oneoff" && (
          <div className="form-field">
            <span className="gate-field-label">Date</span>
            <input
              type="date"
              value={draftStartDate}
              min={todayISO()}
              onChange={(e) => setDraftStartDate(e.target.value)}
            />
          </div>
        )}
        <div className="field-row">
          <div className="form-field">
            <span className="gate-field-label">Drop-off time</span>
            <input
              type="time"
              value={draftDropOffTime}
              onChange={(e) => setDraftDropOffTime(e.target.value)}
              onInvalid={(e) => e.preventDefault()}
            />
          </div>
          <div className="form-field">
            <span className="gate-field-label">Pick-up time</span>
            <input
              type="time"
              value={draftPickUpTime}
              onChange={(e) => setDraftPickUpTime(e.target.value)}
              onInvalid={(e) => e.preventDefault()}
            />
          </div>
        </div>
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={draftStreet} onChange={(e) => setDraftStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={draftZip} onChange={(e) => setDraftZip(e.target.value)} inputMode="numeric" />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Timezone</span>
          <select value={draftTimezone} onChange={(e) => setDraftTimezone(e.target.value)}>
            {draftTimezoneOptions.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
        </div>
        <KidPicker
          allKids={allKids}
          selected={draftKids}
          onChange={setDraftKids}
          label="Which of your kids is in this carpool?"
        />
        {scheduleAmbiguous() && !justThisOneAvailable && (
          <p className="muted">
            "Just this one" isn't offered here — it only applies when how often stays the same and just one
            day changed at once.
          </p>
        )}
      </BottomSheet>

      <BottomSheet
        open={!!pendingOff}
        onClose={cancelPendingOff}
        title="Stop driving this leg?"
        footer={
          <>
            <button type="button" className="pill-button" onClick={cancelPendingOff} disabled={confirmingOff}>
              No, keep driving
            </button>
            <button
              type="button"
              className="pill-button danger"
              onClick={confirmToggleOff}
              disabled={confirmingOff}
            >
              {confirmingOff ? "Moving..." : "Yes, move them"}
            </button>
          </>
        }
      >
        <p>
          <span className="confirm-off-kids">
            {(pendingOff?.kids ?? []).map((k) => (
              <span className="confirm-kid-chip" key={k}>
                {k}
              </span>
            ))}
          </span>{" "}
          {(pendingOff?.kids.length ?? 0) > 1 ? "ride" : "rides"} with you right now. Turning this off will
          move {(pendingOff?.kids.length ?? 0) > 1 ? "them" : "them"} back to{" "}
          {(pendingOff?.kids.length ?? 0) > 1 ? "their own parents'" : "their own parent's"} car.
        </p>
      </BottomSheet>

      <BottomSheet
        open={pendingLeave}
        onClose={closePendingLeave}
        title="Leave this carpool?"
        footer={
          <>
            <button
              type="button"
              className="pill-button"
              onClick={closePendingLeave}
              disabled={confirmingLeave}
            >
              No, go back
            </button>
            <button
              type="button"
              className="pill-button danger"
              onClick={confirmLeave}
              disabled={confirmingLeave}
            >
              {confirmingLeave ? "Leaving..." : "Yes, leave"}
            </button>
          </>
        }
      >
        <p>
          You've removed all of your kids from this carpool. Saving will remove you
          {household?.coParentId ? " (and your linked co-parent, if they're in it too)" : ""} from it.
        </p>
      </BottomSheet>

      <BottomSheet
        open={!!confirmingScope}
        onClose={closeConfirmingScope}
        title={confirmingScope === "all" ? "Change every date?" : "Change this and every future date?"}
        footer={
          <>
            <button type="button" className="pill-button" onClick={closeConfirmingScope} disabled={!!applyingScope}>
              Cancel
            </button>
            <button type="button" className="pill-button secondary" onClick={confirmScopeAndSave} disabled={!!applyingScope}>
              {applyingScope ? "Saving..." : "Confirm"}
            </button>
          </>
        }
      >
        <p className="muted">
          {confirmingScope === "all"
            ? "This rewrites every date for this carpool, including ones already past — not just from here forward."
            : `This changes every date from ${occurrence?.date} onward, but leaves earlier dates as they were.`}
        </p>
      </BottomSheet>
    </div>
  );
}
