'use client';
import { Bot, X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';

/** The Copilot is built in Phase 7. Until then the drawer says so plainly instead of pretending to answer. */
export function CopilotDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <D.Content className="fixed top-0 right-0 z-50 flex h-full w-[min(100vw,420px)] flex-col border-l border-border bg-surface shadow-2xl">
          <div className="flex h-14 items-center gap-2 border-b border-border px-4">
            <Bot className="size-4 text-accent" />
            <D.Title className="text-sm font-semibold">AI Supply Copilot</D.Title>
            <D.Close
              aria-label="Close Copilot"
              className="ml-auto rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-accent/15 text-accent">
              <Bot className="size-6" />
            </div>
            <D.Description className="text-sm text-muted">
              The Copilot arrives in Phase 7. It will turn questions into typed, permission-checked queries, show
              previews, and ask for approval before anything consequential. It will never run SQL or commands.
            </D.Description>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
