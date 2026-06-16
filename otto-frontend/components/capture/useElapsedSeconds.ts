"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tracks elapsed wall-clock seconds for a recording session.
 *
 * Unlike a naive `setInterval(() => setElapsed((e) => e + 1), 1000)`, this
 * derives the value from `Date.now()` on every tick, so it stays accurate even
 * when the browser throttles or pauses timers in a backgrounded tab. The
 * interval only triggers re-renders; it never accumulates the count itself.
 *
 * Pause/resume is accounted for: time spent paused is excluded from the total.
 */
export function useElapsedSeconds(paused: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  // Milliseconds accumulated across prior (already-ended) run segments.
  const accumulatedMsRef = useRef(0);
  // Timestamp the current run segment started, or null while paused.
  const runStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (paused) {
      // Fold the in-progress segment into the accumulated total and stop.
      if (runStartRef.current != null) {
        accumulatedMsRef.current += Date.now() - runStartRef.current;
        runStartRef.current = null;
      }
      return;
    }

    runStartRef.current = Date.now();
    const tick = () => {
      const runMs =
        runStartRef.current != null ? Date.now() - runStartRef.current : 0;
      setElapsed(Math.floor((accumulatedMsRef.current + runMs) / 1000));
    };
    tick();
    const interval = setInterval(tick, 1000);
    // Snap to the correct value the instant the tab regains focus, instead of
    // waiting up to a second for the (previously throttled) interval to fire.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [paused]);

  return elapsed;
}
