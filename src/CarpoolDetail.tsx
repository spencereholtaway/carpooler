import { useEffect, useState } from "react";
import { getHousehold, joinCarpool, updateCarpoolSchedule } from "./api";
import { BottomSheet } from "./BottomSheet";
import { computeKidDefaults, formatTime, joinList, resolveKidDrivers, summarizeCarpool } from "./carpoolSummary";
import { KidPicker } from "./KidPicker";
import { computeAutoRoute, type AutoRouteLegKind, type NamedStop } from "./autoRoute";
import { mapsLink, multiStopMapsLink } from "./maps";
import { DAYS_OF_WEEK, type Address, type Car, type Carpool, type DayOfWeek, type Member } from "./types";
import { useTypewriter } from "./useTypewriter";

function moveKid(cars: Car[], kid: string, driverId: string | null): Car[] {
  const cleared = cars.map((c) => ({ ...c, kids: c.kids.filter((k) => k !== kid) }));
  if (!driverId) return cleared;
  // A member who isn't marked as driving this leg has no car entry at all —
  // moving a kid to them (e.g. their own kid, regardless of that toggle)
  // needs to create one rather than silently no-op.
  if (!cleared.some((c) => c.driverId === driverId)) {
    return [...cleared, { driverId, kids: [kid] }];
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

// A row of directions buttons, one per stop — every drive is at least two
// locations (where you're coming from, where you're going), even when
// that's just "Home" and the carpool's own destination.
function DrivingStops({
  legLabel,
  stops,
}: {
  legLabel: string;
  stops: { label: string; address: Address | undefined }[];
}) {
  const validStops = stops.filter((s): s is { label: string; address: Address } => !!s.address?.street);
  if (validStops.length === 0) return null;
  return (
    <div className="driving-stops">
      <span className="driving-stops-label muted">{legLabel}</span>
      <div className="driving-stops-buttons">
        {validStops.map((s) => (
          <a
            key={s.label}
            className="pill-button small secondary driving-stop-button"
            href={mapsLink(s.address.street, s.address.zip)}
            target="_blank"
            rel="noreferrer"
          >
            {s.label}
          </a>
        ))}
      </div>
    </div>
  );
}

const AUTO_ROUTE_ERROR_COPY: Record<Exclude<Awaited<ReturnType<typeof computeAutoRoute>>, { ok: true }>["reason"], string> = {
  "geolocation-denied": "Location access denied — enable it to use Auto Route.",
  "geolocation-unavailable": "Couldn't get your location. Try again.",
  "geocode-failed": "Couldn't look up one of the addresses. Try again.",
  "too-few-stops": "",
};

// Beta: figures out a good order to visit the "other kids" stops and hands
// the whole route (in that order) to the driver's Maps app at once, instead
// of the one-stop-at-a-time links DrivingStops offers above. Each qualifying
// leg (drop-off and/or pick-up) becomes one of these, offered from the FAB's
// bottom sheet below.
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
  // A single kid isn't worth reordering — but when there's also a fixed
  // stop (pick-up's drive to the destination before any kid), even one kid
  // makes for a genuine multi-stop route worth chaining into one link.
  const minKidStops = extraFixedStop ? 1 : 2;
  if (kidHomeStops.length < minKidStops) return null;
  if (!bookend.address?.street) return null;
  if (extraFixedStop && !extraFixedStop.address?.street) return null;
  return { legKind, label, kidHomeStops, bookend: bookend as NamedStop, extraFixedStop: extraFixedStop as NamedStop | undefined };
}

function AutoRouteLegOption({ leg }: { leg: AutoRouteLeg }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
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
      // Don't navigate here: the geolocation/geocoding above is async, so by
      // the time it resolves the click's user-activation window is gone.
      // Without it, iOS Safari won't hand the maps.apple.com link off to the
      // Maps app — it just opens the website instead. Surfacing a real link
      // for the user to tap gives that tap its own fresh activation, which
      // does get the handoff (same root cause as the window.open popup-
      // blocking issue this replaced).
      setReadyUrl(multiStopMapsLink(result.orderedStops.map((s) => s.address)));
      setState("ready");
    } catch (err) {
      // Without this, an unexpected throw here (rather than the ok:false
      // path above) left the button stuck on "Finding best route…" forever
      // with no visible sign anything went wrong.
      console.error("Auto Route threw:", err);
      setState("error");
      setErrorMsg("Something went wrong finding the route. Try again.");
    }
  };

  if (state === "ready" && readyUrl) {
    return (
      <div className="auto-route-option">
        <a
          className="pill-button auto-route-option-button"
          href={readyUrl}
          onClick={() => {
            setState("idle");
            setReadyUrl(null);
          }}
        >
          Open in Maps
        </a>
      </div>
    );
  }

  return (
    <div className="auto-route-option">
      <button type="button" className="pill-button auto-route-option-button" onClick={handleClick} disabled={state === "loading"}>
        {state === "loading" ? "Finding best route…" : leg.label}
      </button>
      {state === "error" && errorMsg && <span className="auto-route-error muted">{errorMsg}</span>}
    </div>
  );
}

