CREATE TABLE "post_vectors" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"user_id" text NOT NULL,
	"round_id" text,
	"embedding" vector(1024) NOT NULL,
	"card_sim" double precision,
	"max_sim" double precision,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_vectors_post_id_unique" UNIQUE("post_id")
);
--> statement-breakpoint
ALTER TABLE "population_metrics" ADD COLUMN "era" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
CREATE INDEX "pvec_round_idx" ON "post_vectors" USING btree ("round_id");--> statement-breakpoint
CREATE INDEX "pvec_user_created_idx" ON "post_vectors" USING btree ("user_id","created_at");