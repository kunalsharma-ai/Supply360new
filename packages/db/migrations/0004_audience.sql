CREATE TABLE "allocation_plans" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" text DEFAULT 'proportional' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" "adapter_mode" NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"client_id" text,
	"secret_sealed" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check_result" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience_segments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience_selections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"data_mode" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"eligible" integer,
	"returned" integer NOT NULL,
	"excluded" jsonb NOT NULL,
	"refs" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_cells" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"country_code" text NOT NULL,
	"source_cell_id" text NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"conditions_hash" text NOT NULL,
	"source_target" integer NOT NULL,
	"source_completes" integer DEFAULT 0 NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"criteria" jsonb,
	"mapped_by" uuid,
	"mapped_at" timestamp with time zone,
	"allocation_target" integer,
	"invite_cap" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"requested" integer NOT NULL,
	"held" integer NOT NULL,
	"refused" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reserved_refs" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"panel" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_plans" ADD CONSTRAINT "allocation_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_plans" ADD CONSTRAINT "allocation_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_connections" ADD CONSTRAINT "audience_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_segments" ADD CONSTRAINT "audience_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_selections" ADD CONSTRAINT "audience_selections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_selections" ADD CONSTRAINT "audience_selections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_selections" ADD CONSTRAINT "audience_selections_cell_id_quota_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."quota_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_selections" ADD CONSTRAINT "audience_selections_connection_id_audience_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."audience_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_cells" ADD CONSTRAINT "quota_cells_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_cells" ADD CONSTRAINT "quota_cells_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cell_id_quota_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."quota_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_selection_id_audience_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."audience_selections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_connection_id_audience_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."audience_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserved_refs" ADD CONSTRAINT "reserved_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserved_refs" ADD CONSTRAINT "reserved_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserved_refs" ADD CONSTRAINT "reserved_refs_cell_id_quota_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."quota_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserved_refs" ADD CONSTRAINT "reserved_refs_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audience_connections_tenant" ON "audience_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audience_segments_name" ON "audience_segments" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "audience_selections_project" ON "audience_selections" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "quota_cells_source" ON "quota_cells" USING btree ("project_id","country_code","source_cell_id");--> statement-breakpoint
CREATE INDEX "reservations_project" ON "reservations" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reserved_refs_project_ref" ON "reserved_refs" USING btree ("project_id","ref");--> statement-breakpoint
CREATE INDEX "reserved_refs_cell" ON "reserved_refs" USING btree ("cell_id","expires_at");