# Pramaana — System Definition
**Generated:** 2026-06-19  
**Last Updated:** 2026-07-03 (migrations 035–044: Pay Now, bill allocations, linked vouchers, awaiting_payment status, posted immutability triggers; `src/lib/pay-now.ts`, `src/lib/allocations.ts`; `/payments` route; reports filter fix)  
**Scope:** `pramaana/` repo only — `src/`, `api/`, `supabase/migrations/`, `supabase/functions/`  
**Method:** Direct code inspection of all lib files, page components, migrations, App.tsx, AuthContext.tsx, and config files  
**Not covered:** Relish Suite (`relish-business-suite/` parent repo), ClamFlow backend/frontend (separate repos)

---

## 1. Database Schema

### 1.1 Supabase Project Connected

| Client variable | Project ID | Access mode |
|---|---|---|
| `supabase` (primary) | `mmkbknnzgpvsqgnynrbe` | READ + WRITE |
| `supabaseClamFlow` | `idwgenbkguejgwtzbicu` | **READ ONLY** — never INSERT/UPDATE/DELETE |

All queries on `supabase` use `.schema('pramaana')` or `.schema('registry')` — never bare `.from(...)`. `supabaseClamFlow` reads ClamFlow's public-schema tables directly (no schema prefix needed).

---

### 1.2 Tables in `pramaana` schema

Source of truth: `supabase/migrations/008_pramaana_schema.sql`, `009_ledger_bank_fields.sql`, `020_voucher_attachments.sql`, `021_suspense_schema_extension.sql`.

---

#### `pramaana.ledger_groups`
**Pramaana READS + WRITES. System groups (`company_id IS NULL`) are seeded at migration time with fixed UUIDs and must never be modified.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | YES | — | FK → registry.companies(id). NULL = system group shared across all companies |
| code | TEXT | NOT NULL | — | UNIQUE per scope (partial index) |
| name | TEXT | NOT NULL | — | |
| parent_id | UUID | YES | — | FK → pramaana.ledger_groups(id) |
| nature | TEXT | NOT NULL | — | CHECK IN ('ASSET','LIABILITY','INCOME','EXPENSE') |
| is_system | BOOLEAN | YES | FALSE | System groups = TRUE. Never delete. |
| sort_order | INT | YES | 0 | |
| is_active | BOOLEAN | YES | TRUE | |
| is_pending_review | BOOLEAN | NOT NULL | FALSE | Added migration 042. TRUE when created by `accounts` role — admin must approve before it is considered permanent. |
| created_at | TIMESTAMPTZ | YES | now() | |
| updated_at | TIMESTAMPTZ | YES | now() | Updated by trigger `trg_updated_at` |

**UNIQUE (partial):**
- `idx_lgr_groups_sys_code ON (code) WHERE company_id IS NULL`
- `idx_lgr_groups_co_code ON (company_id, code) WHERE company_id IS NOT NULL`

**RLS policy `lgr_groups_access`:**
```sql
FOR ALL USING (
  company_id IS NULL
  OR registry.has_company_access(company_id)
)
WITH CHECK (
  (company_id IS NULL AND registry.is_super_admin())
  OR (company_id IS NOT NULL AND registry.has_company_access(company_id))
);
```

**Seeded system groups (25 rows, fixed UUIDs, company_id = NULL):**

| UUID suffix | Code | Name | Nature | Parent |
|---|---|---|---|---|
| ...0001 | ASSETS | Assets | ASSET | NULL |
| ...0002 | LIABILITIES | Liabilities | LIABILITY | NULL |
| ...0003 | INCOME | Income | INCOME | NULL |
| ...0004 | EXPENDITURE | Expenditure | EXPENSE | NULL |
| ...0011 | FIXED_ASSETS | Fixed Assets | ASSET | ...0001 |
| ...0012 | CURR_ASSETS | Current Assets | ASSET | ...0001 |
| ...0013 | INVESTMENTS | Investments | ASSET | ...0001 |
| ...0014 | CASH_IN_HAND | Cash in Hand | ASSET | ...0012 |
| ...0015 | BANK_ACCTS | Bank Accounts | ASSET | ...0012 |
| ...0016 | SUNDRY_DEB | Sundry Debtors | ASSET | ...0012 |
| ...0017 | LOANS_GIVEN | Loans & Advances (Given) | ASSET | ...0012 |
| ...0018 | STOCK_HAND | Stock in Hand | ASSET | ...0012 |
| ...0021 | CAPITAL | Capital Account | LIABILITY | ...0002 |
| ...0022 | RESERVES | Reserves & Surplus | LIABILITY | ...0002 |
| ...0023 | CURR_LIAB | Current Liabilities | LIABILITY | ...0002 |
| ...0024 | SUNDRY_CRED | Sundry Creditors | LIABILITY | ...0023 |
| ...0025 | DUTIES_TAXES | Duties & Taxes | LIABILITY | ...0023 |
| ...0026 | PROVISIONS | Provisions | LIABILITY | ...0023 |
| ...0027 | LOANS_LIAB | Loans (Liability) | LIABILITY | ...0002 |
| ...0028 | SUSPENSE_GRP | Suspense Account | LIABILITY | ...0002 |
| ...0031 | SALES_ACCTS | Sales Accounts | INCOME | ...0003 |
| ...0032 | OTHER_INCOME | Other Income | INCOME | ...0003 |
| ...0041 | PURCH_ACCTS | Purchase Accounts | EXPENSE | ...0004 |
| ...0042 | DIRECT_EXP | Direct Expenses | EXPENSE | ...0004 |
| ...0043 | INDIRECT_EXP | Indirect Expenses | EXPENSE | ...0004 |

---

#### `pramaana.ledgers`
**Pramaana READS + WRITES (full CRUD). Always company-scoped.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| group_id | UUID | NOT NULL | — | FK → pramaana.ledger_groups(id) |
| code | TEXT | YES | — | Optional short code |
| name | TEXT | NOT NULL | — | UNIQUE per company |
| entity_id | UUID | YES | — | Soft ref to registry.entities — NO DB FK (cross-schema) |
| opening_balance | NUMERIC(15,2) | YES | 0 | |
| opening_dr_cr | TEXT | YES | 'Dr' | CHECK IN ('Dr','Cr') |
| tally_ledger_name | TEXT | YES | — | Must match Tally Prime exactly. Required for Tally export. |
| gstin | TEXT | YES | — | |
| is_tds_applicable | BOOLEAN | YES | FALSE | |
| tds_rate | NUMERIC(5,2) | YES | — | |
| is_bank_account | BOOLEAN | YES | FALSE | Added migration 009 |
| bank_name | TEXT | YES | — | Added migration 009 |
| account_number | TEXT | YES | — | Added migration 009 |
| ifsc | TEXT | YES | — | Added migration 009 |
| is_system | BOOLEAN | YES | FALSE | |
| is_active | BOOLEAN | YES | TRUE | |
| is_pending_review | BOOLEAN | NOT NULL | FALSE | Added migration 042. TRUE when created by `accounts` role — admin must approve. |
| created_by | UUID | YES | — | FK → auth.users(id) |
| created_at | TIMESTAMPTZ | YES | now() | |
| updated_at | TIMESTAMPTZ | YES | now() | Updated by trigger `trg_updated_at` |

**UNIQUE:** `(company_id, name)`

**RLS policy `company_isolation`:**
```sql
FOR ALL USING (registry.has_company_access(company_id))
WITH CHECK (registry.has_company_access(company_id));
```

---

#### `pramaana.cost_centres`
**Pramaana READS + WRITES. CalciWorks Division seeded under RHHF.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| parent_id | UUID | YES | — | FK → pramaana.cost_centres(id) |
| code | TEXT | NOT NULL | — | UNIQUE per company |
| name | TEXT | NOT NULL | — | |
| description | TEXT | YES | — | |
| is_system | BOOLEAN | YES | FALSE | |
| is_active | BOOLEAN | YES | TRUE | |
| created_at | TIMESTAMPTZ | YES | now() | |
| updated_at | TIMESTAMPTZ | YES | now() | Updated by trigger `trg_updated_at` |

**UNIQUE:** `(company_id, code)`

**Seeded:** `CW_DIV` / 'CalciWorks Division' under RHHF (`is_system = TRUE`). Inserted via:
```sql
INSERT INTO pramaana.cost_centres (company_id, code, name, description, is_system)
SELECT id, 'CW_DIV', 'CalciWorks Division',
  'Shell calcination and lime products division (RHHF). Not a separate legal entity.',
  TRUE
FROM registry.companies WHERE code = 'RHHF'
ON CONFLICT (company_id, code) DO NOTHING;
```

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.voucher_types`
**Pramaana READS (SELECT only for `authenticated`). New types added via SQL migration only — not via app.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| code | TEXT | NOT NULL | — | UNIQUE |
| name | TEXT | NOT NULL | — | |
| prefix | TEXT | NOT NULL | — | Used in sequence: `RHHF/PYMT/2526/0001` |
| nature | TEXT | NOT NULL | — | CHECK IN ('payment','receipt','journal','contra','purchase','sales') |
| affects_bank | BOOLEAN | YES | FALSE | TRUE for payment/receipt/contra |
| is_system | BOOLEAN | YES | TRUE | |
| is_active | BOOLEAN | YES | TRUE | |

**Seeded (6 rows):**

| Code | Name | Prefix | Nature | affects_bank |
|---|---|---|---|---|
| PYMT | Payment | PYMT | payment | TRUE |
| RCPT | Receipt | RCPT | receipt | TRUE |
| JNL | Journal | JNL | journal | FALSE |
| CNTR | Contra | CNTR | contra | TRUE |
| PURCH | Purchase | PURCH | purchase | FALSE |
| SALE | Sales | SALE | sales | FALSE |

**RLS policies:**
```sql
CREATE POLICY vtype_read ON pramaana.voucher_types
  FOR SELECT USING (TRUE);
CREATE POLICY vtype_write ON pramaana.voucher_types
  FOR ALL USING (registry.is_super_admin())
  WITH CHECK (registry.is_super_admin());
```

---

#### `pramaana.approval_rules`
**Pramaana READS. Not written to from the app (no UI for managing rules).**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| voucher_type_id | UUID | YES | — | FK → pramaana.voucher_types(id). NULL = all types |
| min_amount | NUMERIC(15,2) | NOT NULL | 0 | |
| max_amount | NUMERIC(15,2) | YES | — | NULL = no upper limit |
| required_role | TEXT | NOT NULL | — | CHECK IN ('admin','accounts','super_admin') |
| sequence_order | INT | YES | 1 | For multi-level approval |
| is_active | BOOLEAN | YES | TRUE | |
| created_at | TIMESTAMPTZ | YES | now() | |

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.approval_actions`
**Pramaana READS + WRITES (INSERT per approval decision). Append-only audit trail — no UPDATEs in app code.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| voucher_id | UUID | NOT NULL | — | FK → pramaana.vouchers(id) ON DELETE CASCADE |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| rule_id | UUID | YES | — | FK → pramaana.approval_rules(id) |
| action | TEXT | NOT NULL | — | CHECK IN ('submitted','approved','rejected','escalated','recalled') |
| actioned_by | UUID | NOT NULL | — | FK → auth.users(id) |
| comments | TEXT | YES | — | |
| actioned_at | TIMESTAMPTZ | YES | now() | |

**Note:** FK `fk_approval_actions_voucher` was added AFTER `pramaana.vouchers` was created (deferred `ALTER TABLE` in the same migration).

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.vouchers`
**Core accounting document. Pramaana READS + WRITES. Posted/cancelled rows are immutable (enforced by DB trigger).**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| voucher_type_id | UUID | NOT NULL | — | FK → pramaana.voucher_types(id) |
| voucher_number | TEXT | NOT NULL | — | UNIQUE per company. From `registry.next_fy_sequence()` |
| voucher_date | DATE | NOT NULL | — | |
| narration | TEXT | YES | — | |
| entity_id | UUID | YES | — | Soft ref to registry.entities — NO DB FK |
| amount | NUMERIC(15,2) | NOT NULL | 0 | Denormalised from voucher_entries Dr side |
| payment_mode | TEXT | YES | — | CHECK IN ('cash','bank','upi','cheque','neft','rtgs','imps',NULL) |
| bank_ledger_id | UUID | YES | — | Soft ref to pramaana.ledgers |
| cheque_number | TEXT | YES | — | |
| cheque_date | DATE | YES | — | |
| utr_number | TEXT | YES | — | UTR / transaction ref |
| cost_centre_id | UUID | YES | — | FK → pramaana.cost_centres(id) |
| ref_document_number | TEXT | YES | — | PO number, invoice number cross-ref |
| ref_document_type | TEXT | YES | — | 'purchase_order','invoice','gst_invoice' |
| needs_approval | BOOLEAN | YES | FALSE | |
| status | TEXT | NOT NULL | 'draft' | CHECK IN ('draft','pending_approval','approved','completed','awaiting_payment','posted','cancelled','open','rejected','partial','closed') — expanded by migrations 025, 039 |
| is_suspense | BOOLEAN | NOT NULL | FALSE | Added migration 021 |
| suspense_purpose | TEXT | YES | — | Added migration 021 |
| suspense_balance | NUMERIC(15,2) | YES | 0 | Added migration 021 |
| posted_at | TIMESTAMPTZ | YES | — | |
| posted_by | UUID | YES | — | FK → auth.users(id) |
| cancelled_at | TIMESTAMPTZ | YES | — | |
| cancelled_by | UUID | YES | — | FK → auth.users(id) |
| cancellation_reason | TEXT | YES | — | |
| created_by | UUID | YES | — | FK → auth.users(id) |
| created_at | TIMESTAMPTZ | YES | now() | |
| updated_at | TIMESTAMPTZ | YES | now() | Updated by trigger `trg_updated_at` |
| ocr_confidence | NUMERIC(5,2) | YES | — | Added migration 033. Average GPT-4o confidence (0–100) when `source='ocr'`. NULL for manual vouchers. |
| source | TEXT | YES | 'manual' | Added migration 033. CHECK IN ('manual','ocr'). Index `idx_vouchers_source` on OCR rows. |
| otp_verified_at | TIMESTAMPTZ | YES | — | Written by `verifyPaymentOtp()` when OTP confirmed. Column existence not in tracked migrations — verify in live DB. |
| otp_verified_by | UUID | YES | — | FK → auth.users(id). Written by `verifyPaymentOtp()`. |
| completed_at | TIMESTAMPTZ | YES | — | Written by `verifyPaymentOtp()` when voucher reaches `completed`. |
| completed_by | UUID | YES | — | FK → auth.users(id). Written by `verifyPaymentOtp()`. |
| queued_at | TIMESTAMPTZ | YES | — | Added migration 039. Timestamp when voucher was queued for payment (`completed → awaiting_payment`). |
| queued_for_payment_by | UUID | YES | — | Added migration 039. FK → auth.users(id). User who queued the voucher. |
| paid_from_account | TEXT | YES | — | Added migration 036. Company bank/UPI account used for payment (from `registry.company_bank_accounts.label`). |
| paid_at | TIMESTAMPTZ | YES | — | Added migration 025 (IF NOT EXISTS). Date payment was recorded. |
| paid_by | UUID | YES | — | FK → auth.users(id). Written by `markVoucherPaid()`. Audit trail for who recorded the payment. |

**UNIQUE:** `(company_id, voucher_number)`

**RLS policy `company_isolation`:**
```sql
FOR ALL USING (registry.has_company_access(company_id))
WITH CHECK (registry.has_company_access(company_id));
```

**Anon policies (added by migration 021):**
```sql
CREATE POLICY "anon_read_suspense_vouchers"
  ON pramaana.vouchers FOR SELECT TO anon
  USING (is_suspense = true);
