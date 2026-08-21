import { useEffect, useState } from "react";
import { joinCarpool, type RecommendationCard } from "./api";
import { BottomSheet } from "./BottomSheet";
import type { Carpool } from "./types";
import type { LocalProfile } from "./useProfile";

// Mirrors the app's standard tablet/desktop breakpoint (see index.css).
// Only used for one behavioral difference: single-kid adds skip the
// confirm step on desktop (a plain click), but keep it on mobile where
// the same tap gesture is also used to swipe/scroll the carousel and a
// mis-tap is easier to make.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

function joinLine(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `With ${names[0]}`;
  const shown = names.slice(0, 2);
  const rest = names.length - shown.length;
  const base = `With ${shown.join(", ")}`;
  return rest > 0 ? `${base} & ${rest} other${rest === 1 ? "" : "s"}` : base.replace(/, (?=[^,]*$)/, " & ");
}

type CardStatus = { kind: "idle" } | { kind: "confirming"; toggled: Set<string> } | { kind: "joining" } | {
  kind: "done";
  addedKids: string[];
};

function RecommendationCardView({
  card,
  status,
  onStart,
  onToggle,
  onConfirm,
  onCancel,
}: {
  card: RecommendationCard;
  status: CardStatus;
  onStart: () => void;
  onToggle: (kid: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (status.kind === "done") {
    return (
      <div className="rec-card rec-card-done">
        <span className="rec-card-check">✓</span>
        <span>Added {status.addedKids.join(" & ")}</span>
      </div>
    );
  }

  if (status.kind === "confirming") {
    const isDual = card.kidNames.length > 1;
    return (
      <div className="rec-card">
        <p className="rec-card-confirm-text">
          {isDual ? `Add both kids to ${card.carpoolName}?` : `Add ${card.kidNames[0]} to ${card.carpoolName}?`}
        </p>
        {isDual && (
          <div className="kid-tags">
            {card.kidNames.map((kid) => (
              <button
                type="button"
                key={kid}
                className={`kid-pick ${status.toggled.has(kid) ? "active" : ""}`}
                onClick={() => onToggle(kid)}
                aria-pressed={status.toggled.has(kid)}
              >
                {kid}
              </button>
            ))}
          </div>
        )}
        <div className="rec-card-confirm-actions">
          <button type="button" className="text-link-footer" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="pill-button small"
            onClick={onConfirm}
            disabled={isDual && status.toggled.size === 0}
          >
            {isDual ? "Add selected" : "Confirm"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rec-card">
      <span className="rec-card-for">For {card.kidNames.join(" & ")}</span>
      <span className="rec-card-name">{card.carpoolName}</span>
      <span className="rec-card-members muted">{joinLine(card.memberFirstNames)}</span>
      <button type="button" className="pill-button small" onClick={onStart} disabled={status.kind === "joining"}>
        {status.kind === "joining" ? "Adding..." : `Add ${card.kidNames.join(" & ")}`}
      </button>
    </div>
  );
}

export function RecommendationsSheet({
  open,
  onClose,
  cards,
  memberId,
  profile,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  cards: RecommendationCard[];
  memberId: string;
  profile: LocalProfile;
  onJoined: (carpool: Carpool) => void;
}) {
  const isDesktop = useIsDesktop();
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});

  const statusFor = (code: string): CardStatus => statuses[code] ?? { kind: "idle" };
  const setStatus = (code: string, status: CardStatus) => setStatuses((prev) => ({ ...prev, [code]: status }));

  const doJoin = async (card: RecommendationCard, kids: string[]) => {
    setStatus(card.carpoolCode, { kind: "joining" });
    try {
      const carpool = await joinCarpool(card.carpoolCode, {
        id: memberId,
        name: profile.name,
        kids,
        canDriveDropOff: false,
        canDrivePickUp: false,
        street: profile.street,
        zip: profile.zip,
      });
      onJoined(carpool);
      setStatus(card.carpoolCode, { kind: "done", addedKids: kids });
    } catch {
      setStatus(card.carpoolCode, { kind: "idle" });
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Recommended carpools">
      <div className="recs-carousel">
        {cards.map((card) => {
          const isDual = card.kidNames.length > 1;
          const requireConfirm = isDual || !isDesktop;
          const status = statusFor(card.carpoolCode);
          return (
            <RecommendationCardView
              key={card.carpoolCode}
              card={card}
              status={status}
              onStart={() => {
                if (!requireConfirm) {
                  doJoin(card, card.kidNames);
                  return;
                }
                setStatus(card.carpoolCode, { kind: "confirming", toggled: new Set(card.kidNames) });
              }}
              onToggle={(kid) => {
                const current = statusFor(card.carpoolCode);
                if (current.kind !== "confirming") return;
                const toggled = new Set(current.toggled);
                if (toggled.has(kid)) toggled.delete(kid);
                else toggled.add(kid);
                setStatus(card.carpoolCode, { kind: "confirming", toggled });
              }}
              onConfirm={() => {
                const current = statusFor(card.carpoolCode);
                const kids = current.kind === "confirming" ? [...current.toggled] : card.kidNames;
                doJoin(card, kids);
              }}
              onCancel={() => setStatus(card.carpoolCode, { kind: "idle" })}
            />
          );
        })}
      </div>
    </BottomSheet>
  );
}
