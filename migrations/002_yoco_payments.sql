-- =============================================
-- Payment integration: allow 'pending' status and add provider_ref
-- Run this in your Supabase SQL Editor
-- =============================================

-- Allow 'pending' status for subscriptions awaiting payment confirmation
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE subscriptions
  ADD CONSTRAINT valid_status
  CHECK (status IN ('pending', 'active', 'expired', 'cancelled'));

-- Store the external payment-provider reference (for example a Paystack reference)
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider_ref TEXT;

-- Index for quick lookups from webhooks
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_ref
  ON subscriptions(provider_ref) WHERE provider_ref IS NOT NULL;
