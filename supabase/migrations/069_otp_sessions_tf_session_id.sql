-- ════════════════════════════════════════════════════════════════
-- 069 — OTP sessions: add 2Factor AUTOGEN session_id column
--
-- The OTP flow now uses 2Factor AUTOGEN (2Factor generates and
-- validates the OTP).  The session_id returned by the send call
-- is stored here and used for verification via
--   GET /API/V1/{key}/SMS/VERIFY/{tf_session_id}/{otp}
--
-- otp_hash is retained (nullable) so existing rows are not broken.
-- New rows will have otp_hash = NULL and tf_session_id populated.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE pramaana.otp_sessions
  ADD COLUMN IF NOT EXISTS tf_session_id TEXT,
  ALTER COLUMN otp_hash DROP NOT NULL;
