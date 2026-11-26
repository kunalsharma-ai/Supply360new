-- Phase 3 tenant isolation, same pattern as 0001_rls.sql.
GRANT SELECT, INSERT, UPDATE ON audience_connections, quota_cells, allocation_plans, reservations TO s360_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON audience_segments TO s360_app;--> statement-breakpoint
-- Selections are immutable snapshots.
GRANT SELECT, INSERT ON audience_selections TO s360_app;--> statement-breakpoint
-- Released and expired holds are deleted, so the unique (project, ref) index only covers live holds.
GRANT SELECT, INSERT, DELETE ON reserved_refs TO s360_app;--> statement-breakpoint
ALTER TABLE audience_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audience_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audience_connections USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE quota_cells ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE quota_cells FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON quota_cells USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE allocation_plans ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE allocation_plans FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON allocation_plans USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE audience_segments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audience_segments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audience_segments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE audience_selections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audience_selections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audience_selections USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reservations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reservations USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE reserved_refs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reserved_refs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reserved_refs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
