'use client';
import { useRef, type HTMLAttributes, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { useFunMotion } from './use-fun-motion';

/** A card that tilts towards the pointer in 3D. Pure CSS transforms; stays flat when motion is off. */
export function Tilt({ className, max = 8, ...p }: HTMLAttributes<HTMLDivElement> & { max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const on = useFunMotion();
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || !on || e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty('--rx', `${(-y * max).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(x * max).toFixed(2)}deg`);
  };
  const leave = () => {
    ref.current?.style.setProperty('--rx', '0deg');
    ref.current?.style.setProperty('--ry', '0deg');
  };
  return <div ref={ref} onPointerMove={move} onPointerLeave={leave} className={cn('fun-tilt', className)} {...p} />;
}
