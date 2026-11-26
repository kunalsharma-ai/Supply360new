CREATE TABLE "participation_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"verified" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"session_ref" text,
	"effect" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "quality_flags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"differences" jsonb NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reward_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "execution_policies" ADD COLUMN "speeder_percent" integer;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "outcome_source" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "session_ref" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "loi_seconds" integer;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "approval" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "approval_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "outcome_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "reinvite_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "last_reinvited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "origin" text DEFAULT 'match' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connections" ADD COLUMN "callback_secret_sealed" text;--> statement-breakpoint
ALTER TABLE "participation_events" ADD CONSTRAINT "participation_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_events" ADD CONSTRAINT "participation_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation_events" ADD CONSTRAINT "participation_events_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_flags" ADD CONSTRAINT "quality_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_flags" ADD CONSTRAINT "quality_flags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_flags" ADD CONSTRAINT "quality_flags_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participation_events_key" ON "participation_events" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "participation_events_project" ON "participation_events" USING btree ("tenant_id","project_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "participation_events_invitation" ON "participation_events" USING btree ("invitation_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_flags_once" ON "quality_flags" USING btree ("invitation_id","kind");--> statement-breakpoint
CREATE INDEX "quality_flags_open" ON "quality_flags" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_runs_project" ON "reconciliation_runs" USING btree ("tenant_id","project_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reward_events_invitation" ON "reward_events" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "reward_events_status" ON "reward_events" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "invitations_participated" ON "invitations" USING btree ("tenant_id","outcome_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invitations_project_outcome" ON "invitations" USING btree ("project_id","outcome");