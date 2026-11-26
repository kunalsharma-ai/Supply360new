-- Phase 5 tenant isolation, same pattern as 0001_rls.sql. Participation events are append-only for the app.
GRANT SELECT, INSERT ON participation_events TO s360_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON quality_flags, reconciliation_runs, reward_events TO s360_app;--> statement-breakpoint
ALTER TABLE participation_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE participation_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON participation_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE quality_flags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE quality_flags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON quality_flags USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reconciliation_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reconciliation_runs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE reward_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reward_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reward_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
