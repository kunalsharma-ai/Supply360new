-- Phase 2 tenant isolation, same pattern as 0001_rls.sql.
GRANT SELECT, INSERT, UPDATE ON source_connections, projects, project_markets, inbound_events TO s360_app;--> statement-breakpoint
-- Versions and redirect hits are append-only for the app.
GRANT SELECT, INSERT ON project_versions, redirect_hits TO s360_app;--> statement-breakpoint
ALTER TABLE source_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE source_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON source_connections USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON projects USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE project_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON project_versions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE project_markets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_markets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON project_markets USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON inbound_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE redirect_hits ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE redirect_hits FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON redirect_hits USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
