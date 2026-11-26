CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" text,
	"subject" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_marks" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"smtp_host" text,
	"smtp_port" integer DEFAULT 587 NOT NULL,
	"smtp_secure" boolean DEFAULT false NOT NULL,
	"smtp_user" text,
	"smtp_password_sealed" text,
	"from_address" text,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"webhook_enabled" boolean DEFAULT false NOT NULL,
	"webhook_url_sealed" text,
	"categories" jsonb DEFAULT '["delivery","automation","quota_full","ir_drop"]'::jsonb NOT NULL,
	"min_severity" text DEFAULT 'warning' NOT NULL,
	"ir_drop_points" integer DEFAULT 15 NOT NULL,
	"digest_enabled" boolean DEFAULT false NOT NULL,
	"digest_hour" integer DEFAULT 9 NOT NULL,
	"digest_timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"last_digest_on" text,
	"send_since" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_marks" ADD CONSTRAINT "alert_marks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_settings" ADD CONSTRAINT "alert_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_once" ON "alert_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "alert_deliveries_tenant_at" ON "alert_deliveries" USING btree ("tenant_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "alert_marks_key" ON "alert_marks" USING btree ("tenant_id","key");