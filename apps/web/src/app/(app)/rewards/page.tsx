import { Suspense } from 'react';
import { RewardsView } from '@/components/fieldwork/closeout-views';

export default function Page() {
  return (
    <Suspense>
      <RewardsView />
    </Suspense>
  );
}
