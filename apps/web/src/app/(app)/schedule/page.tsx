import { Suspense } from 'react';
import { ScheduleView } from '@/components/execution/lists-view';

export default function Page() {
  return (
    <Suspense>
      <ScheduleView />
    </Suspense>
  );
}
