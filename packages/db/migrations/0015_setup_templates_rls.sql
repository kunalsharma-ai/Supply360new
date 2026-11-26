-- Tenant isolation for saved project setups. People can remove templates they no longer need.
GRANT SELECT, INSERT, UPDATE, DELETE ON setup_templates TO s360_app;--> statement-breakpoint
ALTER TABLE setup_templates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE setup_templates FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON setup_templates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
