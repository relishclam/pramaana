-- ── 041_create_linked_vouchers.sql ───────────────────────────────────────────
--
-- Atomic creation of a Purchase + Payment voucher pair, linked by a single
-- voucher_allocation row.  All five inserts execute in one transaction:
--
--   1. pramaana.vouchers      (Purchase  → status = pending_approval)
--   2. pramaana.voucher_entries for Purchase
--   3. pramaana.vouchers      (Payment   → status = pending_approval)
--   4. pramaana.voucher_entries for Payment
--   5. pramaana.voucher_allocations (links the two)
--
-- SCOPE: Intentionally 1 Purchase : 1 Payment : 1 allocation (1:1:1).
-- This RPC must NOT be generalised to accept arrays of vouchers.
-- Doing so would require looping INSERTs inside the function, reintroducing
-- the very partial-transaction window this RPC exists to eliminate.
--
-- Multi-bill allocation  (one Payment settling multiple existing Purchase bills)
-- Installment settlement (one Purchase paid across multiple Payments over time)
-- → Both continue to use the existing BillAllocPanel / saveAllocations() path.
--   They are outside this RPC entirely.
--
-- Status note: both vouchers are created as 'pending_approval', NOT 'posted'.
-- 'posted' is the terminal state reached only after payment is recorded.
-- Setting it here would make the Purchase invisible in all financial reports
-- (Day Book, Ledger, Trial Balance, Receivables/Payables all filter on terminal
-- states).  The combined approval screen surfaces both vouchers to the approver
-- together; one OTP approves both.
--
-- Sequence gaps: registry.next_fy_sequence uses a non-transactional counter.
-- If the outer transaction rolls back, the sequence numbers are consumed and
-- a gap appears.  This is acceptable per standard accounting practice.
--
-- Safe: CREATE OR REPLACE — idempotent, re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pramaana.create_linked_vouchers(
  -- Purchase voucher descriptor
  -- Required keys: company_id, company_code, prefix, voucher_type_id,
  --                voucher_date, entity_id, amount, created_by
  -- Optional keys: narration, cost_centre_id, ref_document_number
  p_purchase         JSONB,

  -- Purchase accounting entries
  -- Each element: { ledger_id, entry_type ('Dr'|'Cr'), amount, narration, sort_order }
  p_purchase_entries JSONB,

  -- Payment voucher descriptor
  -- Required keys: company_id, company_code, prefix, voucher_type_id,
  --                voucher_date, entity_id, amount, payment_mode, created_by
  -- Optional keys: narration, bank_ledger_id, cost_centre_id, ref_document_number,
  --                cheque_number, cheque_date, utr_number
  p_payment          JSONB,

  -- Payment accounting entries (same element shape as p_purchase_entries)
  p_payment_entries  JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (default): runs as the calling user.
-- RLS on pramaana.vouchers / voucher_entries / voucher_allocations applies normally.
AS $$
DECLARE
  v_purchase_id   UUID;
  v_payment_id    UUID;
  v_purchase_num  TEXT;
  v_payment_num   TEXT;
  v_alloc_id      UUID;
  v_entry         JSONB;
  v_purchase_amt  NUMERIC(15,2);
  v_payment_amt   NUMERIC(15,2);
  -- Balance-check accumulators
  v_purchase_dr   NUMERIC(15,2);
  v_purchase_cr   NUMERIC(15,2);
  v_payment_dr    NUMERIC(15,2);
  v_payment_cr    NUMERIC(15,2);
BEGIN

  -- ── Guard: amounts must match (1:1:1 invariant) ─────────────────────────────
  v_purchase_amt := (p_purchase->>'amount')::NUMERIC;
  v_payment_amt  := (p_payment->>'amount')::NUMERIC;

  IF v_purchase_amt IS NULL OR v_purchase_amt <= 0 THEN
    RAISE EXCEPTION 'create_linked_vouchers: purchase amount must be a positive number (got %)',
      p_purchase->>'amount';
  END IF;

  IF v_payment_amt IS NULL OR v_payment_amt <= 0 THEN
    RAISE EXCEPTION 'create_linked_vouchers: payment amount must be a positive number (got %)',
      p_payment->>'amount';
  END IF;

  IF round(v_purchase_amt, 2) != round(v_payment_amt, 2) THEN
    RAISE EXCEPTION
      'create_linked_vouchers: purchase amount (%) and payment amount (%) must be equal for 1:1:1 creation. Use BillAllocPanel + saveAllocations() for partial payments.',
      v_purchase_amt, v_payment_amt;
  END IF;

  IF jsonb_array_length(p_purchase_entries) < 2 THEN
    RAISE EXCEPTION 'create_linked_vouchers: purchase must have at least 2 entry rows (got %)',
      jsonb_array_length(p_purchase_entries);
  END IF;

  IF jsonb_array_length(p_payment_entries) < 2 THEN
    RAISE EXCEPTION 'create_linked_vouchers: payment must have at least 2 entry rows (got %)',
      jsonb_array_length(p_payment_entries);
  END IF;

  -- ── Guard: entity_id must match on both sides ────────────────────────────────
  -- IS DISTINCT FROM handles NULLs correctly: two NULLs are not distinct (equal),
  -- NULL vs. a value is distinct (mismatch). Prevents a client bug silently
  -- allocating a Payment to Vendor B against a Purchase from Vendor A.
  -- Note on NULL entity_id: two NULLs pass this check. In this RPC's specific
  -- context ("invoice just arrived, paying now") there is by definition a vendor,
  -- so a NULL entity_id is unusual — more likely a form that failed to populate
  -- the party than a legitimate no-party purchase. Not blocked here, but if this
  -- RPC starts receiving NULL entity_id in practice, treat it as a client-bug signal.
  IF (p_purchase->>'entity_id') IS DISTINCT FROM (p_payment->>'entity_id') THEN
    RAISE EXCEPTION
      'create_linked_vouchers: purchase entity_id (%) and payment entity_id (%) must match',
      p_purchase->>'entity_id', p_payment->>'entity_id';
  END IF;

  -- ── Guard: each entry set must balance (Dr = Cr = stated amount) ─────────────
  -- Client-side balance validation exists but is not sufficient — an unbalanced
  -- entry here would not surface as an error; it would surface as a Trial Balance
  -- that quietly doesn't tie out, weeks after the fact.
  -- NOTE: entry_type values ('Dr'/'Cr') are trusted here. If pramaana.voucher_entries
  -- does NOT have a CHECK (entry_type IN ('Dr','Cr')) constraint, add it at the table
  -- level (not here) so all insert paths are covered, not just this RPC.

  SELECT
    COALESCE(SUM((e->>'amount')::NUMERIC) FILTER (WHERE e->>'entry_type' = 'Dr'), 0),
    COALESCE(SUM((e->>'amount')::NUMERIC) FILTER (WHERE e->>'entry_type' = 'Cr'), 0)
  INTO v_purchase_dr, v_purchase_cr
  FROM jsonb_array_elements(p_purchase_entries) e;

  IF round(v_purchase_dr, 2) != round(v_purchase_cr, 2)
     OR round(v_purchase_dr, 2) != round(v_purchase_amt, 2) THEN
    RAISE EXCEPTION
      'create_linked_vouchers: purchase entries unbalanced — Dr=%, Cr=%, voucher amount=%',
      v_purchase_dr, v_purchase_cr, v_purchase_amt;
  END IF;

  SELECT
    COALESCE(SUM((e->>'amount')::NUMERIC) FILTER (WHERE e->>'entry_type' = 'Dr'), 0),
    COALESCE(SUM((e->>'amount')::NUMERIC) FILTER (WHERE e->>'entry_type' = 'Cr'), 0)
  INTO v_payment_dr, v_payment_cr
  FROM jsonb_array_elements(p_payment_entries) e;

  IF round(v_payment_dr, 2) != round(v_payment_cr, 2)
     OR round(v_payment_dr, 2) != round(v_payment_amt, 2) THEN
    RAISE EXCEPTION
      'create_linked_vouchers: payment entries unbalanced — Dr=%, Cr=%, voucher amount=%',
      v_payment_dr, v_payment_cr, v_payment_amt;
  END IF;

  -- ── Step 1: Generate voucher numbers ────────────────────────────────────────
  -- Sequence calls are non-transactional: numbers are consumed even on rollback.
  -- Gaps in sequence are acceptable per accounting standards.

  SELECT registry.next_fy_sequence(
    (p_purchase->>'company_id')::UUID,
     p_purchase->>'company_code',
     p_purchase->>'prefix'
  ) INTO v_purchase_num;

  SELECT registry.next_fy_sequence(
    (p_payment->>'company_id')::UUID,
     p_payment->>'company_code',
     p_payment->>'prefix'
  ) INTO v_payment_num;

  -- ── Step 2: Insert Purchase voucher ─────────────────────────────────────────
  INSERT INTO pramaana.vouchers (
    company_id,
    voucher_type_id,
    voucher_number,
    voucher_date,
    narration,
    entity_id,
    amount,
    payment_mode,
    cost_centre_id,
    ref_document_number,
    status,
    created_by
  ) VALUES (
    (p_purchase->>'company_id')::UUID,
    (p_purchase->>'voucher_type_id')::UUID,
     v_purchase_num,
    (p_purchase->>'voucher_date')::DATE,
     p_purchase->>'narration',
    (p_purchase->>'entity_id')::UUID,
     v_purchase_amt,
     p_purchase->>'payment_mode',        -- nullable; purchase usually NULL
    (p_purchase->>'cost_centre_id')::UUID,
     p_purchase->>'ref_document_number',
    'pending_approval',                  -- never 'posted' — see header comment
    (p_purchase->>'created_by')::UUID
  )
  RETURNING id INTO v_purchase_id;

  -- ── Step 3: Insert Purchase entry rows ──────────────────────────────────────
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_purchase_entries)
  LOOP
    INSERT INTO pramaana.voucher_entries (
      voucher_id,
      ledger_id,
      entry_type,
      amount,
      narration,
      sort_order
    ) VALUES (
      v_purchase_id,
      (v_entry->>'ledger_id')::UUID,
       v_entry->>'entry_type',
      (v_entry->>'amount')::NUMERIC,
       v_entry->>'narration',
      (v_entry->>'sort_order')::INT
    );
  END LOOP;

  -- ── Step 4: Insert Payment voucher ──────────────────────────────────────────
  INSERT INTO pramaana.vouchers (
    company_id,
    voucher_type_id,
    voucher_number,
    voucher_date,
    narration,
    entity_id,
    amount,
    payment_mode,
    bank_ledger_id,
    cheque_number,
    cheque_date,
    utr_number,
    cost_centre_id,
    ref_document_number,
    status,
    created_by
  ) VALUES (
    (p_payment->>'company_id')::UUID,
    (p_payment->>'voucher_type_id')::UUID,
     v_payment_num,
    (p_payment->>'voucher_date')::DATE,
     p_payment->>'narration',
    (p_payment->>'entity_id')::UUID,
     v_payment_amt,
     p_payment->>'payment_mode',
    (p_payment->>'bank_ledger_id')::UUID,
     p_payment->>'cheque_number',
    (p_payment->>'cheque_date')::DATE,
     p_payment->>'utr_number',
    (p_payment->>'cost_centre_id')::UUID,
     p_payment->>'ref_document_number',
    'pending_approval',
    (p_payment->>'created_by')::UUID
  )
  RETURNING id INTO v_payment_id;

  -- ── Step 5: Insert Payment entry rows ───────────────────────────────────────
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_payment_entries)
  LOOP
    INSERT INTO pramaana.voucher_entries (
      voucher_id,
      ledger_id,
      entry_type,
      amount,
      narration,
      sort_order
    ) VALUES (
      v_payment_id,
      (v_entry->>'ledger_id')::UUID,
       v_entry->>'entry_type',
      (v_entry->>'amount')::NUMERIC,
       v_entry->>'narration',
      (v_entry->>'sort_order')::INT
    );
  END LOOP;

  -- ── Step 6: Insert allocation row linking the two vouchers ───────────────────
  -- bill_voucher_id    = Purchase (the commercial obligation)
  -- payment_voucher_id = Payment  (the cash movement)
  -- is_advance = false: the Purchase and Payment are born simultaneously,
  --              so by definition this is not a retroactive advance allocation.
  INSERT INTO pramaana.voucher_allocations (
    company_id,
    entity_id,
    bill_voucher_id,
    payment_voucher_id,
    amount_allocated,
    is_advance,
    allocated_by
  ) VALUES (
    (p_purchase->>'company_id')::UUID,
    (p_purchase->>'entity_id')::UUID,
     v_purchase_id,
     v_payment_id,
     v_purchase_amt,
     false,
    (p_purchase->>'created_by')::UUID
  )
  RETURNING id INTO v_alloc_id;

  -- ── Return both IDs and voucher numbers to the client ───────────────────────
  RETURN jsonb_build_object(
    'purchase_id',     v_purchase_id,
    'purchase_number', v_purchase_num,
    'payment_id',      v_payment_id,
    'payment_number',  v_payment_num,
    'allocation_id',   v_alloc_id
  );

END;
$$;

-- ── Permissions ───────────────────────────────────────────────────────────────
-- anon intentionally excluded — voucher creation requires authentication.
GRANT EXECUTE ON FUNCTION pramaana.create_linked_vouchers(JSONB, JSONB, JSONB, JSONB)
  TO authenticated;

GRANT EXECUTE ON FUNCTION pramaana.create_linked_vouchers(JSONB, JSONB, JSONB, JSONB)
  TO service_role;

-- ── Verification query (run after deploying to confirm function exists) ───────
-- SELECT routine_name, routine_schema, security_type
-- FROM information_schema.routines
-- WHERE routine_schema = 'pramaana'
--   AND routine_name   = 'create_linked_vouchers';
