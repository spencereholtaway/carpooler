import { useCallback, useEffect, useRef } from "react";

type StackEntry = { id: number; close: () => void };

// One global stack shared by every screen/modal/sheet in the app, so a
// single browser back press (or iOS/Android edge-swipe, which fires the same
// popstate event) always closes exactly the most-recently-opened thing.
const stack: StackEntry[] = [];
let seq = 0;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const top = stack.pop();
    if (top) top.close();
  });
}

// Ties a piece of open/closed UI state (a screen, modal, or bottom sheet) to
// a browser history entry. Returns a `requestClose` to use for every close
// trigger (X button, backdrop, Save, Cancel, onBack, ...) so they all route
// through the same history.back() call the popstate listener expects —
// closing any other way would leave an orphaned entry that eats an extra
// back press before the app visibly reacts again.
export function useBackable(isOpen: boolean, onClose: () => void): () => void {
  const idRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (isOpen && idRef.current === null) {
      const id = ++seq;
      idRef.current = id;
      stack.push({ id, close: () => onCloseRef.current() });
      window.history.pushState({ backableId: id }, "");
    } else if (!isOpen && idRef.current !== null) {
      const idx = stack.findIndex((e) => e.id === idRef.current);
      if (idx !== -1) stack.splice(idx, 1);
      idRef.current = null;
    }
  }, [isOpen]);

  return useCallback(() => {
    if (idRef.current !== null) {
      window.history.back();
    } else {
      onCloseRef.current();
    }
  }, []);
}
