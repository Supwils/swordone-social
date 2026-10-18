CREATE TABLE "round_observations" (
	"round_id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"model" text NOT NULL,
	"digest_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
