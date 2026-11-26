import { Suspense } from 'react';
import { QualityView } from '@/components/fieldwork/closeout-views';

export default function Page() {
  return (
    <Suspense>
      <QualityView />
    </Suspense>
  );
}
