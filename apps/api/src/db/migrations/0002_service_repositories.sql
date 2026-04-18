CREATE TABLE "service_repository" (
	"hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"display_name" text,
	"last_fetched_at" timestamp,
	"last_sha" text,
	"auto_update" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_repository_url_unique" UNIQUE("url")
);
