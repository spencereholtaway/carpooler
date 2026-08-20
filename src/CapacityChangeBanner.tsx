import { useState } from "react";

const DISMISSED_KEY = "blisspool:capacity-banner-dismissed-v2";

export function CapacityChangeBanner() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "true");
    setDismissed(true);
  };

  const message =
    "Car capacity is now set per leg when you sign up to drive - check the seat count next to your name in each carpool.";

  return (
    <>
      <div className="capacity-banner capacity-banner-mobile-only pop-in">
        <p>{message}</p>
        <button type="button" onClick={dismiss} aria-label="Dismiss">
          &times;
        </button>
      </div>
      <div className="capacity-banner-bar capacity-banner-desktop-only">
        <p>{message}</p>
        <button type="button" onClick={dismiss} aria-label="Dismiss">
          &times;
        </button>
      </div>
    </>
  );
}
