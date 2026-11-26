import { Suspense } from 'react';
import { LiveView } from '@/components/fieldwork/fieldwork-views';

export default function Page() {
  return (
    <Suspense>
      <LiveView />
    </Suspense>
  );
}
