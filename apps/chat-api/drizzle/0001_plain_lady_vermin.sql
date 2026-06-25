ALTER TABLE "sandbox_leases" ALTER COLUMN "sandbox_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD COLUMN "fencing_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD COLUMN "lease_expires_at" timestamp with time zone;