```

**Triggers on this table (5):**
- `trg_updated_at` BEFORE UPDATE → `pramaana.set_updated_at()`
- `trg_audit_vouchers` AFTER INSERT OR UPDATE OR DELETE → `pramaana.fn_audit_voucher()`
- `trg_prevent_posted_edit` BEFORE UPDATE OR DELETE → `pramaana.fn_prevent_posted_edit()` — blocks UPDATE/DELETE when `OLD.status IN ('posted','cancelled')`
- `trg_prevent_posted_voucher_update` BEFORE UPDATE → `pramaana.prevent_posted_voucher_update()` — added migration 044; belt-and-suspenders for the UPDATE path only
- `trg_validate_voucher_balance` BEFORE UPDATE → `pramaana.fn_validate_voucher_balance()` — fires only on transition **to** `'posted'`

---

#### `pramaana.voucher_entries`
**Pramaana READS + WRITES. Double-entry lines. Replaced wholesale on voucher edit (DELETE all + re-INSERT).**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| voucher_id | UUID | NOT NULL | — | FK → pramaana.vouchers(id) ON DELETE CASCADE |
| ledger_id | UUID | NOT NULL | — | FK → pramaana.ledgers(id) |
| cost_centre_id | UUID | YES | — | FK → pramaana.cost_centres(id) |
| entry_type | TEXT | NOT NULL | — | CHECK IN ('Dr','Cr') |
| amount | NUMERIC(15,2) | NOT NULL | — | CHECK (amount > 0) |
| narration | TEXT | YES | — | |
| sort_order | INT | YES | 0 | |
| created_at | TIMESTAMPTZ | YES | now() | |

**RLS policy `via_voucher`:**
```sql
FOR ALL USING (
  voucher_id IN (
    SELECT id FROM pramaana.vouchers WHERE registry.has_company_access(company_id)
  )
)
WITH CHECK (
  voucher_id IN (
    SELECT id FROM pramaana.vouchers WHERE registry.has_company_access(company_id)
  )
);
```

---

#### `pramaana.voucher_line_items`
**Defined in schema. Not queried by any current app lib or page component.** Optional bill detail breakdown. Not used in Phase 2 workflow.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| voucher_id | UUID | FK → pramaana.vouchers(id) ON DELETE CASCADE |
| description | TEXT | NOT NULL |
| hsn_sac | TEXT | |
| quantity | NUMERIC(15,3) | |
| unit | TEXT | |
| rate | NUMERIC(15,4) | |
| amount | NUMERIC(15,2) | NOT NULL |
| gst_rate | NUMERIC(5,2) | DEFAULT 0 |
| sort_order | INT | DEFAULT 0 |
| created_at | TIMESTAMPTZ | |

**RLS policy `via_voucher`:** same pattern as `pramaana.voucher_entries`.

---

#### `pramaana.suspense_settlements`
**Pramaana READS + WRITES. Also INSERT-accessible to `anon` role under guard condition.**

Original schema (migration 008) had status CHECK IN ('open','partial','cleared'). Migration 021 added columns. The app code uses status values 'pending', 'approved', 'rejected' — see Known Gaps (Section 6).

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| entity_id | UUID | YES | — | Soft ref to registry.entities |
| advance_voucher_id | UUID | NOT NULL | — | FK → pramaana.vouchers(id) |
| settlement_voucher_id | UUID | YES | — | FK → pramaana.vouchers(id). NULL until settled |
| advance_amount | NUMERIC(15,2) | NOT NULL | — | |
| settled_amount | NUMERIC(15,2) | YES | 0 | |
| status | TEXT | NOT NULL | 'open' | CHECK IN ('open','partial','cleared') — see Known Gap §6 |
| entry_type | TEXT | NOT NULL | 'expense' | Added migration 021. Values in code: 'expense'|'refund'|'topup' |
| description | TEXT | YES | — | Added migration 021 |
| head_of_account | TEXT | YES | — | Added migration 021 |
| reference_number | TEXT | YES | — | Added migration 021 |
| invoice_available | BOOLEAN | YES | — | Added migration 021 |
| settlement_session_id | UUID | YES | — | FK → pramaana.settlement_sessions(id). Added at end of migration 008. |
| submitted_by | UUID | YES | — | Added migration 035. Auth user who entered the settlement directly inside the register. NULL when staff submitted via public link (anon). |
| settled_at | TIMESTAMPTZ | YES | — | |
| settled_by | UUID | YES | — | FK → auth.users(id) |
| notes | TEXT | YES | — | |
| created_at | TIMESTAMPTZ | YES | now() | |
| updated_at | TIMESTAMPTZ | YES | now() | Updated by trigger `trg_updated_at` |

**RLS policy `company_isolation` (authenticated):** same as `pramaana.ledgers`.

**Anon policies (added by migration 021):**
```sql
CREATE POLICY "anon_read_suspense_settlements"
  ON pramaana.suspense_settlements FOR SELECT TO anon
  USING (true);

CREATE POLICY "anon_insert_suspense_settlements"
  ON pramaana.suspense_settlements FOR INSERT TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM pramaana.settlement_sessions ss
      WHERE ss.advance_voucher_id = suspense_settlements.advance_voucher_id
        AND ss.status            != 'completed'
        AND (ss.expires_at IS NULL OR ss.expires_at > NOW())
    )
  );
```

---

#### `pramaana.voucher_attachments`
**Defined in both migration 008 and migration 020. Migration 020 supersedes — it dropped and recreated the table with the correct schema. The app code in `attachments.ts` uses the migration 020 column set.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| voucher_id | UUID | NOT NULL | — | FK → pramaana.vouchers(id) ON DELETE CASCADE |
| company_id | UUID | NOT NULL | — | |
| file_name | TEXT | NOT NULL | — | |
| file_size | INTEGER | YES | — | |
| mime_type | TEXT | YES | — | |
| storage_path | TEXT | NOT NULL | — | UNIQUE. Path in `voucher-attachments` Storage bucket |
| uploaded_by | UUID | NOT NULL | — | |
| uploaded_at | TIMESTAMPTZ | NOT NULL | now() | |
| is_deleted | BOOLEAN | NOT NULL | FALSE | Soft delete only |
| attachment_type | TEXT | NOT NULL | 'invoice' | Added migration 038. CHECK IN ('invoice','transfer_receipt','other'). Distinguishes invoice/bill from bank transfer receipt. |

**RLS policies (from migration 020):**
```sql
CREATE POLICY "company members can view attachments"
  ON pramaana.voucher_attachments FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "accounts and admin can insert attachments"
  ON pramaana.voucher_attachments FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );

CREATE POLICY "owner or admin can soft-delete attachments"
  ON pramaana.voucher_attachments FOR UPDATE TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR company_id IN (
      SELECT company_id FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );
```

---

#### `pramaana.voucher_allocations`
**Created by migration 040. Bill-allocation engine — links payment/receipt vouchers to the specific purchase/sales bills they settle. BI layer only — does not change accounting entries.**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) ON DELETE CASCADE |
| entity_id | UUID | YES | — | FK → registry.entities(id) ON DELETE SET NULL |
| bill_voucher_id | UUID | NOT NULL | — | FK → pramaana.vouchers(id) ON DELETE CASCADE. Purchase or Sales voucher being settled. |
| payment_voucher_id | UUID | NOT NULL | — | FK → pramaana.vouchers(id) ON DELETE CASCADE. Payment or Receipt voucher doing the settling. |
| amount_allocated | NUMERIC(15,2) | NOT NULL | — | CHECK (amount_allocated > 0) |
| is_advance | BOOLEAN | NOT NULL | FALSE | TRUE when payment preceded the bill (retroactive allocation). |
| allocated_at | TIMESTAMPTZ | NOT NULL | now() | |
| allocated_by | UUID | YES | — | FK → auth.users(id) ON DELETE SET NULL |

**CONSTRAINT:** `no_self_link CHECK (bill_voucher_id != payment_voucher_id)`

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

**Invariant:** `SUM(outstanding per entity) = entity ledger balance`. Not enforced at DB level — maintained by application code.

---

#### `pramaana.company_payment_accounts`
**Created by migration 036 (simple version). SUPERSEDED in application code by `registry.company_bank_accounts` which carries full banking detail. Migration 036 table is no longer queried by any app lib function.**

| Column | Type | Notes |
|---|---|
| id | UUID | PK |
| company_id | UUID | FK → registry.companies(id) ON DELETE CASCADE |
| label | TEXT | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

---

#### `pramaana.capture_sessions`
**Defined in schema. Not queried by any current app lib or page component.** Bill capture workflow (Phase 2 relay feature is in RelayCapture.tsx, but it writes directly to Storage via signed URL — it does not use this table).

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| company_id | UUID | FK → registry.companies(id) |
| created_by | UUID | FK → auth.users(id) NOT NULL |
| device_info | TEXT | |
| images | JSONB | DEFAULT '[]' |
| raw_ocr_data | JSONB | |
| suggested_vendor | TEXT | |
| suggested_amount | NUMERIC(15,2) | |
| linked_voucher_id | UUID | FK → pramaana.vouchers(id) |
| status | TEXT | CHECK IN ('open','submitted','expired','cancelled') |
| expires_at | TIMESTAMPTZ | DEFAULT now() + INTERVAL '24 hours' |
| submitted_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.notifications`
**Defined in schema. Not queried by any current app lib or page component.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| recipient_id | UUID | FK → auth.users(id) ON DELETE CASCADE NOT NULL |
| company_id | UUID | FK → registry.companies(id) |
| type | TEXT | CHECK IN ('approval_required','approved','rejected','posted','reminder','comment','system') |
| title | TEXT | NOT NULL |
| message | TEXT | |
| voucher_id | UUID | Soft ref to pramaana.vouchers |
| action_url | TEXT | |
| read_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**RLS policy `own_notifications`:**
```sql
FOR ALL USING (recipient_id = auth.uid() OR registry.is_super_admin())
WITH CHECK (recipient_id = auth.uid() OR registry.is_super_admin());
```

---

#### `pramaana.push_subscriptions`
**Defined in schema. Not queried by any current app lib or page component.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| user_id | UUID | FK → auth.users(id) ON DELETE CASCADE |
| endpoint | TEXT | NOT NULL |
| p256dh | TEXT | NOT NULL. Client public key |
| auth_key | TEXT | NOT NULL. Auth secret |
| user_agent | TEXT | |
| created_at | TIMESTAMPTZ | |

**UNIQUE:** `(user_id, endpoint)`

**RLS policy `own_push`:**
```sql
FOR ALL USING (user_id = auth.uid() OR registry.is_super_admin())
WITH CHECK (user_id = auth.uid() OR registry.is_super_admin());
```

---

#### `pramaana.otp_sessions`
**Defined in schema. Not queried by any current app lib or page component.** OTP hash storage only — plain OTP is never stored.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| voucher_id | UUID | FK → pramaana.vouchers(id) ON DELETE CASCADE |
| company_id | UUID | FK → registry.companies(id) NOT NULL |
| initiated_by | UUID | FK → auth.users(id) NOT NULL |
| mobile | TEXT | NOT NULL. Number OTP was sent to |
| otp_hash | TEXT | NOT NULL. bcrypt hash. Plain OTP never stored. |
| expires_at | TIMESTAMPTZ | NOT NULL |
| verified_at | TIMESTAMPTZ | |
| status | TEXT | CHECK IN ('pending','verified','expired','cancelled') |
| created_at | TIMESTAMPTZ | |

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.settlement_sessions`
**Pramaana READS + WRITES. `anon` can SELECT all rows (token-based security).**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| id | UUID | NOT NULL | gen_random_uuid() | PK |
| company_id | UUID | NOT NULL | — | FK → registry.companies(id) |
| entity_id | UUID | YES | — | Soft ref to registry.entities |
| initiated_by | UUID | NOT NULL | — | FK → auth.users(id) |
| total_advance_amount | NUMERIC(15,2) | NOT NULL | 0 | |
| total_settled_amount | NUMERIC(15,2) | NOT NULL | 0 | |
| status | TEXT | NOT NULL | 'draft' | CHECK IN ('draft','in_progress','completed','cancelled'). Code uses 'open' — see Known Gaps §6. |
| token | UUID | NOT NULL | gen_random_uuid() | Added migration 021. UNIQUE index. The URL credential. |
| expires_at | TIMESTAMPTZ | YES | — | Added migration 021. NULL = no expiry |
| advance_voucher_id | UUID | YES | — | Added migration 021. FK → pramaana.vouchers(id) ON DELETE SET NULL |
| completed_at | TIMESTAMPTZ | YES | — | |
| completed_by | UUID | YES | — | FK → auth.users(id) |
| notes | TEXT | YES | — | |
| created_at | TIMESTAMPTZ | YES | now() | |
| updated_at | TIMESTAMPTZ | YES | now() | Updated by trigger `trg_updated_at` |

**UNIQUE index (migration 021):** `idx_settlement_sessions_token ON (token)`

**RLS policy `company_isolation` (authenticated):** same as `pramaana.ledgers`.

**Anon policy (migration 021):**
```sql
CREATE POLICY "anon_read_settlement_sessions"
  ON pramaana.settlement_sessions FOR SELECT TO anon
  USING (true);
