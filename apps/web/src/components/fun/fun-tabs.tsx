'use client';
import type { LucideIcon } from 'lucide-react';
import { LayoutGroup, motion } from 'motion/react';
import { Tabs } from 'radix-ui';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useFunMotion } from './use-fun-motion';

export interface FunTab {
  value: string;
  label: string;
  icon: LucideIcon;
  /** Tailwind gradient classes for the active pill, e.g. "from-violet-500 to-fuchsia-500". */
  tint: string;
  count?: number;
  content: ReactNode;
}

/** Colourful pill tabs with a springy sliding highlight. Keyboard support comes from Radix Tabs. */
export function FunTabs({ tabs, label }: { tabs: FunTab[]; label: string }) {
  const [value, setValue] = useState(tabs[0]!.value);
  const on = useFunMotion();
  const group = useId();
  return (
    <Tabs.Root value={value} onValueChange={setValue}>
      <LayoutGroup id={group}>
        <Tabs.List aria-label={label} className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
          {tabs.map((t) => {
            const active = t.value === value;
            return (
              <Tabs.Trigger
                key={t.value}
                value={t.value}
                className={cn(
                  'fun-wiggle relative isolate inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors',
                  active ? 'text-white' : 'text-muted hover:bg-surface-2 hover:text-text',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="pill"
                    transition={on ? { type: 'spring', stiffness: 420, damping: 30 } : { duration: 0 }}
                    className={cn(
                      'absolute inset-0 -z-10 rounded-full bg-gradient-to-r shadow-[0_3px_0_rgb(0_0_0/0.18),0_10px_20px_-10px_rgb(0_0_0/0.45)]',
                      t.tint,
                    )}
                  />
                )}
                <t.icon className="size-4" aria-hidden />
                {t.label}
                {t.count !== undefined && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[11px] tabular-nums',
                      active ? 'bg-white/25 text-white' : 'bg-surface-3 text-muted',
                    )}
                  >
                    {t.count}
                  </span>
                )}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
      </LayoutGroup>
      {tabs.map((t) => (
        <Tabs.Content key={t.value} value={t.value} className="fun-pop focus-visible:outline-none">
          {t.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
