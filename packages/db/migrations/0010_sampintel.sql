CREATE TABLE "sampintel_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" "adapter_mode" NOT NULL,
	"base_url" text,
	"token_sealed" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_status" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "qa_mode" text DEFAULT 'human_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "sampintel_connections" ADD CONSTRAINT "sampintel_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sampintel_tenant" ON "sampintel_connections" USING btree ("tenant_id");