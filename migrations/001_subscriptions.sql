-- =============================================
-- Run this ENTIRE script in your Supabase SQL Editor
-- =============================================

-- =============================================
-- 1. FIX PROFILES TABLE RLS (fixes the insert error)
-- =============================================
-- Drop existing restrictive policies if any
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
DROP POLICY IF EXISTS "Service role full access profiles" ON profiles;
DROP POLICY IF EXISTS "Enable insert for service role" ON profiles;
DROP POLICY IF EXISTS "Enable read for users" ON profiles;

-- Allow the service role (backend) to do everything on profiles
CREATE POLICY "Service role full access profiles"
  ON profiles FOR ALL
  USING (true)
  WITH CHECK (true);

-- Allow users to read their own profile
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- =============================================
-- 2. CREATE SUBSCRIPTIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free_trial',
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_plan CHECK (plan IN ('free_trial', 'daily', 'monthly', 'unlimited')),
  CONSTRAINT valid_status CHECK (status IN ('active', 'expired', 'cancelled'))
);

-- One active subscription per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_active
  ON subscriptions(user_id) WHERE status = 'active';

-- Index for expiry checks
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires
  ON subscriptions(expires_at) WHERE status = 'active';

-- Enable RLS
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "Users can read own subscriptions" ON subscriptions;
DROP POLICY IF EXISTS "Service role full access" ON subscriptions;

-- Service role (backend) can do everything
CREATE POLICY "Service role full access"
  ON subscriptions FOR ALL
  USING (true)
  WITH CHECK (true);

-- Users can read their own subscriptions
CREATE POLICY "Users can read own subscriptions"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);
