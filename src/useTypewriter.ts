import { useEffect, useState } from "react";

// Purely cosmetic: re-"types" text out a character at a time whenever it
// changes, instead of just popping in fully formed. Pace varies per
// character — with a lingering beat after spaces and punctuation — so it
// reads like someone typing rather than a metronome.
export function useTypewriter(text: string, baseSpeed = 30): { display: string; done: boolean } {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    setDisplay("");
    if (!text) return;
    let i = 0;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      const lastChar = text[i - 1];
      const pause = /[.,!?]/.test(lastChar ?? "")
        ? baseSpeed * 5
        : lastChar === " "
          ? baseSpeed * 1.6
          : baseSpeed;
      timeoutId = setTimeout(tick, pause * (0.6 + Math.random() * 0.8));
    };

    const tick = () => {
      if (cancelled) return;
      i += 1;
      setDisplay(text.slice(0, i));
      if (i < text.length) scheduleNext();
    };

    scheduleNext();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return { display, done: display.length === text.length };
}
