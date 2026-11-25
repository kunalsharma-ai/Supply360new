import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-contrast hover:bg-accent-strong shadow-glow',
        secondary: 'bg-surface-2 text-text border border-border hover:bg-surface-3',
        ghost: 'text-muted hover:text-text hover:bg-surface-2',
        danger: 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25',
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-4', lg: 'h-11 px-5 text-base', icon: 'size-9' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const C = asChild ? Slot.Root : 'button';
  return <C className={cn(button({ variant, size }), className)} {...props} />;
}
