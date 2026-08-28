import { useState } from "react";

const STORAGE_KEY = "feedback-banner-dismissed-v1";
const FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSecFwx8NLd4_bcJqxCfRvttMdnJhlLiTRdfK-QMmrROMRiuzA/viewform?usp=header";

// Dismissal persists in localStorage so the banner doesn't nag on every visit
// once someone has closed it.
export function useFeedbackBannerVisible() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  };
  return { visible: !dismissed, dismiss };
}

export function FeedbackBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="feedback-banner">
      <span className="feedback-banner-text">
        Got thoughts on blisspool?{" "}
        <a href={FORM_URL} target="_blank" rel="noopener noreferrer">
          Tell us what you think
        </a>
      </span>
      <button
        type="button"
        className="feedback-banner-close"
        onClick={onDismiss}
        aria-label="Dismiss feedback banner"
      >
        ×
      </button>
    </div>
  );
}
