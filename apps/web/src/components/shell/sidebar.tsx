'use client';
import { ChevronsLeft, ChevronsRight, CircleDot } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GROUPS, MODULES, moduleForPath } from '@/lib/modules';
import { cn } from '@/lib/cn';
import { useSession } from '../session';
import { ModuleIcon } from './icons';
import { Logo } from './logo';

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const path = usePathname();
  const { permissions } = useSession();
  const active = moduleForPath(path);
  const visible = MODULES.filter((m) => permissions.includes(m.permission));
  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 md:flex',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <Logo compact={collapsed} />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {GROUPS.map((g) => {
          const items = visible.filter((m) => m.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="mb-3">
              {!collapsed && (
                <p className="px-2 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted uppercase">{g}</p>
              )}
              <ul>
                {items.map((m) => {
                  const on = active?.key === m.key;
                  return (
                    <li key={m.key}>
                      <Link
                        href={m.href}
                        title={collapsed ? m.name : undefined}
                        aria-current={on ? 'page' : undefined}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-text',
                          on && 'bg-accent/12 text-text ring-1 ring-accent/25',
                        )}
                      >
                        <ModuleIcon
                          k={m.key}
                          className={cn('size-4 shrink-0', on ? 'text-accent' : 'text-muted group-hover:text-text')}
                        />
                        {!collapsed && <span className="flex-1 truncate">{m.name}</span>}
                        {!collapsed && !m.ready && (
                          <span className="text-[10px] text-muted" title={`Arrives in Phase ${m.phase}`}>
                            P{m.phase}
                          </span>
                        )}
                        {!collapsed && m.ready && <CircleDot className="size-3 text-success" aria-label="Available" />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <button
        onClick={onToggle}
        className="flex h-11 items-center gap-2 border-t border-border px-4 text-xs text-muted hover:text-text"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        {!collapsed && 'Collapse'}
        {!collapsed && <kbd className="ml-auto rounded border border-border px-1 font-mono text-[10px]">[</kbd>}
      </button>
    </aside>
  );
}
