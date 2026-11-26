'use client';
import { useEffect, useState } from 'react';
import { useFunMotion } from './use-fun-motion';

/** Counts up to a number with an ease-out. Shows the final value at once when motion is off. */
export function CountUp({ value, suffix = '', duration = 900 }: { value: number; suffix?: string; duration?: number }) {
  const on = useFunMotion();
  const [n, setN] = useState(on ? 0 : value);
  useEffect(() => {
    if (!on) {
      setN(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setN(Math.round(value * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, on, duration]);
  return (
    <span className="tabular-nums">
      {n}
      {suffix}
    </span>
  );
}
