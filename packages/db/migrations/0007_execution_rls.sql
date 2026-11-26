-- Phase 4 tenant isolation, same pattern as 0001_rls.sql.
GRANT SELECT, INSERT, UPDATE ON execution_policies, execution_controls, invitation_batches, invitations, reminder_jobs TO s360_app;--> statement-breakpoint
-- Delivery attempts and router events are append-only for the app.
GRANT SELECT, INSERT ON delivery_attempts, router_events TO s360_app;--> statement-breakpoint
ALTER TABLE execution_policies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE execution_policies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON execution_policies USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE execution_controls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE execution_controls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON execution_controls USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE invitation_batches ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitation_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitation_batches USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE reminder_jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reminder_jobs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reminder_jobs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE delivery_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE delivery_attempts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON delivery_attempts USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
ALTER TABLE router_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE router_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON router_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
