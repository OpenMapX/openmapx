CREATE TABLE "auth_policy_application" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"intent_digest" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_policy_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"activation_version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" text NOT NULL,
	"activated_by" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_policy_singleton" CHECK ("auth_policy_state"."id"=1 AND "auth_policy_state"."activation_version"=1)
);
