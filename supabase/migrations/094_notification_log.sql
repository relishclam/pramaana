-- ════════════════════════════════════════════════════════════════════════════
-- 094_notification_log.sql
-- Audit table for every WhatsApp/SMS notification attempt.
-- Insert-only; no UPDATE/DELETE grants to any role.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pramaana.notification_log (
  id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template            TEXT        NOT NULL,          -- e.g. 'pramaana_payment_confirmed'
  msg91_template_id   TEXT,                          -- e.g. '461944'
  recipient_masked    TEXT        NOT NULL,          -- e.g. '91****12324'
  ref_id              UUID,                          -- voucher_id / query_id / suspense_id
  ref_type            TEXT        CHECK (ref_type IN ('voucher','recon_query','suspense')),
  vars_count          INT,
  test_mode           BOOLEAN     NOT NULL DEFAULT false,
  intended_recipient  TEXT,                          -- original when test_mode redirected
  msg91_request_id    TEXT,
  status              TEXT        NOT NULL CHECK (status IN ('sent','error','skipped')),
  error_message       TEXT,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_log_ref
  ON pramaana.notification_log (ref_id, ref_type);

CREATE INDEX IF NOT EXISTS notification_log_sent_at
  ON pramaana.notification_log (sent_at DESC);

ALTER TABLE pramaana.notification_log ENABLE ROW LEVEL SECURITY;

-- Super admins can read; service_role can insert (no direct insert from authenticated)
DROP POLICY IF EXISTS notification_log_read  ON pramaana.notification_log;
CREATE POLICY notification_log_read ON pramaana.notification_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM registry.company_users cu
      WHERE cu.user_id = auth.uid()
      AND cu.role IN ('super_admin','accounts')
    )
  );

DROP POLICY IF EXISTS notification_log_service ON pramaana.notification_log;
CREATE POLICY notification_log_service ON pramaana.notification_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pramaana.notification_log TO authenticated;
GRANT INSERT, SELECT ON pramaana.notification_log TO service_role;
