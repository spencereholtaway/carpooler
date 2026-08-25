import { useEffect, useRef, useState } from "react";
import {
  createCarpool,
  getRecommendations,
  joinCarpool,
  listCarpools,
  type CarpoolResult,
  type RecommendationCard,
} from "./api";
import { BottomSheet } from "./BottomSheet";
import { BuyMeACoffeeLink } from "./BuyMeACoffeeLink";
import { formatTime, openSeatsFromOthers, summarizeCarpool } from "./carpoolSummary";
import { KidPicker } from "./KidPicker";
import { RecommendationsSheet } from "./RecommendationsSheet";
import {
  addDaysISO,
  COMMON_TIMEZONES,
  DAYS_OF_WEEK,
  detectTimezone,
  isoWeekday,
  mondayOfISO,
  nextValidDate,
  pickRepresentativeOccurrence,
  shortenName,
  toCarpoolView,
  todayISO,
  weeksAheadOf,
  type CarpoolOccurrence,
  type CarpoolSeries,
  type DayOfWeek,
  type RecurrenceType,
} from "./types";
import { UpdatesPage } from "./UpdatesPage";
import type { LocalProfile } from "./useProfile";
import { useTypewriter } from "./useTypewriter";

type Row = { series: CarpoolSeries; occurrence: CarpoolOccurrence };
type DateGroup = { date: string; heading: string; rows: Row[] };

// Today/Tomorrow/bare-weekday for anything within the next week, then an
// actual date once "which Saturday?" stops being obvious from context alone.
function relativeHeading(dateISO: string): string {
  const today = todayISO();
  if (dateISO === today) return "Today";
  if (dateISO === addDaysISO(today, 1)) return "Tomorrow";

  // Rest of this calendar week: bare weekday. The following week: "Next
  // <weekday>" (this is what makes the list read as one continuous
  // chronological run — Today, Tomorrow, Wednesday, ... Sunday, Next Monday,
  // Next Tuesday — rather than jumping to a bare date after just a week).
  // Two+ weeks out, "next next Wednesday" stops being a clear enough
  // marker, so it falls back to an actual date.
  const weeksOut = weeksAheadOf(dateISO, today);
  if (weeksOut === 0) return isoWeekday(dateISO);
  if (weeksOut === 1) return `Next ${isoWeekday(dateISO)}`;

  const d = new Date(dateISO + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Flags a carpool where this member is driving with room to take on another
// kid — an incentive to go fill it rather than a fact buried in the detail
// view. The day-list row gets a quiet inline hint; the "Today" row (which
// already carries a time badge in its header) gets a matching solid pill.
function OpenSeatsHint({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="open-seats-hint">
      {count} seat{count === 1 ? "" : "s"} available! →
    </span>
  );
}

function OpenSeatsPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="open-seats-pill">
      {count} seat{count === 1 ? "" : "s"} available! →
    </span>
  );
}