// Mobile-only floating action button (see CSS) that surfaces the beta
// multi-stop routing feature without cluttering the per-stop directions
// buttons above — only appears when a leg actually has stops worth
// optimizing.
function AutoRouteFab({ legs }: { legs: AutoRouteLeg[] }) {
  const [open, setOpen] = useState(false);
  if (legs.length === 0) return null;

  return (
    <>
      <button type="button" className="auto-route-fab" onClick={() => setOpen(true)} aria-label="blisspoolAI Auto Route">
        <span className="auto-route-fab-sparkle" aria-hidden="true">
          ✨
        </span>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
          <path
            d="M9 4L4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="This looks like a complicated ride!">
        <p className="auto-route-sheet-body">Try blisspoolAI auto-route!</p>
        <div className="auto-route-sheet-options">
          {legs.map((leg) => (
            <AutoRouteLegOption key={leg.legKind} leg={leg} />
          ))}
        </div>
      </BottomSheet>
    </>
  );
}

function LegToggleRow({
  label,
  time,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  time: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`leg-toggle-row ${checked ? "checked" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={checked}
    >
      <span className="leg-toggle-info">
        <strong>{label}</strong>
        <span className="muted">{formatTime(time)}</span>
      </span>
      <span className="leg-check-group">
        <span className="leg-check-label">I can drive</span>
        <span className="leg-check" aria-hidden="true">
          {checked && (
            <svg viewBox="0 0 16 16" width="11" height="11">
              <path
                d="M3 8.5L6.2 11.5L13 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </span>
    </button>
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
    const kids = car
      ? car.kids
      : m.kids.filter((k) => !assignedElsewhere.has(k) && kidDefaults.get(k) === m.id);
    const eligible = eligibleFor(m);
    // A member's seat count is total car capacity, including their own
    // kid(s) — every kid riding along counts against it.
    const free = eligible ? Math.max(m.seats - kids.length, 0) : 0;
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
      displayName: isSelf ? "You" : m.name,
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
        displayName: `You & ${coEntry.m.name}`,
      };
      mergedRowData = [merged, ...rowData.filter((r) => !r.isSelf && r.m.id !== coParentId)];
    }
  }

  // You first, then your co-parent, then cars with free seats, then everyone
  // else — alphabetical by name within each tier.
  const rows = [...mergedRowData].sort((a, b) => {
    const rank = (r: (typeof mergedRowData)[number]) =>
      r.isSelf ? 0 : r.m.id === coParentId ? 1 : r.eligible && r.free > 0 ? 2 : 3;
    const rankDiff = rank(a) - rank(b);
    return rankDiff !== 0 ? rankDiff : a.m.name.localeCompare(b.m.name);
  });

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
        {rows.map(({ m, kids, eligible, free, isCoParent, canMoveHere, movableKids, displayName }) => {
          const expanded = canMoveHere && expandedRow === m.id;
          const closing = canMoveHere && closingRow === m.id;
          const multiPick = movableKids.length > 1;

          // Selecting past this car's free-seat capacity swaps in the new
          // kid for the oldest one already picked (with a note explaining
          // why) rather than silently refusing — every kid, including the
          // driver's own, counts against capacity now.
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
            onCarsChange(kidsToMove.reduce((acc, kid) => moveKid(acc, kid, m.id), cars));
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
                          {k}
                        </span>
                      ))}
                    {kids.some((k) => !myKids.has(k)) && (
                      <span className="muted">{kids.filter((k) => !myKids.has(k)).join(", ")}</span>
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
                      Move {movableKids[0]} here
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
                        {kid}
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
        })}
      </div>
    </div>
  );
}

export function CarpoolDetail({
  carpool,
  memberId,
  allKids,
  onBack,
  onCarpoolUpdated,
}: {
  carpool: Carpool;
  memberId: string;
  allKids: string[];
  onBack: () => void;
  onCarpoolUpdated: (carpool: Carpool) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editingCarpool, setEditingCarpool] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDropOff, setTogglingDropOff] = useState(false);
  const [togglingPickUp, setTogglingPickUp] = useState(false);
  const [movePrompt, setMovePrompt] = useState<{ leg: "dropOff" | "pickUp"; kids: string[] } | null>(
    null
  );
  const [applyingMovePrompt, setApplyingMovePrompt] = useState(false);
  // Turning off a leg's driving toggle evicts anyone else's kid riding in
  // that car (see syncCar server-side) — gate that behind an explicit
  // confirmation instead of letting a toggle click silently bounce someone
  // else's kid back to their own parent.
  const [pendingOff, setPendingOff] = useState<{ leg: "dropOff" | "pickUp"; kids: string[] } | null>(
    null
  );
  const [confirmingOff, setConfirmingOff] = useState(false);

  const self = carpool.members.find((m) => m.id === memberId);
  // With nobody else to coordinate with yet, "who's driving who" has only
  // one answer — swap that whole section out for a prominent invite instead.
  const soloMember = carpool.members.length === 1;
  const [draftKids, setDraftKids] = useState<string[]>(self?.kids ?? []);
  const [draftName, setDraftName] = useState(carpool.name);
  const [draftDay, setDraftDay] = useState<DayOfWeek>(carpool.day);
  const [draftStreet, setDraftStreet] = useState(carpool.destination?.street ?? "");
  const [draftZip, setDraftZip] = useState(carpool.destination?.zip ?? "");
  const [draftDropOffTime, setDraftDropOffTime] = useState(carpool.dropOff?.time ?? "");
  const [draftPickUpTime, setDraftPickUpTime] = useState(carpool.pickUp?.time ?? "");
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
  const onlyOwnKids = hasDrivingStops && dropOffOtherKids.length === 0 && pickUpOtherKids.length === 0;
  const homeAddress: Address | undefined = self ? { street: self.street, zip: self.zip } : undefined;
  // Rendered twice (mobile/desktop), same as the AI summary above it — see
  // the CSS toggle at the 900px breakpoint.
  const drivingStops = hasDrivingStops && (
    onlyOwnKids ? (
      // Nobody else to route past — just the day's two locations, no need
      // to call out which leg is which.
      <DrivingStops
        legLabel="Directions"
        stops={[
          { label: "Home", address: homeAddress },
          { label: carpool.name, address: carpool.destination },
        ]}
      />
    ) : (
      <>
        {dropOffDrivingKids.length > 0 && (
          <DrivingStops
            legLabel="Drop-off directions"
            stops={[
              ...dropOffOtherKids.map((kid) => ({ label: kid, address: kidHome(kid) })),
              { label: carpool.name, address: carpool.destination },
            ]}
          />
        )}
        {pickUpDrivingKids.length > 0 && (
          <DrivingStops
            legLabel="Pick-up directions"
            stops={[
              { label: carpool.name, address: carpool.destination },
              ...pickUpOtherKids.map((kid) => ({ label: kid, address: kidHome(kid) })),
              { label: "Home", address: homeAddress },
            ]}
          />
        )}
      </>
    )
  );
  // Drop-off only chains once there are 2+ other-family stops to actually
  // put in order — with one kid there's nothing to optimize beyond what the
  // single-stop buttons above already offer. Pick-up always drives to the
  // destination first, so even one kid still makes for a genuine multi-stop
  // route worth bundling into one link (see buildAutoRouteLeg).
  const autoRouteLegs = [
    buildAutoRouteLeg("dropOff", "Optimize drop-off route", dropOffOtherKids, kidHome, {
      label: carpool.name,
      address: carpool.destination,
    }),
    buildAutoRouteLeg(
      "pickUp",
      "Optimize pick-up route",
      pickUpOtherKids,
      kidHome,
      { label: "Home", address: homeAddress },
      { label: carpool.name, address: carpool.destination },
    ),
  ].filter((leg): leg is AutoRouteLeg => leg !== null);

  const openCarpoolEditor = () => {
    setDraftKids(self?.kids ?? []);
    setDraftName(carpool.name);
    setDraftDay(carpool.day);
    setDraftStreet(carpool.destination?.street ?? "");
    setDraftZip(carpool.destination?.zip ?? "");
    setDraftDropOffTime(carpool.dropOff?.time ?? "");
    setDraftPickUpTime(carpool.pickUp?.time ?? "");
    setEditingCarpool(true);
  };

  const copyLink = async () => {
    const link = `${window.location.origin}?join=${carpool.code}`;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveCarpool = async () => {
    if (!self) return;
    setSaving(true);
    try {
      const updated = await updateCarpoolSchedule(
        carpool.code,
        draftDay,
        { street: draftStreet.trim(), zip: draftZip.trim() },
        { time: draftDropOffTime, cars: carpool.dropOff?.cars ?? [] },
        { time: draftPickUpTime, cars: carpool.pickUp?.cars ?? [] },
        draftName.trim() || undefined
      );
      const withKids = await joinCarpool(updated.code, { ...self, kids: draftKids });
      onCarpoolUpdated(withKids);
      setEditingCarpool(false);
    } finally {
      setSaving(false);
    }
  };

  const toggleDropOff = async () => {
    if (!self) return;
    setTogglingDropOff(true);
    try {
      const turningOn = !self.canDriveDropOff;
      const updated = await joinCarpool(carpool.code, {
        ...self,
        canDriveDropOff: turningOn,
      });
      onCarpoolUpdated(updated);
      if (turningOn) {
        const updatedSelf = updated.members.find((m) => m.id === memberId);
        const offer = kidsToOfferMove(updated.dropOff?.cars ?? [], memberId, updatedSelf?.kids ?? []);
        setMovePrompt(offer.length > 0 ? { leg: "dropOff", kids: offer } : null);
      } else {
        setMovePrompt((p) => (p?.leg === "dropOff" ? null : p));
      }
    } finally {
      setTogglingDropOff(false);
    }
  };

  const togglePickUp = async () => {
    if (!self) return;
    setTogglingPickUp(true);
    try {
      const turningOn = !self.canDrivePickUp;
      const updated = await joinCarpool(carpool.code, {
        ...self,
        canDrivePickUp: turningOn,
      });
      onCarpoolUpdated(updated);
      if (turningOn) {
        const updatedSelf = updated.members.find((m) => m.id === memberId);
        const offer = kidsToOfferMove(updated.pickUp?.cars ?? [], memberId, updatedSelf?.kids ?? []);
        setMovePrompt(offer.length > 0 ? { leg: "pickUp", kids: offer } : null);
      } else {
        setMovePrompt((p) => (p?.leg === "pickUp" ? null : p));
      }
    } finally {
      setTogglingPickUp(false);
    }
  };

  const updateLegCars = async (leg: "dropOff" | "pickUp", cars: Car[]) => {
    const updated = await updateCarpoolSchedule(
      carpool.code,
      carpool.day,
      carpool.destination,
      leg === "dropOff" ? { time: carpool.dropOff?.time ?? "", cars } : carpool.dropOff,
      leg === "pickUp" ? { time: carpool.pickUp?.time ?? "", cars } : carpool.pickUp
    );
    onCarpoolUpdated(updated);
  };

  const applyMovePrompt = async () => {
    if (!movePrompt) return;
    setApplyingMovePrompt(true);
    try {
      const currentCars = movePrompt.leg === "dropOff" ? carpool.dropOff?.cars ?? [] : carpool.pickUp?.cars ?? [];
      const cars = movePrompt.kids.reduce((acc, kid) => moveKid(acc, kid, memberId), currentCars);
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
      setPendingOff(null);
    }
  };

  const cancelPendingOff = () => setPendingOff(null);

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
        <p className="carpool-subline muted">
          {carpool.day ?? "No day set"}
          {carpool.dropOff?.time && carpool.pickUp?.time
            ? `, ${formatTime(carpool.dropOff.time)} - ${formatTime(carpool.pickUp.time)}`
            : ""}
          {carpool.destination?.street && (
            <>
              ,{" "}
              <a
                className="address-link"
                href={mapsLink(carpool.destination.street, carpool.destination.zip)}
                target="_blank"
                rel="noreferrer"
              >
                {carpool.destination.street}
                {carpool.destination.zip ? `, ${carpool.destination.zip}` : ""}
              </a>
            </>
          )}
        </p>
        {self && youSummary && (
          <div className="ai-summary ai-summary-mobile-only">
            <span className="ai-summary-badge">
              <span className="ai-summary-sparkle" aria-hidden="true">
                ✨
              </span>
              <span className="ai-summary-name">blisspoolAI</span>
              <span className="ai-summary-live" aria-hidden="true" />
            </span>
            <p className="ai-summary-quote">
              {typedSummary}
              <span
                className={`ai-summary-cursor ${typingDone ? "" : "typing"}`}
                aria-hidden="true"
              />
            </p>
          </div>
        )}
        {hasDrivingStops && (
          <div className="driving-stops-section driving-stops-mobile-only">{drivingStops}</div>
        )}

        <div className="schedule-summary">
          <h3 className="bliss-heading can-drive-heading">Can you drive?</h3>
          <div className="schedule-legs">
            <div className="leg-toggle-stack">
              <LegToggleRow
                label="Drop-off"
                time={carpool.dropOff?.time ?? ""}
                checked={self?.canDriveDropOff ?? false}
                disabled={!self || togglingDropOff}
                onToggle={requestToggleDropOff}
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
                checked={self?.canDrivePickUp ?? false}
                disabled={!self || togglingPickUp}
                onToggle={requestTogglePickUp}
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
          <div className="invite-box">
            <span className="invite-label">Invite code</span>
            <span className="invite-code">{carpool.code}</span>
            <button type="button" className="pill-button secondary" onClick={copyLink}>
              {copied ? "Copied!" : "Copy invite link"}
            </button>
          </div>
        )}
      </div>

      <div className="carpool-detail-main">
        {soloMember ? (
          <div className="solo-invite-panel">
            <h3 className="bliss-heading">You're the only one here so far</h3>
            <p className="muted">Share this code to get someone else driving with you.</p>
            <div className="invite-box invite-box-main">
              <span className="invite-label">Invite code</span>
              <span className="invite-code">{carpool.code}</span>
              <button type="button" className="pill-button secondary" onClick={copyLink}>
                {copied ? "Copied!" : "Copy invite link"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {self && youSummary ? (
              <div className="ai-summary ai-summary-desktop-only">
                <span className="ai-summary-badge">
                  <span className="ai-summary-sparkle" aria-hidden="true">
                    ✨
                  </span>
                  <span className="ai-summary-name">blisspoolAI</span>
                  <span className="ai-summary-live" aria-hidden="true" />
                </span>
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
            {hasDrivingStops && (
              <div className="driving-stops-section driving-stops-desktop-only">{drivingStops}</div>
            )}
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
          </>
        )}
      </div>

      <BottomSheet
        open={editingCarpool}
        onClose={() => setEditingCarpool(false)}
        title="Edit carpool"
        footer={
          <button type="button" className="pill-button" onClick={saveCarpool} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Carpool name</span>
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Day</span>
          <select value={draftDay} onChange={(e) => setDraftDay(e.target.value as DayOfWeek)}>
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
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
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={draftStreet} onChange={(e) => setDraftStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={draftZip} onChange={(e) => setDraftZip(e.target.value)} inputMode="numeric" />
        </div>
        <KidPicker
          allKids={allKids}
          selected={draftKids}
          onChange={setDraftKids}
          label="Which of your kids is in this carpool?"
        />
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

      <AutoRouteFab legs={autoRouteLegs} />
    </div>
  );
}
