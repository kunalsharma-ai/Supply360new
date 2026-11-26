CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_controls" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"halted" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" text DEFAULT 'manual' NOT NULL,
	"batch_size" integer NOT NULL,
	"daily_max" integer NOT NULL,
	"review_interval_minutes" integer NOT NULL,
	"quiet_start_hour" integer NOT NULL,
	"quiet_end_hour" integer NOT NULL,
	"timezone" text NOT NULL,
	"reminder_offsets_hours" jsonb NOT NULL,
	"allowed_panels" jsonb NOT NULL,
	"link_valid_days" integer NOT NULL,
	"escalate_refusal_percent" integer NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"last_review_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"status" text NOT NULL,
	"mode" text NOT NULL,
	"policy_version" integer NOT NULL,
	"origin" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reason" text,
	"blocked_reason" text,
	"authorized" integer DEFAULT 0 NOT NULL,
	"refused" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"panel" text NOT NULL,
	"country_code" text NOT NULL,
	"madp_invitation_id" text NOT NULL,
	"status" text NOT NULL,
	"sent_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"click_reported_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "router_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid,
	"invitation_id" uuid,
	"kind" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_controls" ADD CONSTRAINT "execution_controls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_policies" ADD CONSTRAINT "execution_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_policies" ADD CONSTRAINT "execution_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_batches" ADD CONSTRAINT "invitation_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_batches" ADD CONSTRAINT "invitation_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_batches" ADD CONSTRAINT "invitation_batches_cell_id_quota_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."quota_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_cell_id_quota_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."quota_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_batch_id_invitation_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."invitation_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_events" ADD CONSTRAINT "router_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_events" ADD CONSTRAINT "router_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_events" ADD CONSTRAINT "router_events_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_key" ON "delivery_attempts" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "invitation_batches_project" ON "invitation_batches" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invitation_batches_due" ON "invitation_batches" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "invitations_click_outbox" ON "invitations" USING btree ("tenant_id","clicked_at") WHERE click_reported_at is null and clicked_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_project_ref" ON "invitations" USING btree ("project_id","ref");--> statement-breakpoint
CREATE INDEX "invitations_batch" ON "invitations" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_jobs_attempt" ON "reminder_jobs" USING btree ("invitation_id","attempt");--> statement-breakpoint
CREATE INDEX "reminder_jobs_due" ON "reminder_jobs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "router_events_recent" ON "router_events" USING btree ("tenant_id","at" DESC NULLS LAST);