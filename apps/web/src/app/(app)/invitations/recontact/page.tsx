import { Suspense } from 'react';
import { RecontactView } from '@/components/fieldwork/recontact-view';

export default function Page() {
  return (
    <Suspense>
      <RecontactView />
    </Suspense>
  );
}
