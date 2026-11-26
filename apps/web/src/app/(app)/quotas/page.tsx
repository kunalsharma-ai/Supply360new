import { Suspense } from 'react';
import { QuotasView } from '@/components/audience/quotas-view';

export default function Page() {
  return (
    <Suspense>
      <QuotasView />
    </Suspense>
  );
}
