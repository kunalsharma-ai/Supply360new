'use client';
import { Command } from 'cmdk';
import { LogOut, Palette, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Dialog as D } from 'radix-ui';
import { MODULES } from '@/lib/modules';
import { THEMES } from '@/lib/themes';
import { useTheme } from '../providers';
import { useSession } from '../session';
import { ModuleIcon } from './icons';

export function CommandPalette({
  open,
  onOpenChange,
  onSignOut,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSignOut: () => void;
}) {
  const router = useRouter();
  const { permissions } = useSession();
  const { setTheme } = useTheme();
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const item =
    'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted data-[selected=true]:bg-surface-3 data-[selected=true]:text-text';
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <D.Content className="fixed top-[14vh] left-1/2 z-50 w-[min(92vw,640px)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">Search modules and run commands</D.Description>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-4 text-muted" />
              <Command.Input
                autoFocus
                placeholder="Search modules, settings and commands…"
                className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
              />
              <kbd className="rounded border border-border px-1.5 font-mono text-[10px] text-muted">Esc</kbd>
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="p-6 text-center text-sm text-muted">Nothing matches.</Command.Empty>
              <Command.Group
                heading="Modules"
                className="text-[10px] tracking-wider text-muted uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {MODULES.filter((m) => permissions.includes(m.permission)).map((m) => (
                  <Command.Item
                    key={m.key}
                    value={`${m.name} ${m.summary}`}
                    onSelect={() => go(m.href)}
                    className={item}
                  >
                    <ModuleIcon k={m.key} className="size-4" />
                    <span className="flex-1 normal-case">{m.name}</span>
                    <span className="text-[10px] normal-case">{m.ready ? 'Available' : `Phase ${m.phase}`}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group
                heading="Theme"
                className="text-[10px] tracking-wider text-muted uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {THEMES.map((t) => (
                  <Command.Item
                    key={t.id}
                    value={`theme ${t.name}`}
                    onSelect={() => {
                      setTheme(t.id);
                      onOpenChange(false);
                    }}
                    className={item}
                  >
                    <Palette className="size-4" />
                    <span className="normal-case">Switch to {t.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group
                heading="Account"
                className="text-[10px] tracking-wider text-muted uppercase [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                <Command.Item value="sign out log out" onSelect={onSignOut} className={item}>
                  <LogOut className="size-4" />
                  <span className="normal-case">Sign out</span>
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
