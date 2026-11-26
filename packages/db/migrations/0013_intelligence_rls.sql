-- Phase 7: tenant isolation. Forecast snapshots are append-only for the app.
GRANT SELECT, INSERT ON delivery_predictions TO s360_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON copilot_interactions TO s360_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON report_exports TO s360_app;--> statement-breakpoint
ALTER TABLE delivery_predictions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE delivery_predictions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON delivery_predictions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE copilot_interactions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE copilot_interactions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON copilot_interactions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON report_exports USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
