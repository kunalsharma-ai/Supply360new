import { Suspense } from 'react';
import { AutomationView } from '@/components/execution/automation-view';

export default function Page() {
  return (
    <Suspense>
      <AutomationView />
    </Suspense>
  );
}
