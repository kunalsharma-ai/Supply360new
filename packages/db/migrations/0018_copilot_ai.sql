CREATE TABLE "copilot_ai" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"auth_style" text DEFAULT 'bearer' NOT NULL,
	"model" text NOT NULL,
	"sealed_key" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"timeout_ms" integer DEFAULT 20000 NOT NULL,
	"daily_limit" integer DEFAULT 500 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_ai" ADD CONSTRAINT "copilot_ai_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;