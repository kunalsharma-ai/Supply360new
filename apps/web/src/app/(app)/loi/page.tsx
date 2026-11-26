import { Suspense } from 'react';
import { LoiView } from '@/components/fieldwork/fieldwork-views';

export default function Page() {
  return (
    <Suspense>
      <LoiView />
    </Suspense>
  );
}