```

---

#### `pramaana.gst_details`
**Defined in schema. Not queried by any current app lib or page component.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| voucher_id | UUID | FK → pramaana.vouchers(id) ON DELETE CASCADE NOT NULL |
| company_id | UUID | FK → registry.companies(id) NOT NULL |
| line_item_id | UUID | FK → pramaana.voucher_line_items(id) |
| gstin_party | TEXT | |
| place_of_supply | TEXT | |
| supply_type | TEXT | CHECK IN ('intra','inter') |
| hsn_sac | TEXT | |
| taxable_amount | NUMERIC(15,2) | NOT NULL |
| cgst_rate / cgst_amount | NUMERIC | DEFAULT 0 |
| sgst_rate / sgst_amount | NUMERIC | DEFAULT 0 |
| igst_rate / igst_amount | NUMERIC | DEFAULT 0 |
| cess_rate / cess_amount | NUMERIC | DEFAULT 0 |
| created_at | TIMESTAMPTZ | |

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.period_locks`
**Defined in schema. Not queried by any current app lib or page component.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| company_id | UUID | FK → registry.companies(id) NOT NULL |
| fy_year | INT | NOT NULL. FY start year e.g. 2025 for FY 2025-26 |
| month | INT | CHECK BETWEEN 1 AND 12. NULL = entire FY locked |
| locked_at / unlocked_at | TIMESTAMPTZ | |
| locked_by / unlocked_by | UUID | FK → auth.users(id) |
| reason | TEXT | |

**UNIQUE:** `(company_id, fy_year, month)`

**RLS policy `company_isolation`:** same as `pramaana.ledgers`.

---

#### `pramaana.audit_log`
**Append-only. Written by `pramaana.fn_audit_voucher()` trigger only. No UPDATE or DELETE grant.**

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL | PK |
| company_id | UUID | |
| schema_name | TEXT | NOT NULL |
| table_name | TEXT | NOT NULL |
| record_id | UUID | |
| action | TEXT | CHECK IN ('INSERT','UPDATE','DELETE') |
| old_data | JSONB | |
| new_data | JSONB | |
| changed_fields | TEXT[] | |
| user_id | UUID | |
| user_email | TEXT | |
| app | TEXT | DEFAULT 'pramaana' |
| created_at | TIMESTAMPTZ | DEFAULT now() |

**RLS policies:**
```sql
CREATE POLICY audit_log_read ON pramaana.audit_log
  FOR SELECT USING (
    company_id IS NULL OR registry.has_company_access(company_id)
  );
CREATE POLICY audit_log_insert ON pramaana.audit_log
  FOR INSERT WITH CHECK (TRUE);  -- written by SECURITY DEFINER trigger only
```
**Grants:** `SELECT, INSERT` to `authenticated` only. No `UPDATE` or `DELETE` ever granted.

---

#### `pramaana.inventory_valuations`
**Pramaana READS + WRITES. Created by migration 030. Admin role only for writes.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| company_id | UUID | FK → registry.companies(id) |
| lot_id | TEXT | Cross-DB reference to ClamFlow `lots.id` — NO FK constraint (cross-DB) |
| rate_per_kg | NUMERIC(15,4) | Admin-set valuation rate |
| notes | TEXT | Optional |
| set_by | UUID | FK → auth.users(id) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | Updated by trigger |

**UNIQUE:** `(company_id, lot_id)` — UPSERT target.  
**RLS:** SELECT: any company member. INSERT/UPDATE/DELETE: `role='admin'` in `registry.company_users` only.

---

#### `pramaana.invoice_scans`
**Written by `supabase/functions/ocr` Supabase Edge Function. Created by migration not tracked in this repo's migrations folder (table exists in live DB). `our_gstin` column added by migration 034.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| company_id | UUID | FK → registry.companies(id) |
| scan_ref | TEXT | UNIQUE. Formatted scan identifier e.g. `RFPL/2627/PUR/20260625-0001` |
| type | TEXT | `'purchase'` or `'sale'` |
| invoice_no | TEXT | |
| invoice_date | DATE | |
| party_name | TEXT | Supplier (purchase) or recipient (sale) |
| party_gstin | TEXT | |
| our_gstin | TEXT | Company GSTIN at scan time. Added migration 034 (IF NOT EXISTS). |
| taxable_value | NUMERIC | |
| total_gst | NUMERIC | |
| cgst / sgst / igst | NUMERIC | |
| total_amount | NUMERIC | |
| gst_type | TEXT | `'intra'`, `'inter'`, `'unknown'` |
| raw_json | JSONB | Full `OcrResult` as returned by GPT-4o |
| confidence | NUMERIC | GPT-4o overall confidence (0.0–1.0) |
| storage_path | TEXT | Path in `bill-attachments` bucket |
| scanned_by | UUID | FK → auth.users(id) |
| created_at | TIMESTAMPTZ | |

**UNIQUE:** `scan_ref` — HTTP 409 returned on duplicate scan (prevents double-processing same invoice).

---

#### `pramaana.invoice_scan_items`
**Written by `supabase/functions/ocr`. Line items per scan. Created by same undocumented migration.**

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| scan_id | UUID | FK → pramaana.invoice_scans(id) |
| company_id | UUID | |
| line_no | INT | 1-based |
| description | TEXT | |
| hsn_sac | TEXT | |
| quantity | NUMERIC | |
| unit | TEXT | KG, NOS, etc. |
| unit_price | NUMERIC | |
| amount | NUMERIC | |

---

#### `pramaana.scan_sequence_counters`
**Created by migration 034 (PENDING — not yet applied to production). Used by `pramaana.next_scan_ref()` RPC.**

| Column | Type | Notes |
|---|---|---|
| company_id | UUID | NOT NULL. Part of PK. |
| type_code | TEXT | NOT NULL. CHECK IN ('PUR','SAL'). Part of PK. |
| fy | INT | NOT NULL. FY start year (e.g. 2026 for FY 26-27). Part of PK. |
| last_number | INT | NOT NULL DEFAULT 0. Atomically incremented. |

**PK:** `(company_id, type_code, fy)` — one counter row per company per scan type per FY.

---

### 1.3 Tables in `registry` schema read by Pramaana

Pramaana reads these registry tables. It does NOT write to them.

| Table | Columns read | Via |
|---|---|---|
| `registry.profiles` | `id, email, full_name, mobile, entity_id, is_super_admin, is_active, created_at` | `AuthContext.tsx`, `vouchers-list.ts`, `approvals.ts`, `suspense.ts`, `pay-now.ts` |
| `registry.companies` | `id, code, name, gstin, is_active` | `AuthContext.tsx` |
| `registry.company_users` | `id, user_id, company_id, role` | `AuthContext.tsx` |
| `registry.entities` | `id, display_name, mobile, upi_id, bank_account_number, bank_ifsc, bank_name` | `vouchers-list.ts`, `approvals.ts`, `suspense.ts`, `sms.ts`, `pay-now.ts` |
| `registry.sequence_counters` | via RPC only | `vouchers.ts` `getNextSequence()`, `suspense.ts` `approveSuspenseVoucher()`, `vouchers-list.ts` `submitDraftVoucher()` |
| `registry.company_bank_accounts` | `id, company_id, label, account_holder_name, bank_name, bank_account_number, bank_ifsc, upi_id, is_primary, is_active, created_at` | `pay-now.ts` `fetchCompanyPaymentAccounts()` — **READ + WRITE** (admin can add/delete accounts) |

---

### 1.4 Storage Bucket

| Bucket ID | Public | File size limit | Allowed MIME types |
|---|---|---|---|
| `voucher-attachments` | FALSE | 10 MB (10485760 bytes) | image/jpeg, image/png, image/webp, image/heic, image/heif, application/pdf |

Storage RLS policies (from migration 020):
```sql
-- Download: company members only
CREATE POLICY "company members can download attachments"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'voucher-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM registry.company_users WHERE user_id = auth.uid()
    )
  );

-- Upload: admin or accounts role only
CREATE POLICY "accounts and admin can upload attachments"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'voucher-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );

-- Delete: admin or accounts role only
CREATE POLICY "accounts and admin can delete attachments"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'voucher-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM registry.company_users
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'accounts', 'super_admin')
    )
  );
```

Storage path format: `{company_id}/{voucher_id}/{timestamp}_{random}.{ext}`  
Signed URLs: 1-hour expiry, batch-generated via `createSignedUrls()`.

---

### 1.5 RLS Helper Functions (defined in `registry` schema, used by Pramaana policies)

```sql
-- has_company_access: returns TRUE if current user is a member of p_company_id OR is super_admin
CREATE OR REPLACE FUNCTION registry.has_company_access(p_company_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM registry.company_users
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) OR EXISTS (
    SELECT 1 FROM registry.profiles
    WHERE id = auth.uid() AND is_super_admin = TRUE
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- is_super_admin: returns TRUE if current user has profiles.is_super_admin = TRUE
CREATE OR REPLACE FUNCTION registry.is_super_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM registry.profiles
    WHERE id = auth.uid() AND is_super_admin = TRUE
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
```

Both are `SECURITY DEFINER` to avoid RLS infinite recursion when querying `registry.profiles` inside an RLS policy expression.

---

### 1.6 Migrations Applied to Production

| File | Status | Notes |
|---|---|---|
| 008_pramaana_schema.sql | ✅ Applied | 19 tables, 4 trigger functions, 4 triggers, RLS on all tables, grants, ledger_groups seed (25 rows), voucher_types seed (6 rows), cost_centres seed (CW_DIV) |
| 008a_fix_prevent_posted_edit.sql | ✅ Applied | Patch: `fn_prevent_posted_edit` DELETE branch fix (RETURN NEW on DELETE is invalid — replaced with explicit `TG_OP = 'DELETE'` branch returning OLD) |
| 009_ledger_bank_fields.sql | ✅ Applied | ADD COLUMN IF NOT EXISTS: `is_bank_account`, `bank_name`, `account_number`, `ifsc` on `pramaana.ledgers` |
| 010_seed_test_ledgers.sql | ✅ Applied | Test ledgers for RHHF (SBI, Cash, Creditors, Expenses) |
| 020_voucher_attachments.sql | ✅ Applied | Recreates `pramaana.voucher_attachments` with correct schema (`storage_path`, `file_size`, `mime_type`, `is_deleted`), Storage bucket, storage RLS |
| 021_suspense_schema_extension.sql | ✅ Applied | Adds `is_suspense`, `suspense_purpose`, `suspense_balance` to vouchers; adds `token`, `expires_at`, `advance_voucher_id` to settlement_sessions; adds `entry_type`, `description`, `head_of_account`, `reference_number`, `invoice_available` to suspense_settlements; `anon` grants + RLS policies |
| 030_inventory_valuations.sql | ✅ Applied | New table `pramaana.inventory_valuations` — Admin/Super-Admin-set `rate_per_kg` for ClamFlow lots. RLS: any company member can SELECT; only `role='admin'` in `registry.company_users` can INSERT/UPDATE/DELETE. `lot_id` stored as `TEXT` (cross-DB ref, no FK to ClamFlow). `updated_at` trigger. |
| 025_fix_status_enums_and_payment_columns.sql | ✅ Applied | Fixes three status CHECK constraint mismatches between migration 008 and runtime code. (1) `pramaana.vouchers.status` expanded to include `'completed','open','rejected','partial','closed'`. (2) `pramaana.suspense_settlements.status` changed to `'pending','approved','rejected','open','partial','cleared'`. (3) `pramaana.settlement_sessions.status` adds `'open'` to existing values. All changes use DROP CONSTRAINT IF EXISTS + re-ADD — safe to run on existing DB. |
| 031_reset_rpc.sql | ✅ Applied | Creates `public.pramaana_reset_company_data(p_company_id UUID)` — SECURITY DEFINER function (super_admin only) that cascades-deletes all company-scoped accounting data while preserving registry rows, system groups, voucher_types, and system cost_centres. Also creates `pramaana.upsert_ledger_group()` and `pramaana.upsert_ledger()` import helpers for CSV/seed data. |
| 032_grant_pramaana_schema_to_postgrest_roles.sql | ✅ Applied | Grants `USAGE ON SCHEMA pramaana` to `anon`, `authenticated`, `service_role`. Grants `ALL ON ALL TABLES/SEQUENCES/ROUTINES IN SCHEMA pramaana` to `service_role`. Ensures Supabase Edge Functions using service_role key can access pramaana schema. Also grants `SELECT ON pramaana.settlement_sessions` to `authenticated`. |
| 033_ocr_confidence.sql | ✅ Applied | Adds `ocr_confidence NUMERIC(5,2)` and `source TEXT DEFAULT 'manual' CHECK IN ('manual','ocr')` to `pramaana.vouchers`. Back-fills existing rows with `source='manual'`. Creates index `idx_vouchers_source WHERE source='ocr'`. |
| 034_scan_ref_sequence.sql | ⏳ **PENDING — not yet applied to production** | Creates `pramaana.scan_sequence_counters` table (PK: company_id + type_code + fy) and `pramaana.next_scan_ref(p_company_id, p_company_code, p_type, p_scan_date)` RPC. Atomically increments counter and returns formatted ref like `RFPL/2627/PUR/20260625-0001`. Also adds `our_gstin TEXT` to `pramaana.invoice_scans` (IF NOT EXISTS). |
| 035_suspense_submitted_by.sql | ✅ Applied | Adds `submitted_by UUID` (nullable) to `pramaana.suspense_settlements`. NULL = submitted via public anon link. UUID = accounts/admin user who entered directly in the register. |
| 036_pay_now.sql | ✅ Applied | Adds `paid_from_account TEXT` and `paid_at TIMESTAMPTZ` (IF NOT EXISTS) to `pramaana.vouchers`. Creates `pramaana.company_payment_accounts` (simple label table — superseded in app code by `registry.company_bank_accounts`). |
| 037_profile_mobile.sql | ✅ Applied | Adds `mobile TEXT` and `entity_id UUID` columns to `registry.profiles`. Back-fills `mobile` from `public.profiles.phone` for existing users. |
| 038_attachment_type.sql | ✅ Applied | Adds `attachment_type TEXT NOT NULL DEFAULT 'invoice' CHECK IN ('invoice','transfer_receipt','other')` to `pramaana.voucher_attachments`. |
| 039_awaiting_payment_status.sql | ✅ Applied | Adds `'awaiting_payment'` to the `pramaana.vouchers.status` CHECK constraint. Adds `queued_at TIMESTAMPTZ` and `queued_for_payment_by UUID` columns (IF NOT EXISTS) for queue audit trail. NOTE: The CHECK constraint was applied manually on 2026-06-30 before this migration was run. |
| 040_bill_allocations.sql | ✅ Applied | Creates `pramaana.voucher_allocations` table. Bill-allocation BI layer — links payment/receipt vouchers to purchase/sales bills. `no_self_link` constraint prevents linking a bill to itself. |
| 041_create_linked_vouchers.sql | ✅ Applied | Creates `pramaana.create_linked_vouchers(p_purchase JSONB, p_purchase_entries JSONB, p_payment JSONB, p_payment_entries JSONB)` RPC. Atomically creates a Purchase + Payment voucher pair (both `pending_approval`) plus a `voucher_allocation` row in a single transaction. Balance-checks both entry sets server-side. Entity ID mismatch guard. |
| 042_ledger_pending_review.sql | ✅ Applied | Adds `is_pending_review BOOLEAN NOT NULL DEFAULT FALSE` to both `pramaana.ledger_groups` and `pramaana.ledgers`. Allows accounts-role users to propose new ledgers; admin approves by setting this to false. |
| 044_posted_voucher_immutability.sql | ✅ Applied | Adds two trigger functions: `pramaana.prevent_posted_voucher_update()` (BEFORE UPDATE on vouchers, blocks when OLD.status='posted') and `pramaana.prevent_posted_entry_mutation()` (BEFORE INSERT/UPDATE/DELETE on voucher_entries, blocks when parent voucher is 'posted'). Belt-and-suspenders alongside existing `fn_prevent_posted_edit`. |
| 20260625000000_invoice_scan_module.sql | ✅ Applied | Invoice scan schema (`pramaana.invoice_scans`, `pramaana.invoice_scan_items` — written by the Supabase Edge Function `ocr`). |

