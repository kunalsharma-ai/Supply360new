'use client';
import { useQuery } from '@tanstack/react-query';
import { Bell, Bot, Check, ChevronRight, LogOut, Menu, Palette, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DropdownMenu, Popover } from 'radix-ui';
import { ROLE_LABELS } from '@s360/contracts';
import { api } from '@/lib/api';
import { moduleForPath } from '@/lib/modules';
import { THEMES } from '@/lib/themes';
import { cn } from '@/lib/cn';
import { useTheme } from '../providers';
import { useSession } from '../session';
import { Button } from '../ui/button';

interface NotificationList {
  items: { id: string; title: string; body: string; severity: string; createdAt: string; readAt: string | null }[];
  unread: number;
}

export function Topbar({
  onOpenPalette,
  onOpenCopilot,
  onOpenMobileNav,
  onSignOut,
}: {
  onOpenPalette: () => void;
  onOpenCopilot: () => void;
  onOpenMobileNav: () => void;
  onSignOut: () => void;
}) {
  const path = usePathname();
  const me = useSession();
  const mod = moduleForPath(path);
  const { theme, setTheme } = useTheme();
  const notes = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationList>('/notifications'),
    refetchInterval: 60_000,
  });
  const menu = 'z-50 min-w-56 rounded-lg border border-border bg-surface p-1 shadow-xl';
  const mi =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text';
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu />
      </Button>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        <Link href="/" className="text-muted hover:text-text">
          {me.tenant.name}
        </Link>
        {mod && mod.href !== '/' && (
          <>
            <ChevronRight className="size-3.5 text-muted" aria-hidden />
            <span className="truncate font-medium" aria-current="page">
              {mod.name}
            </span>
          </>
        )}
      </nav>
      <button
        onClick={onOpenPalette}
        className="ml-auto hidden h-9 w-72 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-muted hover:text-text lg:flex"
      >
        <Search className="size-4" /> Search or run a command
        <kbd className="ml-auto rounded border border-border px-1.5 font-mono text-[10px]">⌘K</kbd>
      </button>
      <Button variant="ghost" size="icon" className="lg:hidden ml-auto" onClick={onOpenPalette} aria-label="Search">
        <Search />
      </Button>

      <Popover.Root>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Notifications${notes.data?.unread ? `, ${notes.data.unread} unread` : ''}`}
            className="relative"
          >
            <Bell />
            {!!notes.data?.unread && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent" />}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            className="z-50 w-80 rounded-lg border border-border bg-surface shadow-xl"
          >
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">Notifications</div>
            <ul className="max-h-96 overflow-y-auto">
              {notes.data?.items.length ? (
                notes.data.items.map((n) => (
                  <li key={n.id} className="border-b border-border px-4 py-3 last:border-0">
                    <p className={cn('text-sm', !n.readAt && 'font-medium')}>{n.title}</p>
                    <p className="mt-0.5 text-xs text-muted">{n.body}</p>
                  </li>
                ))
              ) : (
                <li className="px-4 py-6 text-center text-sm text-muted">No notifications.</li>
              )}
            </ul>
            <Link
              href="/notifications"
              className="block border-t border-border px-4 py-2.5 text-center text-xs text-accent hover:underline"
            >
              Open Notifications Centre
            </Link>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Button variant="ghost" size="icon" onClick={onOpenCopilot} aria-label="Open Copilot">
        <Bot />
      </Button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="Theme">
            <Palette />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} className={menu}>
            {THEMES.map((t) => (
              <DropdownMenu.Item key={t.id} className={mi} onSelect={() => setTheme(t.id)}>
                <span className="flex size-4 overflow-hidden rounded-full ring-1 ring-border" aria-hidden>
                  <span className="w-1/2" style={{ background: t.swatch[0] }} />
                  <span className="w-1/2" style={{ background: t.swatch[1] }} />
                </span>
                <span className="flex-1">{t.name}</span>
                {theme === t.id && <Check className="size-4 text-accent" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-2"
            aria-label="Account menu"
          >
            <span className="grid size-8 place-items-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
              {me.user.name
                .split(' ')
                .map((p) => p[0])
                .slice(0, 2)
                .join('')}
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} className={menu}>
            <div className="px-2.5 py-2">
              <p className="text-sm font-medium">{me.user.name}</p>
              <p className="text-xs text-muted">{me.user.email}</p>
              <p className="mt-1 text-xs text-muted">{me.roles.map((r) => ROLE_LABELS[r]).join(', ')}</p>
            </div>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item className={mi} onSelect={onSignOut}>
              <LogOut className="size-4" /> Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}
