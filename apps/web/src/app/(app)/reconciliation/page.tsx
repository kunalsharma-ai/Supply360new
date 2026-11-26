import { Suspense } from 'react';
import { ReconciliationView } from '@/components/fieldwork/closeout-views';

export default function Page() {
  return (
    <Suspense>
      <ReconciliationView />
    </Suspense>
  );
}