---

## 2. API / Data Access Layer

### `src/lib/supabase.ts`
- Exports: `supabase` (Supabase JS client)
- No DB queries — client initialisation only
- Reads: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Throws `Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')` if either is absent

---

### `src/lib/supabaseClamFlow.ts`
- Exports: `supabaseClamFlow` (ClamFlow Supabase JS client — **READ ONLY**)
- Reads: `VITE_CLAMFLOW_SUPABASE_URL`, `VITE_CLAMFLOW_SUPABASE_ANON_KEY`
- Throws if either env var is absent
- **Never call INSERT, UPDATE, or DELETE on this client. ClamFlow data is owned by the ClamFlow application.**

---

### `src/lib/inventory.ts`

| Function | Signature | Source | Operation |
|---|---|---|---|
| `fetchClamLots` | `() → ClamLot[]` | ClamFlow `lots` | SELECT all known columns, order `arrival_date DESC`, limit 500. **READ ONLY.** |
| `fetchClamFPForms` | `() → ClamFPForm[]` | ClamFlow `fp_forms` | SELECT all known columns, order `created_at DESC`, limit 500. **READ ONLY.** |
| `fetchInventoryValuations` | `(companyId) → InventoryValuation[]` | `pramaana.inventory_valuations` | SELECT `*` WHERE `company_id=` |
| `upsertInventoryValuation` | `(companyId, lotId, ratePerKg, notes, userId) → void` | `pramaana.inventory_valuations` | UPSERT on `(company_id, lot_id)`. **Admin/Super-Admin only — enforced by RLS.** |

**ClamFlow tables confirmed accessible (all empty — ClamFlow not yet in production as of 2026-06-19):**

| Table | Confirmed columns |
|---|---|
| `lots` | id, lot_number, species, weight_kg, arrival_date, status, supplier_id, notes, created_at, updated_at |
| `fp_forms` | id, lot_id, status, created_at, updated_at |
| `suppliers` | id, address, created_at |
| `person_records` | id, full_name, status, address, designation, created_at, updated_at |
| `shift_definitions` | id, name, start_time, end_time, color, shift_type, is_active, created_by, created_at, updated_at |

---

### `src/lib/vouchers.ts`

| Function | Signature | Tables | Operation |
|---|---|---|---|
| `fetchVoucherTypes` | `() → VoucherType[]` | pramaana.voucher_types | SELECT `is_active=true`, order `name` |
| `fetchCostCentres` | `(companyId) → {id,name,code}[]` | pramaana.cost_centres | SELECT `company_id=`, `is_active=true`, order `name` |
| `fetchBankLedgers` | `(companyId) → {id,name,bank_name,account_number}[]` | pramaana.ledgers | SELECT WHERE `company_id=`, `is_bank_account=true`, `is_active=true` |
| `fetchPaymentAccounts` | `(companyId) → PaymentAccount[]` | pramaana.ledgers | SELECT WHERE `is_bank_account=true` OR `name ILIKE '%cash%'` |
| `searchLedgers` | `(companyId, query) → {id,name,group}[]` | pramaana.ledgers (with nested pramaana.ledger_groups) | SELECT ILIKE `%query%`, LIMIT 12 |
| `getNextSequence` | `(companyId, companyCode, prefix) → string` | registry.sequence_counters (via RPC) | RPC `registry.next_fy_sequence` |
| `saveDraftVoucher` | `(payload, entries) → voucherId` | pramaana.vouchers, pramaana.voucher_entries | INSERT voucher, INSERT entries |
| `submitVoucher` | `(payload, entries, companyCode, prefix) → voucherId` | registry.sequence_counters (RPC), pramaana.vouchers, pramaana.voucher_entries | RPC + INSERT voucher (status=pending_approval) + INSERT entries |
| `fetchVoucherForEdit` | `(voucherId) → VoucherForEdit` | pramaana.vouchers, pramaana.voucher_entries, pramaana.ledgers | Parallel SELECT |
| `updateDraftVoucher` | `(voucherId, update, entries) → void` | pramaana.vouchers, pramaana.voucher_entries | UPDATE header, DELETE all entries, re-INSERT entries |
| `formatIndianCurrency` | `(amount) → string` | — | Pure formatting — `amount.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})` prefixed with `'₹'` |

**`submitVoucher` step sequence:**
1. `getNextSequence(companyId, companyCode, prefix)` → voucher number
2. `saveDraftVoucher({...payload, voucher_number, status:'pending_approval'}, entries)`

**Note:** `src/lib/permissions.ts` is listed in RELISH_PLATFORM_MASTER.md Section 8.3 but does **not exist** in `src/lib/`. Permission checks are done inline in App.tsx route guards. `src/lib/whatsapp.ts` is also listed but does **not exist** — the WhatsApp link builder (`buildWhatsAppLink`) referenced in MASTER.md has not been created as a separate file.

---

### `src/lib/vouchers-list.ts`

| Function | Signature | Tables | Operation |
|---|---|---|---|
| `fetchVouchers` | `(companyId, userId, role, filters, page) → {rows, hasMore}` | pramaana.vouchers, pramaana.voucher_types, registry.entities, registry.profiles | Paginated SELECT (PAGE_SIZE=50, fetches PAGE_SIZE+1 for hasMore) |
| `recallVoucher` | `(voucherId) → void` | pramaana.vouchers | UPDATE `status='draft'` WHERE `status='pending_approval'` |
| `deleteVoucher` | `(voucherId) → void` | pramaana.vouchers | DELETE WHERE `status='draft'` only |
| `submitDraftVoucher` | `(voucherId, companyId, companyCode, prefix) → void` | registry.sequence_counters (RPC), pramaana.vouchers | RPC + UPDATE `{voucher_number, status:'pending_approval'}` WHERE `status='draft'` |
| `fetchLedgerOptions` | `(companyId) → {id, name}[]` | pramaana.ledgers | SELECT `id, name` WHERE `company_id=`, `is_active=true`. Used by VoucherSearch ledger typeahead. |
| `fetchAdvancedVoucherSearch` | `(companyId, filters) → AdvancedVoucherResult[]` | pramaana.vouchers, pramaana.voucher_types, pramaana.voucher_entries, pramaana.ledgers, registry.entities | Multi-step resolve: payee text → entity_ids; ledgerId → voucher_ids touching that ledger via voucher_entries; nature → type_ids. Query vouchers with combined filters. Amount exact/gte/lte. Limit 500. |

**`AdvancedFilters`:** `{ payee: string; ledgerId: string; dateFrom: string; dateTo: string; amountType: 'exact'|'gte'|'lte'|''; amountValue: string; nature: string }`

**`fetchVouchers` filter logic:**
- `role === 'accounts'` → adds `.eq('created_by', userId)` (accounts users see only their own vouchers)
- Nature filter: resolved to `voucher_type_id` array via pre-query on `pramaana.voucher_types`
- Party name search: resolved to `entity_id` array via pre-query on `registry.entities`, then OR'd with `voucher_number ILIKE`
- Cross-schema joins (profiles, entities) done as batch fetches after main query, merged in JS

---

### `src/lib/pay-now.ts`

| Function | Signature | Tables | Operation |
|---|---|---|---|
| `fetchCompanyPaymentAccounts` | `(companyId) → CompanyPaymentAccount[]` | registry.company_bank_accounts | SELECT WHERE `company_id=`, `is_active=true`, order `is_primary DESC, created_at ASC` |
| `addCompanyPaymentAccount` | `(companyId, label) → CompanyPaymentAccount` | registry.company_bank_accounts | INSERT |
| `deleteCompanyPaymentAccount` | `(id) → void` | registry.company_bank_accounts | DELETE |
| `markVoucherPaid` | `(voucherId, payload) → void` | pramaana.vouchers | UPDATE `{status:'posted', paid_at, paid_by, paid_from_account, utr_number?, cheque_number?}` WHERE `status IN ('completed','awaiting_payment')`. **This is the only code path that writes `status='posted'`.** |
| `queueForPayment` | `(voucherId, userId) → void` | pramaana.vouchers | UPDATE `{status:'awaiting_payment', queued_at, queued_for_payment_by}` WHERE `status='completed'` |
| `dequeuePayment` | `(voucherId) → void` | pramaana.vouchers | UPDATE `{status:'completed', queued_at:null, queued_for_payment_by:null}` WHERE `status='awaiting_payment'` |
| `updateVoucherPaymentMode` | `(voucherId, paymentMode) → void` | pramaana.vouchers | UPDATE `{payment_mode}` — inline fix for queued vouchers with wrong mode |
| `fetchAdminMobile` | `(companyId, userId) → string\|null` | registry.profiles, registry.entities | Fallback chain: `profiles.mobile` → `entities.mobile` via `profiles.entity_id` → entity with role 'Management' for the company |
| `fetchAwaitingPayments` | `(companyId) → AwaitingPayment[]` | pramaana.vouchers, pramaana.voucher_types, registry.entities | SELECT WHERE `status='awaiting_payment'`, order `queued_at ASC`. Overdue flag when `queued_at > 48h ago`. |

**`CompanyPaymentAccount` interface:** `{ id, company_id, label, account_holder_name, bank_name, bank_account_number, bank_ifsc, upi_id, is_primary, is_active, created_at }` — reads from `registry.company_bank_accounts`, NOT `pramaana.company_payment_accounts` (migration 036 created the latter, but the app evolved to use the richer registry table).

---

### `src/lib/allocations.ts`

| Function | Signature | Tables | Operation |
|---|---|---|---|
| `fetchOpenBills` | `(companyId, entityId, billNature:'purchase'\|'sales') → OpenBill[]` | pramaana.vouchers, pramaana.voucher_types, pramaana.voucher_allocations | SELECT bills WHERE `status IN ['approved','completed','awaiting_payment','posted']`; calculate `outstanding = amount − SUM(already_allocated)`; filter out fully-settled bills (outstanding < 0.005). |
| `saveAllocations` | `(companyId, entityId, paymentVoucherId, allocatedBy, rows) → void` | pramaana.voucher_allocations | INSERT rows. Called after voucher is created. |
| `fetchAllocationsForPayment` | `(paymentVoucherId) → AllocationDetail[]` | pramaana.voucher_allocations, pramaana.vouchers | Returns which bills this payment settled, with bill amounts. |
| `fetchAllocationsForBill` | `(billVoucherId) → BillPaymentDetail[]` | pramaana.voucher_allocations, pramaana.vouchers | Returns which payments were applied to this bill. |

**`OpenBill` interface:** `{ id, voucher_number, voucher_date, amount, outstanding, narration, ref_document_number }`

---

