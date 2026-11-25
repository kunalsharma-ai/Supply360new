CREATE TYPE "public"."adapter_mode" AS ENUM('fixture', 'live');--> statement-breakpoint
CREATE TYPE "public"."project_lifecycle" AS ENUM('imported', 'ready', 'live', 'paused', 'source_hold', 'closed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('samptrek', 'sampcloud');--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source" "source_kind" NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"delivery_id" text,
	"signed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"error" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_markets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"country_code" text NOT NULL,
	"language" text,
	"target_group" text,
	"source_status" text NOT NULL,
	"loi_minutes" integer,
	"ir_percent" integer,
	"target_completes" integer DEFAULT 0 NOT NULL,
	"completes" integer DEFAULT 0 NOT NULL,
	"vendor_link_id" text,
	"vendor_link_status" text,
	"vendor_target" integer,
	"vendor_completes" integer,
	"entry_url" text,
	"entry_approved_by" uuid,
	"entry_approved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"via" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source" "source_kind" NOT NULL,
	"source_project_id" text NOT NULL,
	"project_code" text NOT NULL,
	"name" text NOT NULL,
	"client_name" text,
	"project_manager_name" text,
	"project_type" text,
	"category" text,
	"source_status" text NOT NULL,
	"lifecycle" "project_lifecycle" DEFAULT 'imported' NOT NULL,
	"field_start_at" timestamp with time zone,
	"field_end_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redirect_hits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"respondent_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"mode" "adapter_mode" NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"api_key_sealed" text,
	"webhook_secret_sealed" text NOT NULL,
	"vendor_code" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"poll_checkpoint" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_sync_result" jsonb,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"last_rejected_at" timestamp with time zone,
	"last_rejected_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_connection_id_source_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_markets" ADD CONSTRAINT "project_markets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_markets" ADD CONSTRAINT "project_markets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_connection_id_source_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."source_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirect_hits" ADD CONSTRAINT "redirect_hits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirect_hits" ADD CONSTRAINT "redirect_hits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_dedup" ON "inbound_events" USING btree ("tenant_id","source","event_id");--> statement-breakpoint
CREATE INDEX "inbound_events_recent" ON "inbound_events" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_markets_cc" ON "project_markets" USING btree ("project_id","country_code");--> statement-breakpoint
CREATE UNIQUE INDEX "project_versions_n" ON "project_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_source_ref" ON "projects" USING btree ("tenant_id","source","source_project_id");--> statement-breakpoint
CREATE INDEX "projects_tenant_updated" ON "projects" USING btree ("tenant_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "redirect_hits_project" ON "redirect_hits" USING btree ("tenant_id","project_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "source_connections_tenant" ON "source_connections" USING btree ("tenant_id");