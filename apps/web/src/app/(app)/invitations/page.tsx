import { Suspense } from 'react';
import { InvitationsView } from '@/components/execution/invitations-view';

export default function Page() {
  return (
    <Suspense>
      <InvitationsView />
    </Suspense>
  );
}
