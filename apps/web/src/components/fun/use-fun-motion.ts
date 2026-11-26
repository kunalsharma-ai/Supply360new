'use client';
import { useEffect, useState } from 'react';
import { useTheme } from '../providers';

/** True when playful motion should run: the in-app toggle is on and the OS does not ask for reduced motion. */
export function useFunMotion() {
  const { motion } = useTheme();
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return motion && !reduced;
}
