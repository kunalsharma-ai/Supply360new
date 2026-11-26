'use client';
import { Bot, Maximize2, X } from 'lucide-react';
import Link from 'next/link';
import { Dialog as D } from 'radix-ui';
import { CopilotPanel } from '@/components/intelligence/copilot-panel';
import { useCan } from '@/components/session';

/** Module 24 in a drawer, available on every screen to people with copilot.use. */
export function CopilotDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const can = useCan('copilot.use');
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <D.Content className="fixed top-0 right-0 z-50 flex h-full w-[min(100vw,440px)] flex-col border-l border-border bg-surface shadow-2xl">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
            <Bot className="size-4 text-accent" />
            <D.Title className="text-sm font-semibold">AI Supply Copilot</D.Title>
            <Link
              href="/copilot"
              onClick={() => onOpenChange(false)}
              aria-label="Open the Copilot page"
              className="ml-auto rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <Maximize2 className="size-4" />
            </Link>
            <D.Close
              aria-label="Close Copilot"
              className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <D.Description className="sr-only">
            Ask questions; answers come from typed, permission-checked queries.
          </D.Description>
          {can ? (
            <CopilotPanel compact />
          ) : (
            <p className="p-6 text-sm text-muted">Your role does not include the Copilot (copilot.use).</p>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
