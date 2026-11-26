-- Tenant isolation for the Copilot's AI setting.
ALTER TABLE copilot_ai ADD CONSTRAINT copilot_ai_kind_known CHECK (kind IN ('anthropic', 'openai', 'gemini', 'openai_compatible'));--> statement-breakpoint
ALTER TABLE copilot_ai ADD CONSTRAINT copilot_ai_base_url_https CHECK (base_url IS NULL OR base_url LIKE 'https://%');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON copilot_ai TO s360_app;--> statement-breakpoint
ALTER TABLE copilot_ai ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE copilot_ai FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON copilot_ai USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
