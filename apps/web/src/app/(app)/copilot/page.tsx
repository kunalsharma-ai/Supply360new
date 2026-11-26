'use client';
import { CopilotPanel } from '@/components/intelligence/copilot-panel';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Card, CardBody } from '@/components/ui/card';
import { NoPermission } from '@/components/ui/states';

export default function CopilotPage() {
  const can = useCan('copilot.use');
  if (!can) return <NoPermission permission="copilot.use" />;
  return (
    <>
      <PageHeader
        title="AI Supply Copilot"
        description="Questions become typed, validated queries checked against your role. It never runs SQL or commands, and anything that would send invitations is proposed for a person to approve. Every answer records its version and reasoning."
      />
      <Card>
        <CardBody className="h-[min(70vh,720px)]">
          <CopilotPanel />
        </CardBody>
      </Card>
    </>
  );
}
