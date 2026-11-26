-- Module 26: tenant isolation for the SampIntel connection.
GRANT SELECT, INSERT, UPDATE ON sampintel_connections TO s360_app;--> statement-breakpoint
ALTER TABLE sampintel_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sampintel_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sampintel_connections USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
