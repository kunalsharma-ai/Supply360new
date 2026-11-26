import { Suspense } from 'react';
import { DeliveryView } from '@/components/intelligence/delivery-view';

export default function Page() {
  return (
    <Suspense>
      <DeliveryView />
    </Suspense>
  );
}
