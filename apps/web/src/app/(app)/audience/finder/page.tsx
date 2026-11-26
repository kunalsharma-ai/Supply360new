import { Suspense } from 'react';
import { AudienceExplorer } from '@/components/audience/explorer';

export default function Page() {
  return (
    <Suspense>
      <AudienceExplorer variant="finder" />
    </Suspense>
  );
}