### `src/lib/approvals.ts` |
| `fetchPendingVouchers` | `(companyId) → PendingVoucher[]` | pramaana.vouchers, pramaana.voucher_types, registry.profiles, registry.entities | SELECT + batch cross-schema fetches |
| `fetchVoucherFull` | `(voucherId) → VoucherFull` | pramaana.vouchers, pramaana.voucher_entries, pramaana.ledgers, pramaana.ledger_groups, pramaana.approval_actions, registry.profiles, registry.entities, pramaana.cost_centres | 3 parallel SELECTs, then 4 parallel lookups |
| `approveVoucher` | `(voucherId, companyId, userId, comments, entityId) → ApproveVoucherResult` | pramaana.vouchers, pramaana.approval_actions, pramaana.otp_sessions, registry.entities | UPDATE `{status:'approved', posted_at, posted_by}` WHERE `status='pending_approval'`; INSERT approval_action `action='approved'`; calls `initiatePaymentOtp()` → OTP SMS sent to payee mobile. Returns `{approved, otp_sent, mobile_masked, otp_reason?}`. **Note:** transitions to `'approved'` NOT `'posted'` — DB balance trigger does NOT fire. |
| `rejectVoucher` | `(voucherId, companyId, userId, reason) → void` | pramaana.vouchers, pramaana.approval_actions | UPDATE `{status:'draft'}` (returns to draft); INSERT approval_action `action='rejected'` |

---

### `src/lib/suspense.ts`

| Function | Signature | Tables | Operation |
|---|---|---|---|
| `fetchSuspenseVouchers` | `(companyId, userId, role, page) → {rows, hasMore}` | pramaana.vouchers, pramaana.voucher_types, pramaana.settlement_sessions, registry.profiles, registry.entities | Paginated SELECT WHERE `is_suspense=true` (PAGE_SIZE=50) |
| `fetchSuspenseSession` | `(advanceVoucherId) → SuspenseSession\|null` | pramaana.settlement_sessions | SELECT WHERE `advance_voucher_id=`, `.maybeSingle()` |
| `fetchSuspenseSettlements` | `(advanceVoucherId) → SuspenseSettlement[]` | pramaana.suspense_settlements | SELECT WHERE `advance_voucher_id=`, order `created_at` asc |
| `createSuspenseVoucher` | `(payload, entries) → voucherId` | pramaana.vouchers, pramaana.voucher_entries | INSERT voucher (`status:'pending_approval'`, `voucher_number:'SUS-DRAFT'`), INSERT entries. On entries fail: DELETE voucher. |
| `approveSuspenseVoucher` | `(voucherId, companyId, companyCode, prefix, approvedBy) → void` | registry.sequence_counters (RPC), pramaana.vouchers | RPC + UPDATE `{voucher_number, status:'open', posted_at, posted_by}` WHERE `status='pending_approval'` |
| `rejectSuspenseVoucher` | `(voucherId, rejectedBy, reason) → void` | pramaana.vouchers | UPDATE `{status:'rejected', cancelled_at, cancelled_by, cancellation_reason}` WHERE `status='pending_approval'` |
| `createOrRefreshSession` | `(companyId, entityId, initiatedBy, advanceVoucherId, totalAdvanceAmount) → SuspenseSession` | pramaana.settlement_sessions | SELECT existing; if found: UPDATE `{token: crypto.randomUUID(), updated_at}`; else INSERT new session with `token: crypto.randomUUID()` |
| `buildSettlementUrl` | `(token) → string` | — | `${window.location.origin}/settle/${token}` |
| `addTopUp` | `(advanceVoucherId, companyId, entityId, amount, description, addedBy) → void` | pramaana.suspense_settlements, pramaana.vouchers, pramaana.settlement_sessions | INSERT auto-approved topup; UPDATE voucher amount+balance (reopen if closed); UPDATE session total_advance_amount |
| `approveSettlement` | `(settlementId, approvedBy, notes?) → void` | pramaana.suspense_settlements, pramaana.vouchers | UPDATE settlement `{status:'approved', settled_at, settled_by}`; recalculate voucher balance (delta = -(settled_amount) for expense, +(settled_amount) for refund); set voucher status='closed' if balance=0, 'partial' if balance>0 |
| `rejectSettlement` | `(settlementId, rejectedBy, reason) → void` | pramaana.suspense_settlements | UPDATE `{status:'rejected', notes: reason}` |
| `getSessionByToken` | `(token) → PublicSession\|null` | pramaana.settlement_sessions, pramaana.vouchers | SELECT session WHERE `token=`; validate expiry; SELECT voucher; return null if expired/closed/rejected. **Called as anon (public page)** |
| `submitExpenseEntry` | `(payload) → string (id)` | pramaana.suspense_settlements | INSERT `{status:'pending', entry_type, description, ...}`. **Called as anon (public page)** |
| `suspenseStatusLabel` | `(status) → string` | — | Pure mapping: pending_approval→'Pending Approval', open→'Open', partial→'Partial', closed→'Closed', rejected→'Rejected' |
| `settlementStatusLabel` | `(status) → string` | — | Pure mapping: pending→'Under Review', approved→'Approved', rejected→'Rejected' |

---

### `src/lib/attachments.ts`

| Function | Signature | Tables / Storage | Operation |
|---|---|---|---|
| `uploadVoucherAttachments` | `(voucherId, companyId, userId, files[]) → {ok[], failed[]}` | storage.`voucher-attachments`, pramaana.voucher_attachments | Per-file: Storage upload, then DB INSERT. On DB fail: Storage remove orphan. Fails gracefully per file. |
| `fetchVoucherAttachments` | `(voucherId) → AttachmentWithUrl[]` | pramaana.voucher_attachments, storage.`voucher-attachments` | SELECT WHERE `voucher_id=`, `is_deleted=false`; then `createSignedUrls(paths, 3600)` |
| `deleteAttachment` | `(attachmentId) → void` | pramaana.voucher_attachments | UPDATE `{is_deleted: true}` — soft delete only |
| `isImage` | `(mimeType) → boolean` | — | `mimeType?.startsWith('image/')` |
| `formatFileSize` | `(bytes) → string` | — | B / KB / MB |

Storage path: `${companyId}/${voucherId}/${Date.now()}_${random}.${ext}`

---

### `src/lib/otp.ts`

OTP-based payment verification. Called by `approvals.ts` (initiate) and `ApprovalQueue.tsx` (verify).

| Function | Signature | Tables | Operation |
|---|---|---|---|
| `initiatePaymentOtp` | `(voucherId, companyId, initiatedBy, entityId) → OtpInitResult` | registry.entities, pramaana.otp_sessions | Fetches entity mobile; cancels existing pending OTP sessions for this voucher; generates 6-digit OTP; calls `POST /api/otp` to bcrypt-hash it; INSERTs `pramaana.otp_sessions` row (10-min expiry); sends SMS via `sendPaymentOtpSms()`. Returns `{sent:true, mobile_masked}` or `{sent:false, reason}`. |
| `verifyPaymentOtp` | `(voucherId, plainOtp, verifiedBy) → OtpVerifyResult` | pramaana.otp_sessions, pramaana.vouchers | Fetches active pending session; checks attempt limit (max 3); calls `POST /api/otp` to verify OTP against bcrypt hash; on match: marks session `verified`, UPDATEs voucher to `status='completed'` with `otp_verified_at`, `completed_at`. On mismatch: increments `failed_attempts`. |

**`/api/otp` Vercel Edge Function:** Handles both `action:'hash'` (bcrypt hash generation) and `action:'verify'` (bcrypt compare). Uses `VITE_OTP_INTERNAL_SECRET` as anti-abuse header. Plain OTP is NEVER stored — only the bcrypt hash is persisted in `pramaana.otp_sessions`.

**OTP session row:** `{voucher_id, company_id, initiated_by, mobile, otp_hash, expires_at: now+10min, status:'pending', failed_attempts:0}`

**OTP flow:**
1. `approveVoucher()` → admin approves in UI → voucher: `pending_approval → approved` → OTP sent to payee mobile
2. Payee receives SMS, reads code to admin
3. Admin enters code in ApprovalQueue OTP panel → `verifyPaymentOtp()` called
4. On match → voucher: `approved → completed`

---

### `src/hooks/useInvoiceScan.ts`

State machine hook for the Invoice OCR workflow inside `InvoiceScanModal` (triggered from `VoucherEntry`). Manages 4 steps: Upload → Processing → Review → Done.

**Signature:** `useInvoiceScan({ companyGstin?: string, companyName?: string })`

**`ScanForm` interface** (editable state in Step 3):

| Field | Type | Source |
|---|---|---|
| `invoiceNo` | string | OCR |
| `invoiceDate` | string (YYYY-MM-DD) | OCR, normalised |
| `supplierName` | string | OCR, or `companyName` if sale invoice |
| `supplierGstin` | string | OCR, or `companyGstin` if sale invoice |
| `recipientName` | string | OCR, or `companyName` if purchase invoice |
| `recipientGstin` | string | OCR, or `companyGstin` if purchase invoice |
| `taxableValue` / `cgst` / `sgst` / `igst` / `totalGst` / `totalAmount` | string (numeric) | OCR |
| `voucherType` | `'purchase'\|'sales'\|...` | Derived (`isOurSale` → `'sales'`) |
| `narration` | string | Built from party name + invoice no + HSN |
| `itcEligible` | boolean | `false` for sales, `true` for purchases |
| `gstType` | `'intra'\|'inter'\|'unknown'` | Derived from GSTIN state codes |
| `ourPartyVerified` | boolean | `true` when `companyName` or `companyGstin` were available — drives locked-field UI in Review |

**Key functions:**

| Function | What it does |
|---|---|
| `selectFile(file)` | Validates file (PDF/JPG/PNG, max 5 MB); creates object URL for image preview |
| `extractFirstPageAsJpeg(file)` | For PDFs: renders page 1 to JPEG at 2× scale via `pdfjs-dist` (3–5× faster OCR). Falls back to raw PDF if PDF.js fails. Returns `{base64, mimeType}`. |
| `startScan(file)` | Calls PDF→JPEG conversion, then `POST /api/ocr-edge` with base64. Handles `COMPANY_MISMATCH` error (HTTP 4xx with `error:'COMPANY_MISMATCH'`). On success: calls `ocrToForm(ocr, companyGstin, companyName)`. |
| `updateField(key, value)` | Updates form field; auto-recalculates GST totals when CGST/SGST/IGST/taxable change; auto-routes CGST/SGST vs IGST based on GSTIN state codes. |
| `createDraft()` | Calls `saveDraftVoucher(payload, entries)`. Draft `voucher_number = 'DRAFT-{Date.now()}'` (unique per millisecond). `voucher_date = today`. `ref_document_number = '{invoiceNo} dt {invoiceDate}'`. |
| `reset()` | Resets state machine to step 1 |

**`ocrToForm(ocr, companyGstin, companyName)` — our company auto-correction + sale detection:**
- `gstinMatch`: `ocr.supplierGstin === companyGstin` (normalised uppercase, spaces stripped)
- `nameMatch`: `ocr.supplierName.includes(companyName.replace(/pvt.*$/i,'').trim())`
- `isOurSale = gstinMatch || nameMatch`
- When `isOurSale`: `voucherType='sales'`, `itcEligible=false`, narration uses recipient name
- **Our company fields are always filled from master data, not OCR:**
  - Purchase (`!isOurSale`) → `recipientName = companyName`, `recipientGstin = companyGstin`
  - Sale (`isOurSale`) → `supplierName = companyName`, `supplierGstin = companyGstin`
  - Falls back to OCR value only if `companyName`/`companyGstin` are absent
- Sets `ourPartyVerified = !!(companyName || companyGstin)` — consumed by the Review UI

**`normalizeDate(dateStr)`:** Converts `DD/MM/YYYY` and `DD-MM-YYYY` to `YYYY-MM-DD`. Passes through already-ISO dates unchanged.

---

### `src/components/InvoiceScanModal.tsx`

Modal triggered from `VoucherEntry` via the "Scan Invoice" button.

**Props:** `{ open, onClose, companyId, companyCode, companyGstin?, companyName?, userId, voucherTypes }`

Consumes `useInvoiceScan({ companyGstin, companyName })`. On `createDraft()` success redirects to `/vouchers/{draftId}/edit`.

**Locked-field UI in Step 3 (Review):**  
When `form.ourPartyVerified` is `true`, the party fields for *our own company's side* are rendered read-only with a green **🔒 Company Master** badge:
- Purchase invoice → Recipient Name + Recipient GSTIN are locked
- Sale invoice → Supplier Name + Supplier GSTIN are locked

This immediately signals to the user which fields are authoritative (from `registry.companies`) and which came from OCR (editable, potentially wrong). The other side's fields remain fully editable.

---

### `api/ocr-edge.ts` (Vercel Edge Function)

```typescript
export const config = { runtime: 'edge' }
```

- **Endpoint:** `POST /api/ocr-edge` — called by `useInvoiceScan.startScan()`
- **Auth:** None (same-origin Vercel deployment)
- **Env var:** `ANTHROPIC_API_KEY` (name is historical; the VALUE is an OpenAI API key)
- **Calls:** `https://api.openai.com/v1/chat/completions` with `gpt-4o` model and `image_url` content type (base64 JPEG/PNG)
- **Input:** `{ fileBase64: string, fileType: string }`
- **Output:** `OcrResult` JSON (or error object)
- **Does NOT write to DB** — DB writes are done client-side in `createDraft()`

**GSTIN prompt rules (in `EXTRACTION_PROMPT`):**
- Position 14 is ALWAYS `Z`
- Read each character individually — do not reconstruct or guess
- Use `?` for unreadable characters rather than guessing
- Indian number system: commas as thousands separators (`2,10,000 = 210000`)
- Returns `invoiceDate` in `YYYY-MM-DD` format

**GST routing:** After extraction, `routeGst(supplierGstin, recipientGstin, totalGst)` splits into CGST/SGST (intra-state) or IGST (inter-state) based on the first 2 digits of each GSTIN (state code).

---

### `supabase/functions/ocr/index.ts` (Supabase Edge Function)

