-- ════════════════════════════════════════════════════════════════
-- 071 — Fix registry.next_fy_sequence: use voucher_date for FY
--
-- Root cause: the function derived the financial year from
-- CURRENT_DATE, so a voucher dated in March posted in April would
-- land in the new FY sequence instead of the old one.
--
-- Fix: add p_voucher_date DATE (default CURRENT_DATE for backward
-- compatibility).  All callers that know the voucher date should
-- pass it explicitly; unpatched callers fall back to today.
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION registry.next_fy_sequence(
    p_company_id   UUID,
    p_company_code TEXT,
    p_prefix       TEXT,
    p_voucher_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, public
AS $$
DECLARE
    v_fy_year   INT;
    v_fy_text   TEXT;
    v_seq       INT;
BEGIN
    -- Indian FY: April 1 start.  Apr 2026–Mar 2027 → year code '2627'.
    v_fy_year := CASE
        WHEN EXTRACT(MONTH FROM p_voucher_date) >= 4
            THEN EXTRACT(YEAR FROM p_voucher_date)::INT
        ELSE EXTRACT(YEAR FROM p_voucher_date)::INT - 1
    END;

    v_fy_text := LPAD((v_fy_year       % 100)::TEXT, 2, '0')
              || LPAD(((v_fy_year + 1) % 100)::TEXT, 2, '0');

    INSERT INTO registry.sequence_counters (id, company_id, prefix, year, last_number)
    VALUES (gen_random_uuid(), p_company_id, p_prefix, v_fy_text, 1)
    ON CONFLICT (company_id, prefix, year)
    DO UPDATE SET last_number = registry.sequence_counters.last_number + 1
    RETURNING last_number INTO v_seq;

    RETURN p_company_code
        || '/' || p_prefix
        || '/' || v_fy_text
        || '/' || LPAD(v_seq::TEXT, 4, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION registry.next_fy_sequence(UUID, TEXT, TEXT, DATE)
    TO authenticated, service_role;
