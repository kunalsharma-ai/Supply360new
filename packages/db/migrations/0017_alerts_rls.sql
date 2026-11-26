-- Tenant isolation for alerts. Deliveries and marks are append-only for the app.
GRANT SELECT, INSERT, UPDATE ON alert_settings TO s360_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON alert_deliveries TO s360_app;--> statement-breakpoint
GRANT SELECT, INSERT ON alert_marks TO s360_app;--> statement-breakpoint
ALTER TABLE alert_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE alert_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON alert_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE alert_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE alert_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON alert_deliveries USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE alert_marks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE alert_marks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON alert_marks USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