function TodayCarpoolRow({
  row,
  summary,
  openSeats,
  onOpen,
  start,
  onDone,
  showCursor,
}: {
  row: Row;
  summary: string;
  openSeats: number;
  onOpen: () => void;
  start: boolean;
  onDone: () => void;
  showCursor: boolean;
}) {
  const carpool = toCarpoolView(row.series, row.occurrence);
  const time = rowTimeRange(row.occurrence);
  const full = `${carpool.name}\n${time}\n${summary}`;
  const { display, done } = useTypewriter(full, 30, start);
  useEffect(() => {
    if (done) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  const [name, timeLine, ...summaryLines] = display.split("\n");
  const lastLineIndex = 2 + Math.max(summaryLines.length - 1, 0);
  const cursor = (atIndex: number) =>
    showCursor && atIndex === lastLineIndex ? (
      <span className={`ai-summary-cursor ${done ? "" : "typing"}`} aria-hidden="true" />
    ) : null;
  return (
    <button className="today-carpool" onClick={onOpen}>
      <div className="today-carpool-header">
        <div className="today-carpool-header-text">
          <span className="today-carpool-name">
            {name}
            {cursor(0)}
          </span>
          <span className="today-carpool-time">
            {timeLine}
            {cursor(1)}
          </span>
        </div>
        {done && <OpenSeatsPill count={openSeats} />}
      </div>
      <div className="today-carpool-summary">
        {summaryLines.map((line, i) => (
          <p key={i}>
            {line}
            {cursor(2 + i)}
          </p>
        ))}
      </div>
    </button>
  );
}

function rowTimeRange(occurrence: CarpoolOccurrence): string {
  const { time: drop } = occurrence.dropOff;
  const { time: pick } = occurrence.pickUp;
  if (drop && pick) return `${formatTime(drop)} - ${formatTime(pick)}`;
  if (drop) return formatTime(drop);
  if (pick) return formatTime(pick);
  return "";
}

// Show every real occurrence of every carpool in the next two weeks — one
// row per date, not one row per series — so a Mon/Wed/Fri run shows up three
// times and a biweekly one shows up whichever week it actually lands. A
// series with nothing in that window (rare: a far-future start date, or a
// biweekly cadence that skips both weeks) still gets its single nearest
// upcoming occurrence, so it never silently vanishes off the home list.
const LIST_WINDOW_DAYS = 13; // today + 13 more days = a 14-day/2-week window

function buildDateGroups(carpools: CarpoolSeries[], occurrences: CarpoolOccurrence[]): DateGroup[] {
  const occByCode = new Map<string, CarpoolOccurrence[]>();
  for (const o of occurrences) {
    if (!occByCode.has(o.code)) occByCode.set(o.code, []);
    occByCode.get(o.code)!.push(o);
  }
  const today = todayISO();
  const windowEnd = addDaysISO(today, LIST_WINDOW_DAYS);
  const rows: Row[] = [];
  for (const series of carpools) {
    const seriesOccs = occByCode.get(series.code) ?? [];
    const inWindow = seriesOccs.filter((o) => !o.cancelled && o.date >= today && o.date <= windowEnd);
    if (inWindow.length > 0) {
      for (const occurrence of inWindow) rows.push({ series, occurrence });
    } else {
      const fallback = pickRepresentativeOccurrence(seriesOccs);
      if (fallback) rows.push({ series, occurrence: fallback });
    }
  }
  const byDate = new Map<string, Row[]>();
  for (const row of rows) {
    if (!byDate.has(row.occurrence.date)) byDate.set(row.occurrence.date, []);
    byDate.get(row.occurrence.date)!.push(row);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dateRows]) => ({
      date,
      heading: relativeHeading(date),
      rows: [...dateRows].sort((a, b) => (a.occurrence.dropOff.time || "24:00").localeCompare(b.occurrence.dropOff.time || "24:00")),
    }));
}

