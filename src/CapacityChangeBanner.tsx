import { useState } from "react";

const DISMISSED_KEY = "blisspool:capacity-banner-dismissed";

export function CapacityChangeBanner() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="capacity-banner pop-in">
      <p>
        We updated how car capacity works - please check your numbers by clicking your name in
        the top-right of the screen.
      </p>
      <button type="button" onClick={dismiss} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
