import { Suspense } from 'react';
import { RemindersView } from '@/components/execution/lists-view';

export default function Page() {
  return (
    <Suspense>
      <RemindersView />
    </Suspense>
  );
}