export function CarpoolsPage({
  memberId,
  profile,
  onOpenCarpool,
  carpools,
  occurrences,
  onCarpoolsLoaded,
}: {
  memberId: string;
  profile: LocalProfile;
  onOpenCarpool: (result: CarpoolResult) => void;
  carpools: CarpoolSeries[] | null;
  occurrences: CarpoolOccurrence[] | null;
  onCarpoolsLoaded: (result: { carpools: CarpoolSeries[]; occurrences: CarpoolOccurrence[] }) => void;
}) {
  const loading = carpools === null;
  const [typedCount, setTypedCount] = useState(0);
  const cameViaInviteLink = useRef(
    /^\d{6}$/.test(new URLSearchParams(window.location.search).get("join") ?? "")
  ).current;

  const [openDialog, setOpenDialog] = useState<"join" | "create" | null>(
    cameViaInviteLink ? "join" : null
  );
  // Which of the parent's kids the join/create dialog currently has selected
  // — not tied to any one section, so either flow can cover any combination.
  const [selectedKids, setSelectedKids] = useState<string[]>(profile.kids);
  const [newName, setNewName] = useState("");
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>("weekly");
  const [daysOfWeek, setDaysOfWeek] = useState<DayOfWeek[]>([]);
  const [startMode, setStartMode] = useState<"thisWeek" | "nextWeek" | "other">("thisWeek");
  const [otherStartDate, setOtherStartDate] = useState("");
  const [destStreet, setDestStreet] = useState("");
  const [destZip, setDestZip] = useState("");
  const [dropOffTime, setDropOffTime] = useState("");
  const [pickUpTime, setPickUpTime] = useState("");
  const [timezone, setTimezone] = useState(detectTimezone);
  const timezoneOptions = COMMON_TIMEZONES.some((tz) => tz.value === timezone)
    ? COMMON_TIMEZONES
    : [{ value: timezone, label: timezone }, ...COMMON_TIMEZONES];
  const [joinCode, setJoinCode] = useState(
    () => new URLSearchParams(window.location.search).get("join") ?? ""
  );
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinInputRef = useRef<HTMLInputElement>(null);

  const [recCards, setRecCards] = useState<RecommendationCard[]>([]);
  const [showRecs, setShowRecs] = useState(false);

  useEffect(() => {
    if (openDialog === "join" && !cameViaInviteLink) joinInputRef.current?.focus();
  }, [openDialog, cameViaInviteLink]);

  useEffect(() => {
    if (carpools !== null) return;
    listCarpools(memberId).then(onCarpoolsLoaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  useEffect(() => {
    getRecommendations(memberId)
      .then(setRecCards)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  // Deep link from a calendar event ("Open in blisspool: .../?carpool=123456")
  // straight into that carpool's detail view, once the list has loaded.
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !carpools || !occurrences) return;
    const code = new URLSearchParams(window.location.search).get("carpool");
    if (!code) return;
    openedDeepLink.current = true;
    const target = carpools.find((c) => c.code === code);
    if (target) onOpenCarpool({ carpool: target, occurrences: occurrences.filter((o) => o.code === code) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carpools, occurrences]);

  // Whenever the day(s)/frequency choice changes, re-suggest a starting date
  // that's actually valid for it — otherwise switching from Tuesday to
  // Wednesday would silently leave a stale Tuesday date selected.
  useEffect(() => {
    if (recurrenceType === "oneoff" || daysOfWeek.length === 0) return;
    const today = todayISO();
    const anchor = startMode === "nextWeek" ? addDaysISO(today, 7) : today;
    setOtherStartDate(nextValidDate(daysOfWeek, anchor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daysOfWeek, recurrenceType, startMode]);

  const openJoin = () => {
    setError(null);
    setJoinCode("");
    setSelectedKids([]);
    setOpenDialog("join");
  };

  const openCreate = () => {
    setError(null);
    setNewName("");
    setRecurrenceType("weekly");
    setDaysOfWeek([]);
    setStartMode("thisWeek");
    setOtherStartDate("");
    setDestStreet("");
    setDestZip("");
    setDropOffTime("");
    setPickUpTime("");
    setSelectedKids([]);
    setOpenDialog("create");
  };

  const toggleDay = (day: DayOfWeek) => {
    setDaysOfWeek((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  };

  const canCreate =
    !!newName.trim() &&
    selectedKids.length > 0 &&
    (recurrenceType === "oneoff" ? !!otherStartDate : daysOfWeek.length > 0);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const member = {
        id: memberId,
        name: profile.name,
        kids: selectedKids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      };
      const destination = { street: destStreet, zip: destZip };
      const dropOff = { time: dropOffTime, cars: [] };
      const pickUp = { time: pickUpTime, cars: [] };
      const startDate =
        recurrenceType === "oneoff" ? otherStartDate : otherStartDate || nextValidDate(daysOfWeek, todayISO());
      const result = await createCarpool(
        trimmed,
        { type: recurrenceType, daysOfWeek: recurrenceType === "oneoff" ? undefined : daysOfWeek, startDate },
        destination,
        dropOff,
        pickUp,
        member,
        timezone
      );
      onOpenCarpool(result);
      setOpenDialog(null);
    } catch {
      setError("Couldn't create that carpool. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const code = joinCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError("Codes are 6 digits.");
      return;
    }
    if (selectedKids.length === 0) {
      setError("Pick at least one kid.");
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const member = {
        id: memberId,
        name: profile.name,
        kids: selectedKids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      };
      const result = await joinCarpool(code, member);
      onOpenCarpool(result);
      setOpenDialog(null);
    } catch {
      setError("No carpool found with that code.");
    } finally {
      setJoining(false);
    }
  };

  // All of this member's real kids in this carpool are marked "not doing it
  // this week" for this occurrence — a trip day, etc. Checked against real
  // (unfiltered) membership, not the driver-computation view, since a kid
  // being skipped is exactly the fact being tested for here.
  const isFullySkipped = (row: Row): boolean => {
    const kids = row.series.members.find((m) => m.id === memberId)?.kids ?? [];
    if (kids.length === 0) return false;
    const skipped = row.occurrence.skippedKids ?? [];
    return kids.every((k) => skipped.includes(k));
  };

  const dateGroups = buildDateGroups(carpools ?? [], occurrences ?? []);
  const today = todayISO();
  const todayGroupRows = dateGroups.find((g) => g.date === today)?.rows ?? [];
  // Fully-skipped carpools drop out of the special "Today" AI-summary
  // treatment entirely — nothing to say, no ride happening — but still show
  // up as a ghost in the plain list below, since today's date group is
  // otherwise excluded from it.
  const todayRows = todayGroupRows
    .filter((row) => !isFullySkipped(row))
    .sort((a, b) => (a.occurrence.dropOff.time || "24:00").localeCompare(b.occurrence.dropOff.time || "24:00"));
  const todayGhostRows = todayGroupRows.filter(isFullySkipped);
  const upcomingGroups = dateGroups
    .filter((g) => g.date !== today)
    .concat(todayGhostRows.length > 0 ? [{ date: today, heading: "Today", rows: todayGhostRows }] : [])
    .sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="carpools-page">
      {loading && <p className="muted">Loading...</p>}

      {carpools?.length === 0 && (
        <div className="carpools-empty">
          <h2>No carpools yet</h2>
          <p>Ask someone you know is blisspooling for a join code, or start your own.</p>
        </div>
      )}

      {!loading && todayRows.length > 0 && (
        <section className="today-summary">
          <span className="carpool-row-meta carpool-day-label">Today</span>
          {todayRows.map((row, i) => (
            <TodayCarpoolRow
              key={row.series.code}
              row={row}
              summary={summarizeCarpool(toCarpoolView(row.series, row.occurrence), memberId) || "Nothing arranged yet."}
              openSeats={openSeatsFromOthers(toCarpoolView(row.series, row.occurrence), memberId)}
              onOpen={() => onOpenCarpool({ carpool: row.series, occurrences: occurrences?.filter((o) => o.code === row.series.code) ?? [] })}
              start={i <= typedCount}
              onDone={() => setTypedCount((n) => Math.max(n, i + 1))}
              showCursor={i === todayRows.length - 1}
            />
          ))}
        </section>
      )}

      {carpools && carpools.length > 0 && (
        <section className="carpools-list">
          {upcomingGroups.map(({ date, heading, rows }, i) => (
            <div className="carpool-day-group" key={date}>
              {i > 0 && mondayOfISO(date) !== mondayOfISO(upcomingGroups[i - 1].date) && (
                <hr className="week-divider" />
              )}
              <span className="carpool-row-meta carpool-day-label">{heading}</span>
              {rows.map((row) => {
                const carpool = toCarpoolView(row.series, row.occurrence);
                const ghost = isFullySkipped(row);
                const openCarpool = () =>
                  onOpenCarpool({
                    carpool: row.series,
                    occurrences: occurrences?.filter((o) => o.code === row.series.code) ?? [],
                  });

                if (ghost) {
                  // Skipped entirely — a quiet FYI, not a summary. Dashed
                  // outline instead of the normal solid card; tapping it
                  // goes straight to the per-kid toggle to add them back.
                  const kids = row.series.members.find((m) => m.id === memberId)?.kids ?? [];
                  return (
                    <button
                      key={row.series.code}
                      className="carpool-row carpool-row-ghost"
                      style={{ borderStyle: "dashed", opacity: 0.6 }}
                      onClick={openCarpool}
                    >
                      <div className="carpool-row-top">
                        <span className="carpool-row-name">{carpool.name}</span>
                        <span className="carpool-row-time">{rowTimeRange(row.occurrence)}</span>
                      </div>
                      <p className="muted">
                        {kids.map(shortenName).join(" & ")} {kids.length > 1 ? "aren't" : "isn't"} going this week.
                      </p>
                    </button>
                  );
                }

                return (
                  <button key={row.series.code} className="carpool-row" onClick={openCarpool}>
                    <div className="carpool-row-top">
                      <span className="carpool-row-name">{carpool.name}</span>
                      <span className="carpool-row-time">{rowTimeRange(row.occurrence)}</span>
                    </div>
                    <div className="carpool-row-summary-line">
                      <div className="carpool-row-summary">
                        {(summarizeCarpool(carpool, memberId) || "Nothing arranged yet.")
                          .split("\n")
                          .map((line, i) => (
                            <p key={i}>{line}</p>
                          ))}
                      </div>
                    </div>
                    <OpenSeatsHint count={openSeatsFromOthers(carpool, memberId)} />
                  </button>
                );
              })}
            </div>
          ))}
        </section>
      )}

      {recCards.length > 0 && (
        <div className="recs-banner">
          <span className="recs-banner-headline">
            {recCards.length} recommended carpool{recCards.length === 1 ? "" : "s"}
            <span className="beta-badge">Beta</span>
          </span>
          <button type="button" className="pill-button" onClick={() => setShowRecs(true)}>
            See recommendations
          </button>
        </div>
      )}

      <div className="section-actions">
        <button type="button" className="pill-button secondary small" onClick={openJoin}>
          Join a carpool
        </button>
        <button type="button" className="pill-button secondary small" onClick={openCreate}>
          Start a carpool
        </button>
      </div>

      <RecommendationsSheet
        open={showRecs}
        onClose={() => setShowRecs(false)}
        cards={recCards}
        memberId={memberId}
        profile={profile}
        onJoined={onOpenCarpool}
      />

      <BottomSheet
        open={openDialog === "join"}
        onClose={() => setOpenDialog(null)}
        title="Join a carpool"
        footer={
          <button
            type="button"
            className="pill-button"
            onClick={handleJoin}
            disabled={joining || selectedKids.length === 0}
          >
            {joining ? "Joining..." : "Join"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Invite code</span>
          <input
            ref={joinInputRef}
            placeholder="6-digit code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
          />
        </div>
        <KidPicker
          allKids={profile.kids}
          selected={selectedKids}
          onChange={setSelectedKids}
          label="Which of your kids are joining this carpool?"
        />
        {error && <p className="form-error">{error}</p>}
      </BottomSheet>

      <BottomSheet
        open={openDialog === "create"}
        onClose={() => setOpenDialog(null)}
        title="Start a carpool"
        footer={
          <button
            type="button"
            className="pill-button"
            onClick={handleCreate}
            disabled={creating || !canCreate}
          >
            {creating ? "Creating..." : "Create carpool"}
          </button>
        }
      >
        <div className="form-field">
          <span className="gate-field-label">Carpool name</span>
          <input
            placeholder="e.g. Lincoln Elementary mornings"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <div className="form-field">
          <span className="gate-field-label">How often</span>
          <div className="kid-tags">
            <button
              type="button"
              className={`kid-pick ${recurrenceType === "weekly" ? "active" : ""}`}
              onClick={() => setRecurrenceType("weekly")}
            >
              Every week
            </button>
            <button
              type="button"
              className={`kid-pick ${recurrenceType === "biweekly" ? "active" : ""}`}
              onClick={() => setRecurrenceType("biweekly")}
            >
              Every other week
            </button>
            <button
              type="button"
              className={`kid-pick ${recurrenceType === "oneoff" ? "active" : ""}`}
              onClick={() => setRecurrenceType("oneoff")}
            >
              Just once
            </button>
          </div>
        </div>
        {recurrenceType !== "oneoff" && (
          <div className="form-field">
            <span className="gate-field-label">Which day(s)</span>
            <div className="kid-tags">
              {DAYS_OF_WEEK.map((d) => (
                <button
                  type="button"
                  key={d}
                  className={`kid-pick ${daysOfWeek.includes(d) ? "active" : ""}`}
                  onClick={() => toggleDay(d)}
                >
                  {d.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
        )}
        {recurrenceType !== "oneoff" && daysOfWeek.length > 0 && (
          <div className="form-field">
            <span className="gate-field-label">Starting</span>
            <div className="kid-tags">
              <button
                type="button"
                className={`kid-pick ${startMode === "thisWeek" ? "active" : ""}`}
                onClick={() => setStartMode("thisWeek")}
              >
                This week
              </button>
              <button
                type="button"
                className={`kid-pick ${startMode === "nextWeek" ? "active" : ""}`}
                onClick={() => setStartMode("nextWeek")}
              >
                Next week
              </button>
              <button
                type="button"
                className={`kid-pick ${startMode === "other" ? "active" : ""}`}
                onClick={() => setStartMode("other")}
              >
                Other
              </button>
            </div>
            {startMode === "other" && (
              <input
                type="date"
                value={otherStartDate}
                min={todayISO()}
                onChange={(e) => setOtherStartDate(e.target.value)}
              />
            )}
            {startMode !== "other" && <p className="muted">{otherStartDate}</p>}
          </div>
        )}
        {recurrenceType === "oneoff" && (
          <div className="form-field">
            <span className="gate-field-label">Date</span>
            <input
              type="date"
              value={otherStartDate}
              min={todayISO()}
              onChange={(e) => setOtherStartDate(e.target.value)}
            />
          </div>
        )}
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={destStreet} onChange={(e) => setDestStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={destZip} onChange={(e) => setDestZip(e.target.value)} inputMode="numeric" />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Usual drop-off time</span>
          <input
            type="time"
            value={dropOffTime}
            onChange={(e) => setDropOffTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Usual pick-up time</span>
          <input
            type="time"
            value={pickUpTime}
            onChange={(e) => setPickUpTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
          <span className="muted">We know things change — you'll be able to update each event once you create the carpool.</span>
        </div>
        <div className="form-field">
          <span className="gate-field-label">Timezone</span>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {timezoneOptions.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
        </div>
        <KidPicker
          allKids={profile.kids}
          selected={selectedKids}
          onChange={setSelectedKids}
          label="Which of your kids are in this carpool?"
        />
        {error && <p className="form-error">{error}</p>}
      </BottomSheet>

      <footer className="carpools-footer">
        <a href="mailto:blisspool-feedback@holtawaydesign.com">Feedback or Questions? Email us!</a>
        <BuyMeACoffeeLink className="coffee-link-footer" />
      </footer>

      <UpdatesPage />
    </div>
  );
}