- **Name:** `ocr`
- **Runtime:** Deno (150 s wall-clock limit)
- **Invoked via:** `supabase.functions.invoke('ocr', { body: {...} })` from `src/modules/invoice-scan/hooks/useOcr.ts`
- **Env secrets required:** `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **Input:** `{ fileBase64, fileType, invoiceType:'purchase'|'sale', companyId, userId?, storagePath? }`

**Processing sequence:**
1. Resolves company from `registry.companies` → gets `code`, `gstin`, `name`
2. Calls OpenAI GPT-4o Vision with `gpt-4o` model
3. **GSTIN mismatch check:** For `purchase`, checks `recipientGstin === companyGstin`; for `sale`, checks `supplierGstin === companyGstin`. If mismatch → returns HTTP 422 `{ error:'COMPANY_MISMATCH', message, extractedGstin, activeCompanyGstin }`. Frontend (`useOcr.ts`) catches this and shows a specific "Wrong company" error.
4. Calls `pramaana.next_scan_ref(p_company_id, p_company_code, p_type, p_scan_date)` RPC for sequence-based scan_ref. Falls back to `buildScanRef()` (deterministic string) if RPC fails (migration 034 not yet applied).
5. INSERTs into `pramaana.invoice_scans` (company_id, scan_ref, type, invoice_no, invoice_date, party_name, party_gstin, our_gstin, taxable_value, total_gst, cgst, sgst, igst, total_amount, gst_type, raw_json, confidence, storage_path, scanned_by)
6. If insert succeeds and line items exist: INSERTs into `pramaana.invoice_scan_items` (scan_id, company_id, line_no, description, hsn_sac, quantity, unit, unit_price, amount)
7. Returns `{ ...OcrResult, scanId, scanRef }`. Non-fatal: returns OCR result even if DB write fails.

**scan_ref format (sequence-based):** `{companyCode}/{fyText}/{PUR|SAL}/{YYYYMMDD}-{NNNN}`  
Example: `RFPL/2627/PUR/20260625-0001`

**scan_ref format (fallback):** `{companyCode}/{fy}/{PUR|SAL}/{YYYYMMDD}-{invoiceNo}-{partyName}`

---

### `src/lib/reports.ts` — ⚠️ CRITICAL BUG

**All report queries filter `.eq('status','posted')`** — but no voucher reaches `'posted'` status in the current approval flow (flow ends at `'completed'`). **All reports return empty data.**

Affected functions: `fetchDayBook`, `fetchLedgerStatement`, `fetchTrialBalance`, `fetchOutstandingLedgers`, `fetchGSTVouchers`, `fetchCashFlow`.

**Root cause:** `approveVoucher` was changed to set `status='approved'` instead of `'posted'`. Reports were not updated.

**Fix required:** Change `.eq('status','posted')` to `.in('status', ['approved','completed'])` across all six functions — OR restructure the approval flow so final state is `'posted'`.

---
### `src/lib/sms.ts`
SMS is fire-and-forget — all public functions never throw. Calls `POST /api/send-sms` (Vercel Edge Function).

| Function | Signature | Operation |
|---|---|---|
| `sendSettlementLinkSms` | `(entityId, amount, token) → SmsResult` | Fetches entity mobile from `registry.entities`; calls `callApi('settlement-link', mobile, [firstName, amountStr, url])` |
| `sendPaymentConfirmedSms` | `(entityId, amount, voucherNo) → SmsResult` | Fetches entity mobile; calls `callApi('payment-confirmed', mobile, [amountStr, voucherNo])` |
| `sendPaymentOtpSms` | `(mobile, otp) → SmsResult` | Calls `callApi('payment-otp', mobile, [otp])` directly |

Returns `{ sent: false, reason: 'no_mobile' }` if entity has no mobile. No throw on any failure path.

---

### `api/send-sms.ts` (Vercel Edge Function)
```typescript
export const config = { runtime: 'edge' }
```

- Accepts `POST` with JSON body `{ template, mobile, vars }`
- Reads `TWOFACTOR_API_KEY` from `process.env` (server-side only — never exposed to browser)
- Calls `https://2factor.in/API/V1/{apiKey}/ADDON_SERVICES/SEND/TSMS` (POST with URLSearchParams)
- DLT template name map:

| `template` value | DLT template name (Vilpower) |
|---|---|
| `'settlement-link'` | `'Pramaana-Settlement-Link'` |
| `'payment-confirmed'` | `'Pramaana-Payment-Confirmed'` |
| `'payment-otp'` | `'Pramaana-Payment Approval'` ← space, not hyphen |

- For `settlement-link`: shortens `vars[2]` via `https://tinyurl.com/api-create.php` (3s timeout, falls back to original URL on failure)
- Returns `{ success: true, sessionId: data.Details }` on success; `{ error: data.Details }` + HTTP 502 on 2Factor error

---

### `supabase/functions/send-sms/index.ts`
A Supabase Edge Function with the same logic. Exists in `supabase/functions/send-sms/` but the deployed integration uses the **Vercel** edge function (`api/send-sms.ts`). The Supabase function appears to be a development artefact.

---

### `src/contexts/AuthContext.tsx`

Exports: `AuthProvider`, `useAuth`

```typescript
interface AuthContextValue {
  user:             AuthUser | null
  loading:          boolean
  setActiveCompany: (company: Company) => void
  signOut:          () => Promise<void>
}
```

**Session bootstrap sequence:**
1. `supabase.auth.getSession()` on mount
2. `fetchProfile(userId)` — SELECT `registry.profiles` WHERE `id = userId`
3. `fetchCompanyUsers(userId)` — SELECT `registry.company_users` WHERE `user_id = userId`; then SELECT `registry.companies` WHERE `id IN (companyIds)` (two separate queries — cross-schema FK join not used)
4. If `profile.is_super_admin && companyUsers.length === 0`: `fetchAllCompanies()` + synthesise virtual `CompanyUser` rows with `role: 'admin'` and `id: 'sa-{company.id}'`
5. Auto-select `activeCompany` only if exactly 1 membership; otherwise CompanySelector handles it

`setActiveCompany(company)` updates `activeRole` by looking up the matching `CompanyUser.role`. Role is **not** overridden to `'admin'` for super_admin on `setActiveCompany` — the virtual role set in step 4 carries through.

---

### `src/contexts/ApprovalContext.tsx`

Exports: `ApprovalProvider`, `useApprovalCount`

Calls `fetchPendingCount(companyId)` on mount and exposes `{ pendingCount, refreshCount }`. Used by the sidebar approval badge. Refreshed manually after approval/rejection actions.

---

## 3. Routes / Pages

All routing is in `src/App.tsx` using React Router v6 `<Routes>/<Route>`.

### 3.1 Public Routes (no auth required)

These appear in all three routing branches (unauthenticated, authenticated-no-company, fully-authenticated):

| Route | Component | Guard | Notes |
|---|---|---|---|
| `/login` | `Login` | None — in unauthenticated branch only | Supabase email/password |
| `/relay` | `RelayCapture` | None — in all three branches | QR relay bill upload. Uses Supabase signed upload URL from query params `?path=&token=`. No session check. |
| `/settle/:token` | `SettleCapture` | None — in all three branches | Suspense settlement page. Token in URL path. Calls anon-accessible Supabase queries. |

### 3.2 Authenticated Routes (require valid session)

| Route | Component | Role Guard |
|---|---|---|
| `/select-company` | `CompanySelector` | None (any authenticated) |
| `/` | `Dashboard` (placeholder) | None (any authenticated + active company) |
| `/ledgers` | `Ledgers` via `LedgersGuard` | admin, accounts, auditor, super_admin |
| `/vouchers` | `VoucherRegister` via `VoucherRegisterGuard` | Any authenticated (no role filter) |
| `/vouchers/search` | `VoucherSearch` via `VoucherSearchGuard` | Any authenticated (no role filter) |
| `/vouchers/new` | `VoucherEntry` via `VoucherEntryGuard` | admin, accounts, super_admin |
| `/vouchers/:id/edit` | `VoucherEdit` via `VoucherEditGuard` | admin, accounts, super_admin |
| `/suspense` | `SuspenseRegister` via `SuspenseRegisterGuard` | Any authenticated (no role filter) |
| `/suspense/new` | `SuspenseEntry` via `SuspenseEntryGuard` | admin, accounts, super_admin |
| `/approvals` | `ApprovalQueue` via `ApprovalQueueGuard` | admin, accounts, auditor, super_admin |
| `/payments` | `AwaitingPayments` via `AwaitingPaymentsGuard` | admin, accounts, super_admin |
| `/inventory` | `Inventory` via `InventoryGuard` | admin, accounts, auditor, super_admin |
| `/reports/day-book` | `DayBook` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/ledger` | `LedgerStatement` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/trial-balance` | `TrialBalance` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/pl` | `PLStatement` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/balance-sheet` | `BalanceSheet` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/receivables-payables` | `ReceivablesPayables` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/cash-flow` | `CashFlow` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/gst` | `GSTReports` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/ratios` | `RatioAnalysis` via `ReportGuard` | admin, accounts, auditor, super_admin |
| `/reports/exceptions` | `ExceptionReports` via `ReportGuard` | admin, accounts, auditor, super_admin |

### 3.3 Missing Routes

No `*` catch-all / 404 route is defined. Any unknown path falls through silently.

---

## 4. Auth & Permissions

### 4.1 Auth Mechanism
Supabase email/password auth. JWT stored by Supabase JS client. Session persists across page reloads. `supabase.auth.onAuthStateChange` subscription in `AuthContext.tsx` handles sign-in/sign-out/token refresh.

### 4.2 Role Model
```
registry.profiles.is_super_admin = TRUE  →  synthetic 'super_admin' role
  — overrides all company roles
  — sees all companies
  — no company_users row required

registry.company_users.role  →  per-company role
  Valid values (CHECK constraint): 'admin'|'accounts'|'auditor'|'hr'|'operations'|'viewer'
  Note: 'super_admin' is NOT a valid company_users.role value
```

### 4.3 Permission Matrix (enforced in App.tsx route guards)

