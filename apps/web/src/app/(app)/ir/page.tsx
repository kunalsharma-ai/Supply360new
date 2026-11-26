import { Suspense } from 'react';
import { IrView } from '@/components/fieldwork/fieldwork-views';

export default function Page() {
  return (
    <Suspense>
      <IrView />
    </Suspense>
  );
}
