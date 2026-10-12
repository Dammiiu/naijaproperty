SELECT l.id, l.status, l.rejection_reason FROM listings l WHERE l.status='CHANGES_REQUESTED' LIMIT 3;
SELECT listing_id, signal, severity, source FROM moderation_signals ORDER BY created_at DESC LIMIT 5;
