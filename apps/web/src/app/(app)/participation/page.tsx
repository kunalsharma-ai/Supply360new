import { Suspense } from 'react';
import { ParticipationView } from '@/components/fieldwork/fieldwork-views';

export default function Page() {
  return (
    <Suspense>
      <ParticipationView />
    </Suspense>
  );
}
