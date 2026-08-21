import { useEffect, useRef, useState } from "react";
import { createCarpool, getRecommendations, joinCarpool, listCarpools, type RecommendationCard } from "./api";
import { BottomSheet } from "./BottomSheet";
import { BuyMeACoffeeLink } from "./BuyMeACoffeeLink";
import { formatTime, summarizeCarpool } from "./carpoolSummary";
import { KidPicker } from "./KidPicker";
import { RecommendationsSheet } from "./RecommendationsSheet";
import { COMMON_TIMEZONES, DAYS_OF_WEEK, detectTimezone, type Carpool, type DayOfWeek } from "./types";
import { UpdatesPage } from "./UpdatesPage";
import type { LocalProfile } from "./useProfile";
import { useTypewriter } from "./useTypewriter";

type DayGroup = { day: DayOfWeek | null; carpools: Carpool[] };

function TodayCarpoolRow({
  carpool,
  summary,
  onOpen,
  start,
  onDone,
  showCursor,
}: {
  carpool: Carpool;
  summary: string;
  onOpen: () => void;
  start: boolean;
  onDone: () => void;
  showCursor: boolean;
}) {
  const time = rowTimeRange(carpool);
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
        <span className="today-carpool-name">
          {name}
          {cursor(0)}
        </span>
        <span className="today-carpool-time">
          {timeLine}
          {cursor(1)}
        </span>
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

function rowTimeRange(carpool: Carpool): string {
  const { time: drop } = carpool.dropOff;
  const { time: pick } = carpool.pickUp;
  if (drop && pick) return `${formatTime(drop)} - ${formatTime(pick)}`;
  if (drop) return formatTime(drop);
  if (pick) return formatTime(pick);
  return "";
}

// Buckets by day and orders those buckets chronologically starting Monday —
// carpools with no (or an unrecognized) day fall into their own bucket last.
// A carpool covering more than one kid appears once, under its own day, with
// all of the relevant kids' names on the row — not once per kid.
function groupByDay(carpools: Carpool[]): DayGroup[] {
  const buckets = new Map<DayOfWeek | null, Carpool[]>();
  for (const c of carpools) {
    const day = (DAYS_OF_WEEK as readonly string[]).includes(c.day) ? (c.day as DayOfWeek) : null;
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day)!.push(c);
  }
  const order: (DayOfWeek | null)[] = [...DAYS_OF_WEEK, null];
  return order
    .filter((day) => buckets.has(day))
    .map((day) => ({
      day,
      carpools: [...buckets.get(day)!].sort((a, b) =>
        (a.dropOff.time || "24:00").localeCompare(b.dropOff.time || "24:00")
      ),
    }));
}

