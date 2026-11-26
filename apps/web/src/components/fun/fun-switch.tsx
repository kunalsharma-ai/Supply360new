'use client';
import { Switch } from 'radix-ui';
import { cn } from '@/lib/cn';

/** A chunky, bouncy toggle. The label is required so the control is always named. */
export function FunSwitch({
  checked,
  onCheckedChange,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium', className)}>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative h-7 w-12 shrink-0 rounded-full bg-surface-3 shadow-[inset_0_2px_4px_rgb(0_0_0/0.12)] ring-1 ring-border transition-colors data-[state=checked]:bg-[linear-gradient(120deg,#22c55e,#14b8a6)]"
      >
        <Switch.Thumb className="block size-6 translate-x-0.5 rounded-full bg-white shadow-[0_2px_0_rgb(0_0_0/0.12),0_4px_10px_-2px_rgb(0_0_0/0.25)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
      {label}
    </label>
  );
}
