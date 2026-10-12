-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'AGENT', 'MODERATOR', 'ADMIN', 'SUPERADMIN');

-- CreateEnum
CREATE TYPE "VerificationTier" AS ENUM ('NONE', 'PHONE', 'DOCUMENT', 'VERIFIED_AGENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "ListingKind" AS ENUM ('SALE', 'RENT');

-- CreateEnum
CREATE TYPE "PricePeriod" AS ENUM ('NONE', 'MONTHLY', 'TWO_YEARLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "DeedType" AS ENUM ('NONE', 'COFO', 'EXCISION_GAZETTE', 'SURVEY', 'DEED_OF_ASSIGNMENT', 'SUBJECT_TO');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'LIVE', 'REJECTED', 'EXPIRED', 'RESERVED', 'SOLD', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'CLEAR', 'FLAGGED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('SUBMITTED', 'ASSIGNED', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'ESCALATED', 'AUTO_FLAGGED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReviewReasonCode" AS ENUM ('PHOTO_QUALITY', 'PRICE_MISMATCH', 'MISSING_FIELD', 'WRONG_LOCATION', 'DUPLICATE_LISTING', 'SUSPECTED_SCAM', 'TITLE_MISMATCH', 'CONTACT_IN_BODY', 'POLICY_VIOLATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ModerationSignalKind" AS ENUM ('IMAGE_NSFW', 'VIDEO_NSFW', 'PRICE_OUTLIER', 'DUPLICATE_MEDIA', 'CONTACT_IN_BODY', 'BANNED_TERM', 'TITLE_DOC_MISSING');

-- CreateEnum
CREATE TYPE "SignalSeverity" AS ENUM ('INFO', 'WARN', 'BLOCK');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReviewEligibility" AS ENUM ('REVEALED', 'STAY_RECORDED', 'ADMIN_OVERRIDE');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'PENDING', 'REJECTED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "NotifyChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "NotifyCadence" AS ENUM ('INSTANT', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('NOOP', 'PAYSTACK', 'FLUTTERWAVE', 'MONIEPOINT');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('WHATSAPP', 'SMS');

-- CreateEnum
CREATE TYPE "OtpStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'VERIFIED', 'EXPIRED', 'ATTEMPTS_EXCEEDED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "phone_enc" TEXT,
    "phone_idx" TEXT,
    "phone_verified_at" TIMESTAMP(3),
    "password_hash" TEXT,
    "google_sub" TEXT,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "verificationTier" "VerificationTier" NOT NULL DEFAULT 'NONE',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "two_factor_secret" TEXT,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "scope_states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email_verified_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "device_label" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agency_name" TEXT,
    "licence_no" TEXT,
    "licence_body" TEXT,
    "licence_doc_asset_id" TEXT,
    "licence_verified_at" TIMESTAMP(3),
    "years_active" INTEGER,
    "bio" TEXT,
    "office_states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "website_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "states" (
    "code" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "centre_lat" DOUBLE PRECISION,
    "centre_lng" DOUBLE PRECISION,

    CONSTRAINT "states_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "lgas" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "name" TEXT NOT NULL,
    "state_code" CHAR(2) NOT NULL,
    "centre_lat" DOUBLE PRECISION,
    "centre_lng" DOUBLE PRECISION,

    CONSTRAINT "lgas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "norm_name" TEXT NOT NULL,
    "lga_id" TEXT NOT NULL,
    "state_code" CHAR(2) NOT NULL,
    "geom" geometry(Polygon, 4326),
    "centre_lat" DOUBLE PRECISION,
    "centre_lng" DOUBLE PRECISION,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "proposal_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "area_aliases" (
    "id" TEXT NOT NULL,
    "area_id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "norm_alias" TEXT NOT NULL,

    CONSTRAINT "area_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_kinds" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price_periods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requires_deed_doc" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "listing_kinds_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "listing_types" (
    "kind_code" TEXT NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "requires_bedrooms" BOOLEAN NOT NULL DEFAULT false,
    "requires_plot_size" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "listing_types_pkey" PRIMARY KEY ("kind_code","code")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "kind_code" TEXT NOT NULL,
    "type_code" VARCHAR(32) NOT NULL,
    "state_code" CHAR(2) NOT NULL,
    "lga_id" TEXT NOT NULL,
    "area_id" TEXT,
    "exact_address_enc" TEXT,
    "map_lat" DOUBLE PRECISION,
    "map_lng" DOUBLE PRECISION,
    "title" TEXT NOT NULL,
    "title_norm" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "pricePeriod" "PricePeriod" NOT NULL DEFAULT 'NONE',
    "price_negotiable" BOOLEAN NOT NULL DEFAULT false,
    "payment_advance" INTEGER,
    "agencyFee" BIGINT,
    "minimum_stay_months" INTEGER,
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "toilets" INTEGER,
    "parking_spaces" INTEGER,
    "plot_sqm" INTEGER,
    "built_sqm" INTEGER,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deedType" "DeedType" NOT NULL DEFAULT 'NONE',
    "title_verified_at" TIMESTAMP(3),
    "video_asset_id" TEXT,
    "deed_doc_asset_id" TEXT,
    "poster_id" TEXT NOT NULL,
    "agency_id" TEXT,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "reviewer_id" TEXT,
    "sla_due_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "promoted_until" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "contact_click_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_media" (
    "listing_id" TEXT NOT NULL,
    "media_asset_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_cover" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "listing_media_pkey" PRIMARY KEY ("listing_id","media_asset_id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "mime" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "content_hash" TEXT,
    "storage_key" TEXT,
    "stream_uid" TEXT,
    "playback_hls" TEXT,
    "poster_url" TEXT,
    "blurhash" TEXT,
    "dominant_color" TEXT,
    "exif_gps" TEXT,
    "exif_stripped" BOOLEAN NOT NULL DEFAULT false,
    "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderation_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_sla_policies" (
    "kind_code" TEXT NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "warn_minutes" INTEGER NOT NULL,
    "escalate_minutes" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_sla_policies_pkey" PRIMARY KEY ("kind_code")
);

-- CreateTable
CREATE TABLE "listing_review_events" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" "ReviewAction" NOT NULL,
    "reason_code" "ReviewReasonCode",
    "note" TEXT,
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_assignments" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "review_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_signals" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "signal" "ModerationSignalKind" NOT NULL,
    "severity" "SignalSeverity" NOT NULL,
    "source" TEXT NOT NULL,
    "detail" JSONB,
    "issued_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "title_documents" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "deedType" "DeedType" NOT NULL,
    "media_asset_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "title_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_reveals" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "viewer_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'WEB',
    "ip_hash" TEXT,
    "revealed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "contact_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "initiator_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "attachment_media_id" TEXT,
    "client_message_id" TEXT NOT NULL,
    "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderation_notes" TEXT,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reads" (
    "conversation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_read_message_id" TEXT,
    "last_read_at" TIMESTAMP(3),

    CONSTRAINT "message_reads_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "rating_overall" INTEGER NOT NULL,
    "rating_communication" INTEGER,
    "rating_accuracy" INTEGER,
    "rating_value" INTEGER,
    "body" VARCHAR(4000) NOT NULL,
    "eligibility" "ReviewEligibility" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_votes" (
    "review_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_votes_pkey" PRIMARY KEY ("review_id","user_id")
);

-- CreateTable
CREATE TABLE "stay_records" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "owner_confirmed_at" TIMESTAMP(3),
    "tenant_confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stay_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_searches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query_json" JSONB NOT NULL,
    "notify_channels" "NotifyChannel"[] DEFAULT ARRAY[]::"NotifyChannel"[],
    "cadence" "NotifyCadence" NOT NULL DEFAULT 'DAILY',
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_search_matches" (
    "id" TEXT NOT NULL,
    "saved_search_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_search_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "price_ngn" BIGINT NOT NULL,
    "billing_period" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "plan_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "limit_json" JSONB,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("plan_id","feature")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_code" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "provider" "PaymentProvider" NOT NULL DEFAULT 'NOOP',
    "external_ref" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_quotas" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "listings_used" INTEGER NOT NULL DEFAULT 0,
    "listings_granted" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "amount_ngn" BIGINT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'NOOP',
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "provider_ref" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" TEXT NOT NULL,
    "phone_idx" TEXT NOT NULL,
    "user_id" TEXT,
    "code_hash" TEXT NOT NULL,
    "primary_channel" "OtpChannel" NOT NULL DEFAULT 'WHATSAPP',
    "status" "OtpStatus" NOT NULL DEFAULT 'PENDING',
    "whatsapp_message_id" TEXT,
    "sms_message_id" TEXT,
    "sms_fallback_due_at" TIMESTAMP(3),
    "sms_fallback_sent_at" TIMESTAMP(3),
    "whatsapp_delivered_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_idx_key" ON "users"("phone_idx");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- CreateIndex
CREATE INDEX "users_status_created_at_idx" ON "users"("status", "created_at");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_user_id_key" ON "agent_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "states_slug_key" ON "states"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "lgas_code_key" ON "lgas"("code");

-- CreateIndex
CREATE INDEX "lgas_state_code_idx" ON "lgas"("state_code");

-- CreateIndex
CREATE UNIQUE INDEX "lgas_state_code_name_key" ON "lgas"("state_code", "name");

-- CreateIndex
CREATE INDEX "areas_state_code_is_active_idx" ON "areas"("state_code", "is_active");

-- CreateIndex
CREATE INDEX "areas_norm_name_idx" ON "areas"("norm_name");

-- CreateIndex
CREATE UNIQUE INDEX "areas_lga_id_norm_name_key" ON "areas"("lga_id", "norm_name");

-- CreateIndex
CREATE INDEX "area_aliases_norm_alias_idx" ON "area_aliases"("norm_alias");

-- CreateIndex
CREATE UNIQUE INDEX "area_aliases_norm_alias_area_id_key" ON "area_aliases"("norm_alias", "area_id");

-- CreateIndex
CREATE INDEX "listing_types_code_idx" ON "listing_types"("code");

-- CreateIndex
CREATE INDEX "listings_status_kind_code_published_at_idx" ON "listings"("status", "kind_code", "published_at");

-- CreateIndex
CREATE INDEX "listings_kind_code_state_code_status_price_idx" ON "listings"("kind_code", "state_code", "status", "price");

-- CreateIndex
CREATE INDEX "listings_area_id_status_idx" ON "listings"("area_id", "status");

-- CreateIndex
CREATE INDEX "listings_lga_id_status_idx" ON "listings"("lga_id", "status");

-- CreateIndex
CREATE INDEX "listings_poster_id_status_idx" ON "listings"("poster_id", "status");

-- CreateIndex
CREATE INDEX "listings_type_code_status_idx" ON "listings"("type_code", "status");

-- CreateIndex
CREATE INDEX "listings_sla_due_at_idx" ON "listings"("sla_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "listing_media_listing_id_position_key" ON "listing_media"("listing_id", "position");

-- CreateIndex
CREATE INDEX "media_assets_status_created_at_idx" ON "media_assets"("status", "created_at");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_kind_idx" ON "media_assets"("owner_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_owner_id_content_hash_key" ON "media_assets"("owner_id", "content_hash");

-- CreateIndex
CREATE INDEX "listing_review_events_listing_id_created_at_idx" ON "listing_review_events"("listing_id", "created_at");

-- CreateIndex
CREATE INDEX "listing_review_events_action_created_at_idx" ON "listing_review_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "listing_review_events_sla_breached_idx" ON "listing_review_events"("sla_breached");

-- CreateIndex
CREATE INDEX "review_assignments_reviewer_id_released_at_idx" ON "review_assignments"("reviewer_id", "released_at");

-- CreateIndex
CREATE INDEX "review_assignments_listing_id_released_at_idx" ON "review_assignments"("listing_id", "released_at");

-- CreateIndex
CREATE INDEX "moderation_signals_listing_id_severity_idx" ON "moderation_signals"("listing_id", "severity");

-- CreateIndex
CREATE INDEX "moderation_signals_created_at_idx" ON "moderation_signals"("created_at");

-- CreateIndex
CREATE INDEX "title_documents_listing_id_idx" ON "title_documents"("listing_id");

-- CreateIndex
CREATE INDEX "contact_reveals_viewer_id_revealed_at_idx" ON "contact_reveals"("viewer_id", "revealed_at");

-- CreateIndex
CREATE INDEX "contact_reveals_owner_id_revealed_at_idx" ON "contact_reveals"("owner_id", "revealed_at");

-- CreateIndex
CREATE UNIQUE INDEX "contact_reveals_listing_id_viewer_id_key" ON "contact_reveals"("listing_id", "viewer_id");

-- CreateIndex
CREATE INDEX "conversations_initiator_id_last_message_at_idx" ON "conversations"("initiator_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_owner_id_last_message_at_idx" ON "conversations"("owner_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_listing_id_initiator_id_key" ON "conversations"("listing_id", "initiator_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_message_id_key" ON "messages"("conversation_id", "client_message_id");

-- CreateIndex
CREATE INDEX "reviews_listing_id_status_created_at_idx" ON "reviews"("listing_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_listing_id_author_id_key" ON "reviews"("listing_id", "author_id");

-- CreateIndex
CREATE INDEX "stay_records_listing_id_idx" ON "stay_records"("listing_id");

-- CreateIndex
CREATE INDEX "saved_searches_user_id_idx" ON "saved_searches"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_search_matches_saved_search_id_listing_id_key" ON "saved_search_matches"("saved_search_id", "listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_external_ref_key" ON "subscriptions"("external_ref");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "listing_quotas_user_id_window_start_key" ON "listing_quotas"("user_id", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_user_id_feature_period_start_key" ON "usage_counters"("user_id", "feature", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_idempotency_key_key" ON "payment_intents"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_intents_user_id_created_at_idx" ON "payment_intents"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_idx_created_at_idx" ON "otp_challenges"("phone_idx", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_status_sms_fallback_due_at_idx" ON "otp_challenges"("status", "sms_fallback_due_at");

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_external_id_key" ON "webhook_events"("provider", "external_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lgas" ADD CONSTRAINT "lgas_state_code_fkey" FOREIGN KEY ("state_code") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_lga_id_fkey" FOREIGN KEY ("lga_id") REFERENCES "lgas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_state_code_fkey" FOREIGN KEY ("state_code") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "area_aliases" ADD CONSTRAINT "area_aliases_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_types" ADD CONSTRAINT "listing_types_kind_code_fkey" FOREIGN KEY ("kind_code") REFERENCES "listing_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_kind_code_fkey" FOREIGN KEY ("kind_code") REFERENCES "listing_kinds"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_type_code_kind_code_fkey" FOREIGN KEY ("type_code", "kind_code") REFERENCES "listing_types"("code", "kind_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_state_code_fkey" FOREIGN KEY ("state_code") REFERENCES "states"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_lga_id_fkey" FOREIGN KEY ("lga_id") REFERENCES "lgas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_video_asset_id_fkey" FOREIGN KEY ("video_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_deed_doc_asset_id_fkey" FOREIGN KEY ("deed_doc_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_poster_id_fkey" FOREIGN KEY ("poster_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agent_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_review_events" ADD CONSTRAINT "listing_review_events_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_review_events" ADD CONSTRAINT "listing_review_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_signals" ADD CONSTRAINT "moderation_signals_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_signals" ADD CONSTRAINT "moderation_signals_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "title_documents" ADD CONSTRAINT "title_documents_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "title_documents" ADD CONSTRAINT "title_documents_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_reveals" ADD CONSTRAINT "contact_reveals_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_media_id_fkey" FOREIGN KEY ("attachment_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_last_read_message_id_fkey" FOREIGN KEY ("last_read_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_search_matches" ADD CONSTRAINT "saved_search_matches_saved_search_id_fkey" FOREIGN KEY ("saved_search_id") REFERENCES "saved_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_search_matches" ADD CONSTRAINT "saved_search_matches_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
