'use client';
import { PageHeader } from '@/components/page-header';
import { useCan, useSession } from '@/components/session';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { NoPermission } from '@/components/ui/states';

export default function SuperAdminPage() {
  const can = useCan('tenants.manage');
  const me = useSession();
  if (!can) return <NoPermission permission="tenants.manage" />;
  return (
    <>
      <PageHeader
        title="Super Admin"
        description="Platform administration. There is no silent cross-tenant access: provisioning runs as an audited command-line step with the owner database role."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="This workspace" />
          <CardBody className="space-y-1 text-sm">
            <p>
              <span className="text-muted">Name:</span> {me.tenant.name}
            </p>
            <p>
              <span className="text-muted">Slug:</span> <code className="font-mono">{me.tenant.slug}</code>
            </p>
            <p>
              <span className="text-muted">Id:</span> <code className="font-mono text-xs">{me.tenant.id}</code>
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Provision a tenant" description="Runs outside the web app" />
          <CardBody>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed text-muted">{`S360_ADMIN_PASSWORD=… pnpm --filter @s360/api tenant:create \\
  --slug acme --name "Acme Research" \\
  --admin-email admin@acme.example --admin-name "Admin Name"`}</pre>
            <p className="mt-3 text-xs text-muted">
              Entitlements, usage limits, branding and custom domains arrive with production readiness (Phase 8).
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
