import { Suspense } from 'react';
import { AllocationView } from '@/components/audience/allocation-view';

export default function Page() {
  return (
    <Suspense>
      <AllocationView />
    </Suspense>
  );
}
