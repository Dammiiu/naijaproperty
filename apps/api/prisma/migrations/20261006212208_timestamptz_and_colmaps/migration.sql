/*
  Warnings:

  - You are about to drop the column `agencyFee` on the `listings` table. All the data in the column will be lost.
  - You are about to drop the column `deedType` on the `listings` table. All the data in the column will be lost.
  - You are about to drop the column `pricePeriod` on the `listings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "agent_profiles" ALTER COLUMN "licence_verified_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "areas" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "contact_reveals" ALTER COLUMN "revealed_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "last_message_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "listing_quotas" ALTER COLUMN "window_start" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "listing_review_events" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "listings" DROP COLUMN "agencyFee",
DROP COLUMN "deedType",
DROP COLUMN "pricePeriod",
ADD COLUMN     "agency_fee" BIGINT,
ADD COLUMN     "deed_type" "DeedType" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "price_period" "PricePeriod" NOT NULL DEFAULT 'NONE',
ALTER COLUMN "title_verified_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "submitted_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "reviewed_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "sla_due_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "promoted_until" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "published_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "media_assets" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "ready_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "message_reads" ALTER COLUMN "last_read_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "edited_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "moderation_signals" ALTER COLUMN "resolved_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "otp_challenges" ALTER COLUMN "sms_fallback_due_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "sms_fallback_sent_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "whatsapp_delivered_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "verified_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "payment_intents" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "completed_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "review_assignments" ALTER COLUMN "assigned_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "released_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "review_sla_policies" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "review_votes" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "reviews" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "saved_search_matches" ALTER COLUMN "notified_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "saved_searches" ALTER COLUMN "last_run_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "sessions" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "stay_records" ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "ended_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "owner_confirmed_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "tenant_confirmed_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "subscriptions" ALTER COLUMN "starts_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "ends_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "title_documents" ALTER COLUMN "reviewed_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "usage_counters" ALTER COLUMN "period_start" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "phone_verified_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "email_verified_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "last_login_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "locked_until" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "webhook_events" ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMPTZ,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ;
