import { Suspense } from 'react';
import { RouterView } from '@/components/execution/lists-view';

export default function Page() {
  return (
    <Suspense>
      <RouterView />
    </Suspense>
  );
}