export function CarpoolsPage({
  memberId,
  profile,
  onOpenCarpool,
  carpools,
  setCarpools,
}: {
  memberId: string;
  profile: LocalProfile;
  onOpenCarpool: (carpool: Carpool) => void;
  carpools: Carpool[] | null;
  setCarpools: (carpools: Carpool[]) => void;
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
  const [day, setDay] = useState<DayOfWeek>("Monday");
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
  const [showUpdates, setShowUpdates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinInputRef = useRef<HTMLInputElement>(null);

  const [recCards, setRecCards] = useState<RecommendationCard[]>([]);
  const [showRecs, setShowRecs] = useState(false);

  useEffect(() => {
    if (openDialog === "join" && !cameViaInviteLink) joinInputRef.current?.focus();
  }, [openDialog, cameViaInviteLink]);

  useEffect(() => {
    if (carpools !== null) return;
    listCarpools(memberId).then(setCarpools);
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
    if (openedDeepLink.current || !carpools) return;
    const code = new URLSearchParams(window.location.search).get("carpool");
    if (!code) return;
    openedDeepLink.current = true;
    const target = carpools.find((c) => c.code === code);
    if (target) onOpenCarpool(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carpools]);

  const openJoin = () => {
    setError(null);
    setJoinCode("");
    setSelectedKids([]);
    setOpenDialog("join");
  };

  const openCreate = () => {
    setError(null);
    setNewName("");
    setDay("Monday");
    setDestStreet("");
    setDestZip("");
    setDropOffTime("");
    setPickUpTime("");
    setSelectedKids([]);
    setOpenDialog("create");
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || selectedKids.length === 0) return;
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
      onOpenCarpool(await createCarpool(trimmed, day, destination, dropOff, pickUp, member, timezone));
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
      onOpenCarpool(await joinCarpool(code, member));
      setOpenDialog(null);
    } catch {
      setError("No carpool found with that code.");
    } finally {
      setJoining(false);
    }
  };

  const dayGroups = groupByDay(carpools ?? []);
  const today = DAYS_OF_WEEK[(new Date().getDay() + 6) % 7];
  const todayCarpools = (carpools ?? [])
    .filter((c) => c.day === today)
    .sort((a, b) => (a.dropOff.time || "24:00").localeCompare(b.dropOff.time || "24:00"));

  return (
    <div className="carpools-page">
      {loading && <p className="muted">Loading...</p>}

      {carpools?.length === 0 && (
        <div className="carpools-empty">
          <h2>No carpools yet</h2>
          <p>Ask someone you know is blisspooling for a join code, or start your own.</p>
        </div>
      )}

      {!loading && todayCarpools.length > 0 && (
        <section className="today-summary">
          <span className="carpool-row-meta carpool-day-label">Today</span>
          {todayCarpools.map((c, i) => (
            <TodayCarpoolRow
              key={c.code}
              carpool={c}
              summary={summarizeCarpool(c, memberId) || "Nothing arranged yet."}
              onOpen={() => onOpenCarpool(c)}
              start={i <= typedCount}
              onDone={() => setTypedCount((n) => Math.max(n, i + 1))}
              showCursor={i === todayCarpools.length - 1}
            />
          ))}
        </section>
      )}

      {carpools && carpools.length > 0 && (
        <section className="carpools-list">
          {dayGroups.map(({ day, carpools: dayCarpools }) => (
            <div className="carpool-day-group" key={day ?? "no-day"}>
              <span className="carpool-row-meta carpool-day-label">
                {day ? `${day}s` : "No day set"}
              </span>
              {dayCarpools.map((c) => (
                <button key={c.code} className="carpool-row" onClick={() => onOpenCarpool(c)}>
                  <div className="carpool-row-top">
                    <span className="carpool-row-name">{c.name}</span>
                    <span className="carpool-row-time">{rowTimeRange(c)}</span>
                  </div>
                  <div className="carpool-row-summary">
                    {(summarizeCarpool(c, memberId) || "Nothing arranged yet.")
                      .split("\n")
                      .map((line, i) => (
                        <p key={i}>{line}</p>
                      ))}
                  </div>
                </button>
              ))}
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
        onJoined={(carpool) => setCarpools([...(carpools ?? []), carpool])}
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
            disabled={creating || !newName.trim() || selectedKids.length === 0}
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
          <span className="gate-field-label">Day</span>
          <select value={day} onChange={(e) => setDay(e.target.value as DayOfWeek)}>
            {DAYS_OF_WEEK.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <span className="gate-field-label">Street address</span>
          <input value={destStreet} onChange={(e) => setDestStreet(e.target.value)} />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Zip code</span>
          <input value={destZip} onChange={(e) => setDestZip(e.target.value)} inputMode="numeric" />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Drop-off time</span>
          <input
            type="time"
            value={dropOffTime}
            onChange={(e) => setDropOffTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
        </div>
        <div className="form-field">
          <span className="gate-field-label">Pick-up time</span>
          <input
            type="time"
            value={pickUpTime}
            onChange={(e) => setPickUpTime(e.target.value)}
            onInvalid={(e) => e.preventDefault()}
          />
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
        <button type="button" className="text-link-footer" onClick={() => setShowUpdates(true)}>
          What's new?
        </button>
        <a href="mailto:blisspool-feedback@holtawaydesign.com">Feedback or Questions? Email us!</a>
        <BuyMeACoffeeLink className="coffee-link-footer" />
      </footer>

      <UpdatesPage open={showUpdates} onClose={() => setShowUpdates(false)} />
    </div>
  );
}
