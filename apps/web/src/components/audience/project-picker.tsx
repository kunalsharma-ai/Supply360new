'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { Label, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { lifecycleLabel, type ProjectSummary } from '@/lib/ingestion';

/** Picks the project in `?project=`; defaults to the first one that is not closed. */
export function useProjectParam() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const list = useQuery({
    queryKey: ['projects', '', ''],
    queryFn: () => api<{ items: ProjectSummary[] }>('/projects'),
  });
  const id = params.get('project');
  const items = list.data?.items ?? [];
  useEffect(() => {
    if (!id && items.length) {
      const first = items.find((p) => p.lifecycle !== 'closed') ?? items[0]!;
      router.replace(`${path}?project=${first.id}`);
    }
  }, [id, items, path, router]);
  return { id, items, list, select: (pid: string) => router.replace(`${path}?project=${pid}`) };
}

export function ProjectPicker({
  id,
  items,
  onSelect,
}: {
  id: string | null;
  items: ProjectSummary[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="w-full max-w-md">
      <Label htmlFor="project-pick">Project</Label>
      <Select id="project-pick" value={id ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.projectCode} · {p.name} ({lifecycleLabel(p.lifecycle)})
          </option>
        ))}
      </Select>
    </div>
  );
}
