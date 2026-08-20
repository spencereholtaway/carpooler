import { useState } from "react";

const DISMISSED_KEY = "blisspool:capacity-banner-dismissed";

export function CapacityChangeBanner() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "true");
    setDismissed(true);
  };

  const message =
    "We updated how car capacity works - please check your numbers by clicking your name in the top-right of the screen.";

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