| Route | super_admin | admin | accounts | auditor | hr | operations | viewer |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| /ledgers | ✅ | ✅ | ✅ | ✅ | | | |
| /vouchers (register) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /vouchers/search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /vouchers/new | ✅ | ✅ | ✅ | | | | |
| /vouchers/:id/edit | ✅ | ✅ | ✅ | | | | |
| /suspense (register) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /suspense/new | ✅ | ✅ | ✅ | | | | |
| /approvals | ✅ | ✅ | ✅ | ✅ | | | |
| /payments | ✅ | ✅ | ✅ | | | | |
| /inventory (view) | ✅ | ✅ | ✅ | ✅ | | | |
| /inventory (set rate) | ✅ | ✅ | | | | | |
| /reports/* | ✅ | ✅ | ✅ | ✅ | | | |
| /relay | Public | Public | Public | Public | Public | Public | Public |
| /settle/:token | Public | Public | Public | Public | Public | Public | Public |

**Inventory write note:** The "Set Rate" button is hidden for non-admin roles in the UI, and `pramaana.inventory_valuations` RLS blocks non-admin writes at the DB level.

### 4.4 `approveVoucher` Access
No role check in the function itself. Gate is the route guard on `/approvals`: admin, accounts, auditor (or super_admin). However, `approveVoucher` sets `status = 'posted'` — the DB trigger `fn_validate_voucher_balance` enforces Dr=Cr at the DB level regardless of who calls it.

---

## 5. External Service Credentials

### 5.1 Vercel Environment Variables

| Variable | Side | Value source | Used by |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Client (browser) | Vercel project settings | `src/lib/supabase.ts` |
| `VITE_SUPABASE_ANON_KEY` | Client (browser) | Vercel project settings | `src/lib/supabase.ts` |
| `VITE_CLAMFLOW_SUPABASE_URL` | Client (browser) | Vercel project settings | `src/lib/supabaseClamFlow.ts` |
| `VITE_CLAMFLOW_SUPABASE_ANON_KEY` | Client (browser) | Vercel project settings | `src/lib/supabaseClamFlow.ts` |
| `TWOFACTOR_API_KEY` | Server-side only | Vercel project settings | `api/send-sms.ts` via `process.env` |
| `TWOFACTOR_WHATSAPP_KEY` | Server-side only | Not yet set (awaiting 2Factor approval) | Future `api/send-whatsapp.ts` |
| `TWOFACTOR_WHATSAPP_PHONE_ID` | Server-side only | Not yet set (awaiting 2Factor approval) | Future `api/send-whatsapp.ts` |
| `ANTHROPIC_API_KEY` | Server-side only | Vercel project settings | `api/ocr-edge.ts` via `process.env`. **Name is historical — the VALUE is an OpenAI API key, not Anthropic.** |

`VITE_*` variables are bundled into the client JS by Vite at build time. `TWOFACTOR_API_KEY` and `ANTHROPIC_API_KEY` have no `VITE_` prefix and are only available in the Vercel Edge Function runtime via `process.env`.

### 5.1a Supabase Edge Function Secrets

Set via Supabase Dashboard → Edge Functions → Secrets (not in version control):

| Secret | Used by | Notes |
|---|---|---|
| `OPENAI_API_KEY` | `supabase/functions/ocr/index.ts` | OpenAI API key for GPT-4o Vision OCR calls |
| `SUPABASE_URL` | `supabase/functions/ocr/index.ts` | Auto-injected by Supabase runtime — no manual set needed |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase/functions/ocr/index.ts` | Auto-injected by Supabase runtime — no manual set needed |
| `ANTHROPIC_API_KEY` | Not used by any function | Was set as a secret but current `ocr` function uses `OPENAI_API_KEY`. Can be ignored. |

**Note:** The Supabase Edge Function (`supabase/functions/ocr`) must be **redeployed via Supabase Dashboard** whenever `supabase/functions/ocr/index.ts` is changed. There is no Docker/CLI deploy — paste the file contents into the inline editor in the Dashboard.

### 5.2 SMS Provider
**2Factor TSMS API**  
Endpoint: `https://2factor.in/API/V1/{TWOFACTOR_API_KEY}/ADDON_SERVICES/SEND/TSMS`  
Sender ID: `RELISH`  
DLT entity: Relish Hao Hao Chi Foods (Vilpower)

| Template key | DLT name | Variables |
|---|---|---|
| `payment-otp` | `Pramaana-Payment Approval` | VAR1=OTP |
| `settlement-link` | `Pramaana-Settlement-Link` | VAR1=name, VAR2=amount, VAR3=url (TinyURL shortened) |
| `payment-confirmed` | `Pramaana-Payment-Confirmed` | VAR1=amount, VAR2=voucher# |

**Active usage:** `payment-otp` only. `settlement-link` and `payment-confirmed` are superseded by WhatsApp `wa.me` links (interim) — the DLT templates remain registered but are not the primary channel.

### 5.3 WhatsApp (Interim — no API key required)
`wa.me` deep link pattern used directly in the browser. No server-side credential. Not in a separate lib file — build pattern documented in RELISH_PLATFORM_MASTER.md:
```
https://wa.me/{digitsOnly}?text={encodeURIComponent(message)}
```
Full WhatsApp Business API via 2Factor: onboarding initiated 2026-06-12, credentials not yet available.

---

## 6. Known Gaps / TODOs

| Issue | Location | Priority | Notes |
|---|---|---|---|
| `suspense_settlements.status` CHECK constraint mismatch | Migration 025 | ✅ **RESOLVED 2026-06-25** | Migration 025 replaced the constraint with `CHECK IN ('pending','approved','rejected','open','partial','cleared')` — aligning with what `suspense.ts` actually writes. |
| `settlement_sessions.status` CHECK constraint mismatch | Migration 025 | ✅ **RESOLVED 2026-06-25** | Migration 025 added `'open'` to the CHECK constraint: `CHECK IN ('draft','open','in_progress','completed','cancelled')`. |
| `vouchers.status` CHECK constraint — suspense states missing | Migration 025 | ✅ **RESOLVED 2026-06-25** | Migration 025 expanded the constraint to include `'completed','open','rejected','partial','closed'`. |
| `src/lib/permissions.ts` absent | `src/lib/` | Low | Referenced as an existing file in RELISH_PLATFORM_MASTER.md §8.3 and §8.4. Not present in the directory. Permission checks are done inline in App.tsx route guards. |
| `src/lib/whatsapp.ts` absent | `src/lib/` | Low | Referenced as an existing file in RELISH_PLATFORM_MASTER.md §8.3. Not present in the directory. WhatsApp link builder logic is not implemented as a separate module. |
| `voucher_attachments` defined twice | Migrations 008 + 020 | Documentation | Migration 008 defines the table with `file_url TEXT NOT NULL` (no `storage_path`, no `is_deleted`). Migration 020 uses `CREATE TABLE IF NOT EXISTS` with the correct schema. If 008 ran first, 020's `CREATE TABLE IF NOT EXISTS` is a no-op — the old column set would remain. The app code uses `storage_path`, `is_deleted` etc. Likely the table was dropped manually between migrations, or 020 ran before 008. |
| `posted` status is unreachable — ALL REPORTS EMPTY | `approvals.ts`, `src/lib/reports.ts` | ✅ **RESOLVED 2026-07-03** | `markVoucherPaid()` in `pay-now.ts` now writes `status='posted'` as the terminal state. `reports.ts` was updated to filter `.in('status', ['approved','completed','awaiting_payment','posted'])` across all report functions. Balance trigger (`fn_validate_voucher_balance`) fires on the transition to `posted`. Reports are no longer empty. |
| OTP/completion columns not in tracked migration | `pramaana.vouchers`, `src/lib/otp.ts` | ✅ **DOCUMENTATION ERROR — 2026-07-03** | The original note was wrong. `otp_verified_at`, `otp_verified_by`, `completed_at`, `completed_by`, `paid_at`, `paid_by` are all present in `025_fix_status_enums_and_payment_columns.sql` lines 118–123 as `ADD COLUMN IF NOT EXISTS`. `queued_at` and `queued_for_payment_by` are in `039_awaiting_payment_status.sql`. All columns have always been tracked. The gap entry itself was the error. |
| Dashboard is a placeholder | `src/App.tsx` `Dashboard()` | Medium | No KPI cards. Returns a simple welcome message with company name and role. |
| `VoucherEdit.tsx` not end-to-end tested | `src/pages/VoucherEdit.tsx` | Medium | Built, route added, but no confirmed test of save path with a real draft voucher. |
| Financial reports not built | Phase 3 | ✅ BUILT 2026-06-19 | All core + extended reports now built — see Section 3.2 routes. |
| Voucher Search not built | Phase 3 | ✅ BUILT 2026-06-19 | `/vouchers/search` with payee, ledger, type, date range, amount filters. |
| Inventory (ClamFlow) not built | Phase 3 | ✅ BUILT 2026-06-19 | `/inventory` — reads ClamFlow lots + fp_forms (READ ONLY). Admin sets rate_per_kg. |
| `capture_sessions`, `notifications`, `push_subscriptions`, `otp_sessions`, `gst_details`, `period_locks`, `voucher_line_items` unused | Multiple tables | — | Defined in schema, no lib functions or page components query them. |
| WhatsApp Business API pending | External | Medium | 2Factor onboarding submitted 2026-06-12. `TWOFACTOR_WHATSAPP_KEY`, `TWOFACTOR_WHATSAPP_PHONE_ID` not yet set. |
| `supabase/functions/send-sms/index.ts` is a duplicate | Supabase Edge Function | Low | The same SMS logic exists as both a Vercel edge function (`api/send-sms.ts`) and a Supabase function. Only the Vercel version is deployed and called. |

---

## 7. Voucher & Accounting Logic

### 7.1 DB Trigger Functions

**`pramaana.set_updated_at()`**  
Source: `008_pramaana_schema.sql`
```sql
CREATE OR REPLACE FUNCTION pramaana.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
Applied to: `ledger_groups`, `ledgers`, `cost_centres`, `vouchers`, `suspense_settlements`, `settlement_sessions` — all as `BEFORE UPDATE FOR EACH ROW`.

---

**`pramaana.fn_prevent_posted_edit()`**  
Source: `008a_fix_prevent_posted_edit.sql` (patched version — replaces original in 008):
```sql
CREATE OR REPLACE FUNCTION pramaana.fn_prevent_posted_edit()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot delete a % voucher. Number: %', OLD.status, OLD.voucher_number;
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE path
  IF OLD.status IN ('posted', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot modify a % voucher. Number: %', OLD.status, OLD.voucher_number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
Trigger: `trg_prevent_posted_edit BEFORE UPDATE OR DELETE ON pramaana.vouchers FOR EACH ROW`

**Original bug in 008:** The DELETE branch did `RETURN NEW` — there is no NEW row in a DELETE trigger, causing a runtime error. Patch 008a adds the explicit `TG_OP = 'DELETE'` branch returning `OLD`.

---

**`pramaana.fn_validate_voucher_balance()`**  
Source: `008_pramaana_schema.sql`
```sql
CREATE OR REPLACE FUNCTION pramaana.fn_validate_voucher_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_dr NUMERIC;
  v_cr NUMERIC;
BEGIN
  IF NEW.status = 'posted' AND (OLD.status IS DISTINCT FROM 'posted') THEN
    SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'Dr' THEN amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN entry_type = 'Cr' THEN amount ELSE 0 END), 0)
    INTO v_dr, v_cr
    FROM pramaana.voucher_entries
    WHERE voucher_id = NEW.id;

    IF v_dr = 0 AND v_cr = 0 THEN
      RAISE EXCEPTION 'Voucher % has no entries. Add debit and credit lines before posting.',
        NEW.voucher_number;
    END IF;

    IF round(v_dr, 2) <> round(v_cr, 2) THEN
      RAISE EXCEPTION 'Voucher % is unbalanced. Dr=% Cr=% Diff=%',
        NEW.voucher_number, v_dr, v_cr, abs(v_dr - v_cr);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
Trigger: `trg_validate_voucher_balance BEFORE UPDATE ON pramaana.vouchers FOR EACH ROW`

**Fires only when:** `NEW.status = 'posted'` AND `OLD.status IS DISTINCT FROM 'posted'` (i.e., only on the transition into posted state, not on subsequent updates to already-posted vouchers — those are blocked by `fn_prevent_posted_edit` before this trigger even fires).

---

**`pramaana.fn_audit_voucher()`**  
Source: `008_pramaana_schema.sql`
```sql
CREATE OR REPLACE FUNCTION pramaana.fn_audit_voucher()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO pramaana.audit_log
      (company_id, schema_name, table_name, record_id, action, old_data, user_id)
    VALUES (OLD.company_id, 'pramaana', TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), auth.uid());
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO pramaana.audit_log
      (company_id, schema_name, table_name, record_id, action, new_data, user_id)
    VALUES (NEW.company_id, 'pramaana', TG_TABLE_NAME, NEW.id, 'INSERT', to_jsonb(NEW), auth.uid());
    RETURN NEW;
  ELSE
    INSERT INTO pramaana.audit_log
      (company_id, schema_name, table_name, record_id, action, old_data, new_data, user_id)
    VALUES (NEW.company_id, 'pramaana', TG_TABLE_NAME, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), auth.uid());
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```
Trigger: `trg_audit_vouchers AFTER INSERT OR UPDATE OR DELETE ON pramaana.vouchers FOR EACH ROW`

`SECURITY DEFINER` — runs as the function owner so it can write to `pramaana.audit_log` regardless of the calling user's grants.

---

**`pramaana.prevent_posted_voucher_update()`**
Source: `044_posted_voucher_immutability.sql`
```sql
CREATE OR REPLACE FUNCTION pramaana.prevent_posted_voucher_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Voucher % is posted and cannot be modified. '
      'Create a reversing Journal voucher to correct it.', OLD.voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
```
Trigger: `trg_prevent_posted_voucher_update BEFORE UPDATE ON pramaana.vouchers FOR EACH ROW`

Belt-and-suspenders alongside `fn_prevent_posted_edit` (which covers UPDATE OR DELETE on both `posted` AND `cancelled`). This narrower trigger covers only the `UPDATE + posted` case with a more descriptive error message directing to the reversal pattern.

---

**`pramaana.prevent_posted_entry_mutation()`**
Source: `044_posted_voucher_immutability.sql`
```sql
CREATE OR REPLACE FUNCTION pramaana.prevent_posted_entry_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_voucher_status TEXT;
  v_voucher_number TEXT;
  v_voucher_id     UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN v_voucher_id := OLD.voucher_id;
  ELSE                      v_voucher_id := NEW.voucher_id;
  END IF;

  SELECT status, voucher_number INTO v_voucher_status, v_voucher_number
  FROM   pramaana.vouchers WHERE id = v_voucher_id;

  IF v_voucher_status = 'posted' THEN
    RAISE EXCEPTION 'Cannot modify entries of posted voucher %. '
      'Create a reversing Journal voucher to correct it.', v_voucher_number
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
```
Triggers:
- `trg_prevent_posted_entry_insert BEFORE INSERT ON pramaana.voucher_entries FOR EACH ROW`
- `trg_prevent_posted_entry_update BEFORE UPDATE ON pramaana.voucher_entries FOR EACH ROW`
- `trg_prevent_posted_entry_delete BEFORE DELETE ON pramaana.voucher_entries FOR EACH ROW`

This is the primary new protection from migration 044 — `fn_prevent_posted_edit` covers the vouchers row but not its entries. This closes the gap where a crafty UPDATE to `voucher_entries` could silently alter the accounting record of a posted voucher.

---

### 7.2 Voucher State Machine

**Standard voucher states** (from `vouchers.status` CHECK constraint in migration 008):
```
'draft' | 'pending_approval' | 'approved' | 'posted' | 'cancelled'
```

**Standard voucher transitions (enforced in app code):**

| Transition | Trigger | Code location | Guard |
|---|---|---|---|
| `(new)` → `draft` | `saveDraftVoucher(payload with status:'draft')` | `vouchers.ts` | None |
| `draft` → `pending_approval` | `submitVoucher()` or `submitDraftVoucher()` | `vouchers.ts`, `vouchers-list.ts` | Sets real voucher number via `getNextSequence` |
| `pending_approval` → `draft` | `recallVoucher()` | `vouchers-list.ts` | `.eq('status','pending_approval')` guard on UPDATE |
| `pending_approval` → `draft` | `rejectVoucher()` | `approvals.ts` | No status guard on UPDATE (relies on `fn_prevent_posted_edit`) |
| `pending_approval` → `approved` | `approveVoucher()` | `approvals.ts` | `.eq('status','pending_approval')` guard; OTP initiated via `initiatePaymentOtp()`; **DB balance trigger NOT fired** (trigger only fires on → `'posted'`) |
| `approved` → `completed` | `verifyPaymentOtp()` | `otp.ts` | `.eq('status','approved')` guard; OTP bcrypt-verified via `/api/otp`; writes `otp_verified_at`, `otp_verified_by`, `completed_at`, `completed_by` |
| `completed` → `awaiting_payment` | `queueForPayment()` | `pay-now.ts` | `.eq('status','completed')` guard; writes `queued_at`, `queued_for_payment_by` |
| `awaiting_payment` → `completed` | `dequeuePayment()` | `pay-now.ts` | `.eq('status','awaiting_payment')` guard; clears `queued_at`, `queued_for_payment_by` |
| `completed` or `awaiting_payment` → `posted` | `markVoucherPaid()` | `pay-now.ts` | `.in('status',['completed','awaiting_payment'])` guard; writes `paid_at`, `paid_by`, `paid_from_account`; DB balance trigger fires |
| `draft` → (deleted) | `deleteVoucher()` | `vouchers-list.ts` | `.eq('status','draft')` guard on DELETE |
| any editable → (edit) | `updateDraftVoucher()` | `vouchers.ts` | DB trigger raises EXCEPTION if `OLD.status IN ('posted','cancelled')` |

**`approved` state**: Written by `approveVoucher()` (`pending_approval → approved`). Intermediate OTP-pending state — admin-approved, payee has not yet confirmed via OTP.

**`completed` state**: Written by `verifyPaymentOtp()` (`approved → completed`). OTP verified. Payment is now authorised and can be initiated.

**`awaiting_payment` state**: Written by `queueForPayment()` (`completed → awaiting_payment`). Voucher is on the Payments queue (`/payments`). Can be dequeued back to `completed` via `dequeuePayment()`.

**`posted` state**: Written by `markVoucherPaid()` (`completed` or `awaiting_payment` → `posted`). Terminal financial state. All report functions include `posted` in their status filter. DB trigger `fn_validate_voucher_balance` fires on this transition — rejects if Dr ≠ Cr. **Immutable** once set (triggers `fn_prevent_posted_edit` and `prevent_posted_voucher_update` + `prevent_posted_entry_mutation` from migration 044).

**Reversibility:**
- `draft` → deletable, editable, submittable
- `pending_approval` → recallable to `draft`; rejectable to `draft`; approvable to `approved`
- `approved` → advances to `completed` via OTP. Not blocked by `fn_prevent_posted_edit` (only covers `posted`/`cancelled`).
- `completed` → can be queued (`awaiting_payment`) or paid directly (`posted`).
- `awaiting_payment` → can be dequeued back to `completed`; or paid (`posted`).
- `posted` → **IMMUTABLE** (two DB triggers). Corrections only via a reversing Journal voucher — see §4.1 of VOUCHER_WORKFLOW.md.
- `cancelled` → **IMMUTABLE**. DB trigger blocks all UPDATE and DELETE.

---

**Suspense voucher states** (not in the standard CHECK constraint — see Known Gaps §6):

| State | Set by | Code location |
|---|---|---|
| `pending_approval` | `createSuspenseVoucher()` — initial insert | `suspense.ts` |
| `open` | `approveSuspenseVoucher()` — UPDATE WHERE `status='pending_approval'` | `suspense.ts` |
| `rejected` | `rejectSuspenseVoucher()` — UPDATE WHERE `status='pending_approval'` | `suspense.ts` |
| `partial` | `approveSettlement()` — set when `suspense_balance > 0` after settlement approved | `suspense.ts` |
| `closed` | `approveSettlement()` — set when `suspense_balance = 0` | `suspense.ts` |
| `partial` → `open` or `partial` | `addTopUp()` — reopens if was `closed`, adjusts balance | `suspense.ts` |

Suspense vouchers have `voucher_number = 'SUS-DRAFT'` until `approveSuspenseVoucher` generates the real sequence number.

---

### 7.3 OTP-Gated Payment Approval Flow

Payment vouchers (PYMT, RCPT) go through a two-step approval after being submitted to the queue:

**Step 1 — Admin Approval (in `/approvals` UI):**
1. Admin reviews voucher in `ApprovalQueue`
2. Calls `approveVoucher(voucherId, companyId, userId, comments, entityId)`
3. Voucher: `pending_approval → approved`
4. `initiatePaymentOtp()` sends a 6-digit OTP via SMS to payee's registered mobile
5. OTP is bcrypt-hashed; only hash is stored in `pramaana.otp_sessions` (10-min expiry)
6. UI shows masked mobile (e.g. `******1234`) — admin asks payee to read OTP aloud

**Step 2 — OTP Verification (in `/approvals` OTP panel):**
1. Admin receives OTP verbally from payee, enters it in the UI
2. `verifyPaymentOtp(voucherId, plainOtp, verifiedBy)` called
3. `/api/otp` edge function bcrypt-compares against stored hash
4. On match: voucher `approved → completed`; writes `otp_verified_at`, `completed_at`
5. On mismatch: `failed_attempts` incremented; max 3 attempts before session locked

**Security properties:**
- Plain OTP never stored (bcrypt hash only)
- OTP expires after 10 minutes
- Max 3 attempts per session
- `VITE_OTP_INTERNAL_SECRET` header prevents direct calls to `/api/otp` from outside the Vercel deployment

**⚠️ Gap:** Vouchers that don't need OTP (e.g. journal entries, non-payment vouchers) still go through `approveVoucher` which attempts to initiate OTP. If entity has no mobile, `otp_sent=false` is returned but the voucher is still marked `approved`. It cannot reach `completed` without an OTP flow — no bypass exists in current code.

---

### 7.4 Sequence Number Generation

**Function:** `registry.next_fy_sequence` (defined in `002_registry_schema.sql`)

```sql
CREATE OR REPLACE FUNCTION registry.next_fy_sequence(
  p_company_id    UUID,
  p_company_code  TEXT,
  p_prefix        TEXT,
  p_fy_month      INT DEFAULT 4         -- month FY starts (April = 4)
) RETURNS TEXT AS $$
DECLARE
  v_now         DATE := CURRENT_DATE;
  v_year        INT;
  v_fy_short    TEXT;
  v_counter_id  TEXT;
  v_next        INT;
BEGIN
  -- Determine FY start year
  v_year := CASE
    WHEN EXTRACT(MONTH FROM v_now) >= p_fy_month
    THEN EXTRACT(YEAR FROM v_now)::INT
    ELSE EXTRACT(YEAR FROM v_now)::INT - 1
  END;
  -- FY short code: '2526' for FY starting April 2025
  v_fy_short := LPAD((v_year % 100)::TEXT, 2, '0') ||
                LPAD(((v_year + 1) % 100)::TEXT, 2, '0');
  v_counter_id := p_company_code || '_' || p_prefix || '_' || v_fy_short;

  INSERT INTO registry.sequence_counters (id, company_id, prefix, year, last_number)
  VALUES (v_counter_id, p_company_id, p_prefix, v_year, 1)
  ON CONFLICT (id)
  DO UPDATE SET
    last_number = registry.sequence_counters.last_number + 1,
    updated_at  = now()
  RETURNING last_number INTO v_next;

  RETURN p_company_code || '/' || p_prefix || '/' || v_fy_short || '/'
         || LPAD(v_next::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;
```

**Counter row key:** `'{company_code}_{prefix}_{fy_short}'`  
Example: `'RHHF_PYMT_2526'` for RHHF Payment vouchers in FY 2025-26

**Output format:** `'{company_code}/{prefix}/{fy_short}/{NNNN}'`  
Example: `'RHHF/PYMT/2526/0001'`

**FY short code logic:** April to March financial year.  
- If current month ≥ April → FY start year = current year  
- If current month < April → FY start year = current year − 1  
- FY code = `LPAD(year%100,2,'0') || LPAD((year+1)%100,2,'0')`  
  → Year 2025 → `'25'||'26'` = `'2526'`

**Atomicity:** `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING last_number` — single statement, race-condition safe at the DB level.

**Pramaana prefixes in use:**

| Voucher type | Prefix | Example number |
|---|---|---|
| Payment | PYMT | RHHF/PYMT/2526/0001 |
| Receipt | RCPT | RHHF/RCPT/2526/0001 |
| Journal | JNL | RFPL/JNL/2526/0001 |
| Contra | CNTR | RHHF/CNTR/2526/0001 |
| Purchase | PURCH | RHHF/PURCH/2526/0001 |
| Sales | SALE | RFPL/SALE/2526/0001 |
| Suspense advance | (prefix of the selected voucher type, typically PYMT) | RHHF/PYMT/2526/0005 |

**JS call site:**
```typescript
const { data, error } = await supabase
  .schema('registry')
  .rpc('next_fy_sequence', {
    p_company_id:   companyId,
    p_company_code: companyCode,
    p_prefix:       prefix,
  })
```
`p_fy_month` is not passed — defaults to `4` (April).

---

## 8. Public / Unauthenticated Surfaces

### 8.1 Every Route Accessible Without Login

| Route | Component | What it does |
|---|---|---|
| `/relay` | `RelayCapture` | Staff photograph a bill/receipt on their phone and upload it to Supabase Storage via a pre-signed upload URL. The URL is delivered via QR code shown inside the authenticated app (`QRRelayModal.tsx`). The `RelayCapture` page itself has no auth check. |
| `/settle/:token` | `SettleCapture` | Staff submit expense/refund entries against a suspense advance. The token in the URL path is the access credential. Page loads with no auth, calls `getSessionByToken(token)` and `submitExpenseEntry(payload)` — both operate as the Supabase `anon` role. |

Both routes appear in **all three routing branches** in `AppRoutes()`:
```typescript
// Branch 1: not logged in
<Route path="/relay"         element={<RelayCapture />} />
<Route path="/settle/:token" element={<SettleCapture />} />

// Branch 2: logged in, no active company
<Route path="/relay"         element={<RelayCapture />} />
<Route path="/settle/:token" element={<SettleCapture />} />

// Branch 3: fully authenticated
<Route path="/relay"         element={<RelayCapture />} />
<Route path="/settle/:token" element={<SettleCapture />} />
```

### 8.2 `/relay` — Bill Relay Capture

```typescript
// RelayCapture.tsx — core upload call
const { error } = await supabase.storage
  .from('voucher-attachments')
  .uploadToSignedUrl(path, token, file, {
    contentType: file.type || 'image/jpeg',
    upsert: false,
  })
```

`path` and `token` come from URL query params (`?path=&token=`). The signed URL is generated by the authenticated app session and delivered via QR code. Possession of the signed URL is the only access credential. The `anon` role is NOT used here — `uploadToSignedUrl` uses the storage token, not the Supabase auth session. No `pramaana` table is read or written by this page.

### 8.3 `/settle/:token` — Settlement Capture

**anon grants applied by migration 021:**
```sql
GRANT USAGE  ON SCHEMA pramaana                   TO anon;
GRANT SELECT ON pramaana.settlement_sessions       TO anon;
GRANT SELECT ON pramaana.vouchers                  TO anon;
GRANT SELECT, INSERT ON pramaana.suspense_settlements TO anon;
```

**What `anon` can READ:**

| Table | RLS policy | Exact USING condition |
|---|---|---|
| `pramaana.settlement_sessions` | `anon_read_settlement_sessions` | `USING (true)` — no row filter. Any anon request can read any session row. Security relies on token secrecy. |
| `pramaana.vouchers` | `anon_read_suspense_vouchers` | `USING (is_suspense = true)` — only rows where `is_suspense = true` |
| `pramaana.suspense_settlements` | `anon_read_suspense_settlements` | `USING (true)` — no row filter |

**What `anon` can WRITE:**

| Table | RLS policy | Exact WITH CHECK condition |
|---|---|---|
| `pramaana.suspense_settlements` | `anon_insert_suspense_settlements` | `WITH CHECK (EXISTS (SELECT 1 FROM pramaana.settlement_sessions ss WHERE ss.advance_voucher_id = suspense_settlements.advance_voucher_id AND ss.status != 'completed' AND (ss.expires_at IS NULL OR ss.expires_at > NOW())))` |

The guard condition verbatim:
```sql
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM pramaana.settlement_sessions ss
    WHERE ss.advance_voucher_id = suspense_settlements.advance_voucher_id
      AND ss.status            != 'completed'
      AND (ss.expires_at IS NULL OR ss.expires_at > NOW())
  )
);
```

This prevents inserts against arbitrary `advance_voucher_id` values. An anon user can only INSERT a settlement entry if there exists an active (non-completed, non-expired) session linked to that advance voucher.

**What `anon` cannot do:**
- Read `pramaana.ledgers`, `pramaana.ledger_groups`, `pramaana.voucher_entries`, or any other pramaana table (no anon grant)
- Read any `registry` schema table (no anon grant on registry)
- UPDATE or DELETE any pramaana row (no UPDATE/DELETE grant to anon)
- Upload to Storage (no storage policy permits anon uploads; Storage uses signed URLs generated by authenticated sessions)

### 8.4 `getSessionByToken` — Exact Query Sequence (anon)

```typescript
// suspense.ts — called from SettleCapture.tsx with no auth session
export async function getSessionByToken(token: string): Promise<PublicSession | null> {
  const { data: session, error: sErr } = await supabase
    .schema('pramaana')
    .from('settlement_sessions')
    .select('id, company_id, entity_id, total_advance_amount, total_settled_amount, status, advance_voucher_id, expires_at')
    .eq('token', token)
    .maybeSingle()

  if (sErr || !session) return null
  if (session.expires_at && new Date(session.expires_at) < new Date()) return null
  if (!session.advance_voucher_id) return null

  const { data: voucher, error: vErr } = await supabase
    .schema('pramaana')
    .from('vouchers')
    .select('suspense_purpose, amount, suspense_balance, status')
    .eq('id', session.advance_voucher_id)
    .single()

  if (vErr || !voucher) return null
  if (voucher.status === 'closed' || voucher.status === 'rejected') return null

  return { /* PublicSession shape */ }
}
```

Application-layer expiry check: `if (session.expires_at && new Date(session.expires_at) < new Date()) return null` — this is done in JS after the DB read, not in the RLS policy.

### 8.5 `submitExpenseEntry` — Exact Insert (anon)

```typescript
// suspense.ts — called from SettleCapture.tsx with no auth session
export async function submitExpenseEntry(payload: SubmitExpensePayload): Promise<string> {
  const { data, error } = await supabase
    .schema('pramaana')
    .from('suspense_settlements')
    .insert({
      advance_voucher_id:    payload.advance_voucher_id,
      settlement_session_id: payload.session_id,
      company_id:            payload.company_id,
      entity_id:             payload.entity_id,
      advance_amount:        0,
      settled_amount:        payload.amount,
      entry_type:            payload.entry_type,       // 'expense' | 'refund'
      description:           payload.description,
      head_of_account:       payload.head_of_account,
      reference_number:      payload.reference_number,
      invoice_available:     payload.invoice_available,
      status:                'pending',
    })
    .select('id')
    .single()
  if (error) throw new Error('Failed to submit entry: ' + error.message)
  return data.id
}
```

Inserted rows have `status = 'pending'` (pending accounts review). The RLS `anon_insert_suspense_settlements` WITH CHECK guard runs at the DB layer to validate the session is active.
