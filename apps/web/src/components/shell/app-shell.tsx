'use client';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Dialog as D } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { MODULES } from '@/lib/modules';
import { useSession } from '../session';
import { CommandPalette } from './command-palette';
import { CopilotDrawer } from './copilot-drawer';
import { ModuleIcon } from './icons';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

const COLLAPSE_KEY = 's360-sidebar-collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [copilot, setCopilot] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const { permissions } = useSession();

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (!typing && e.key === '[') {
        toggle();
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* already signed out */
    }
    qc.clear();
    toast.success('Signed out');
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-contrast"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onOpenPalette={() => setPalette(true)}
          onOpenCopilot={() => setCopilot(true)}
          onOpenMobileNav={() => setMobileNav(true)}
          onSignOut={signOut}
        />
        <main id="main" className="flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} onSignOut={signOut} />
      <CopilotDrawer open={copilot} onOpenChange={setCopilot} />
      <D.Root open={mobileNav} onOpenChange={setMobileNav}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/50 md:hidden" />
          <D.Content className="fixed inset-y-0 left-0 z-50 w-72 overflow-y-auto border-r border-border bg-surface p-3 md:hidden">
            <div className="mb-2 flex items-center justify-between">
              <D.Title className="text-sm font-semibold">Navigation</D.Title>
              <D.Description className="sr-only">All modules</D.Description>
              <D.Close aria-label="Close navigation" className="rounded p-1 text-muted">
                <X className="size-4" />
              </D.Close>
            </div>
            <ul>
              {MODULES.filter((m) => permissions.includes(m.permission)).map((m) => (
                <li key={m.key}>
                  <Link
                    href={m.href}
                    onClick={() => setMobileNav(false)}
                    className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text"
                  >
                    <ModuleIcon k={m.key} className="size-4" /> {m.name}
                  </Link>
                </li>
              ))}
            </ul>
          </D.Content>
        </D.Portal>
      </D.Root>
    </div>
  );
}
