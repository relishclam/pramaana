# Pramaana Full Reimport Work Order
**Date:** 12-Aug-2026  
**Scope:** RFPL + RHHF — full history from 1-Apr-2025, one unified script  
**Repo:** relishclam/pramaana  
**DB:** Supabase project `mmkbknnzgpvsqgnynrbe` (schema: `pramaana`)  
**RFPL company_id:** `bc455c94-0bcd-4d66-a040-d29ed880d22f`  
**RHHF company_id:** `b8beb440-df7f-48e8-a012-ac5750502eca`

---

## Context & Key Principle

Pramaana is NOT the source of truth — it is being CONFIGURED to become one.  
Real sources of truth are:
1. **Bank statements** (Canara + Federal for RFPL; HDFC for RHHF)
2. **Relish Approvals** (RA) — the payment pipeline
3. **Tally** — the historical accounting record

Every number in Pramaana must trace back to and be verified against these three. Never assume a figure is correct because it already sits in Pramaana's DB.

---

## Why a Full Reimport?

A codebase audit (11-Aug-2026) found these bugs in the existing migration scripts:

**A3 — Payee (entity_id) never mapped:** `entity_id` was never in the migration dict. RA has 100% payee coverage (590/590 RFPL, 636/636 RHHF) but the field was never written. Zero source-data problem — 100% script omission.

**A4 — bank_ledger_id never written:** `vouchers.bank_ledger_id` column is never populated by migration. RHHF `BANK_LEDGER_MAP` doesn't cover any of RHHF's real account name strings (case mismatch, spacing differences) — would skip/misroute all explicit-account RHHF vouchers.

**A5 — Status hardcoded wrong:** `migrate_vouchers()` hardcodes `status="approved"` always. Every migrated voucher required a manual batch-post. RFPL's 393 RA vouchers were batch-posted in an untracked prior session.

**A6 — Two incompatible crosswalk formats:** RFPL `ref_document_number = raw RA UUID`; RHHF `= 'RA-' + serial_number`. The UTR sync script handles both differently — must be standardised.

**A7 — RHHF migration script lost:** The script that created RHHF's 423 vouchers no longer exists in the repo. Cannot patch what isn't there.

**A8 — Unverified Federal Bank default:** 538/590 RFPL RA vouchers have null `paid_from_account`, all defaulted to Federal Bank via a hardcoded comment. Must be re-verified against actual statement data, not blindly carried forward.

**Corrected counts:** RFPL FY25-26 Tally import is 944 rows (not 1,014 or 1,030 as previously noted). RFPL opening: 92 ledgers. RHHF opening: 73 ledgers. Both confirmed SAFE from any `voucher_date`-filtered delete.

---

## Source File Inventory

All files have been verified (12-Aug-2026). Use the paths below exactly.

### RFPL Sources

| File | Upload Path | Rows | Date Range | Notes |
|---|---|---|---|---|
| Tally Canara Bank Book | `Tally-RFPL-_April_1__2025_to_March_31__2026.xls` | 944 | 01-Apr-2025 → 31-Mar-2026 | Header at row 5; cols: Date, Particulars, Unnamed:2–4, Vch Type, Vch No., Debit, Credit |
| RA Vouchers (all) | `All_Vouchers_2025-04-01_to_2026-08-11.xlsx` | 600 total (FY25-26: 166, FY26-27: 434) | Feb-2026 → Aug-2026 | Earliest RA in RFPL is Feb 2026 — Apr-Jan covered by Tally only |
| Canara Statement 1 | `Canara-Apr_2025_-_Oct_2025.csv` | 496 | 01-Apr-2025 → 01-Oct-2025 | Header at row 26; cols: Txn Date, Value Date, Cheque No, Description, Branch Code, Debit, Credit, Balance |
| Canara Statement 2 | `Canara-Oct_2025_-_Mar_2026.csv` | 462 | 01-Oct-2025 → 31-Mar-2026 | Same format |
| Canara Statement 3 | `Canara-April_2026_-_Aug_2026.csv` | 400 | 01-Apr-2026 → 08-Aug-2026 | Same format |

> ⚠️ **Canara CSV warning:** Three older files with swapped/wrong filenames also exist in uploads. Identify Canara files by scanning actual `Txn Date` content, not filename. The corrected files listed above are authoritative.

**RFPL Opening Balance anchor (31-Mar-2025, AUDITED — Abdul Rahim & Co, signed 14-Nov-2025):**
- Peninsular Fisheries receivable: ₹10,68,100
- TDS Receivable: ₹2,28,771 (Note 2.14: ₹228.77 thousands)
- Rent Deposit (Peninsular): ₹54,00,000 (Note 2.6: ₹5,400 thousands)
- Canara Bank: ₹170 (Note 2.12: ₹0.17 thousands)
- Tarun Philip (Short-term loans): ₹2,37,890 (Note 2.13: ₹237.89 thousands)

### RHHF Sources

| File | Upload Path | Rows | Date Range | Notes |
|---|---|---|---|---|
| HDFC Current FY25-26 | `RHHF_-_April_01__2025_to_Mar_31__2026-Current_Acc.xlsx` | 337 | 05-Nov-2025 → 31-Mar-2026 | Header at row 7; pre-Nov 2025 = pre-operational, no gap; cols: Date, Particulars, Unnamed:2–4, Vch Type, Vch No., Debit, Credit |
| HDFC Current FY26-27 | `RHHF_-_April_2026_to_July_2026_-_HDFC_Current_Ac.xlsx` | 19 | 01-Apr-2026 → 25-Jul-2026 | Same format; row 0 = Opening Balance ₹2,64,563.47 (use as RHHF Phase 5 anchor) |
| HDFC No-Lien | `HDFC_No_Lien-1st_Jan-31st_March_2026.xls` | 263 (excl. 2 footer rows) | 09-Jan-2026 → 31-Mar-2026 | Header at row 7; filter `year > 2020` — 2 footer rows parse as 1970-01-01, discard; cols: Date, Particulars, Unnamed:2, Vch Type, Vch No., Debit, Credit |
| Cash Book | `RHHF_Tally-Cash.xls` | 35 | 01-Apr-2025 → 31-Mar-2026 | Header at row 6 |
| RA Vouchers (all) | `All_Vouchers_2025-11-01_to_2026-08-11.xlsx` | 647 total (FY24-25: 3, FY25-26: 165, FY26-27: 479) | Jan-2026 → Aug-2026 | 3 FY24-25 vouchers have date Jan-2026 — number-series anomaly, include as-is |

**RHHF Opening Balance anchor (31-Mar-2025, UNAUDITED — Antony Malayil & Co, provisional):**
- Source: Tally TB as at 31-Mar-2025 (73 ledgers, ₹16.7L Dr excess noted at setup)
- The TB line-item file is NOT in this session — Phase 5 RHHF verification uses the HDFC Current FY26-27 opening balance row (₹2,64,563.47 on 01-Apr-2026) as the bank-side anchor instead

### Audited Financial Statements (RFPL FY24-25)
- `Audit_Report-FY2024-2025.pdf` — Independent Auditor's Report, Abdul Rahim & Co, UDIN 26028189NDRGEM7074
- `Audited_FinStatements-FY2024-2025.pdf` — Full financial statements including BS, P&L, notes
- These are the authoritative source for all RFPL opening balance figures above

---

## The Five-Phase Pipeline

### Phase 1 — Extract (READ-ONLY, SAFE TO RUN NOW)

Parse all source files into a canonical in-memory data structure. No DB writes.

**Output format per voucher:**
```python
{
  "company": "RFPL" | "RHHF",
  "source": "tally" | "ra",
  "voucher_number": str,           # from source
  "voucher_date": date,
  "payee_name": str,               # raw string from source
  "payee_entity_id": UUID | None,  # resolved in Phase 2
  "amount": Decimal,
  "payment_mode": str,
  "paid_from_account": str | None, # raw account string from RA
  "bank_ledger_id": UUID | None,   # resolved in Phase 2
  "utr_number": str | None,        # from RA payment_reference
  "ra_uuid": str | None,           # RA's internal UUID (for crosswalk)
  "ra_serial": str | None,         # RA's serial_number (for RHHF crosswalk)
  "status": "paid" | "rejected" | "draft",
  "head_of_account": str,
  "sub_head": str,
  "narration": str,
}
```

**Tally extraction rules:**
- Read with pandas using the header rows specified in the Source File Inventory above
- `To` rows = Debit (money in); `By` rows = Credit (money out)
- `Particulars` + `Unnamed:2` concatenated = payee name (Unnamed:2 is the sub-detail line)
- `Vch Type` + `Vch No.` = Tally voucher reference
- Rows with null Date = continuation lines of the previous dated row — attach to parent
- Filter out rows where `Vch Type` is `Contra` (these are cash↔bank transfers, not payments)

**RA extraction rules:**
- Only import `status == "paid"` vouchers (exclude `rejected`, `draft`)
- `Voucher No.` is the source voucher number
- `Payment Mode` maps: `Account Transfer` → bank; `UPI` → bank; `Cash` → cash
- `Invoice Ref` = the invoice this payment relates to (if populated)
- RA UUID is in the `Voucher No.` field indirectly — the actual UUID comes from the RA DB crosswalk built in Phase 2

**Tally/RA overlap logic (critical):**
- RFPL RA starts Feb-2026. Tally covers Apr-2025 → Mar-2026. Overlap period = Feb-2026 → Mar-2026.
- In the overlap period, Tally and RA may record the same payment. Deduplicate by: match on (amount ± ₹1, date ± 3 days, payee fuzzy match). If matched = one voucher, use RA as authoritative (has payee entity, UTR). If Tally-only = import from Tally. If RA-only in overlap = import from RA.
- RHHF: RA starts Jan-2026. Tally covers Apr-2025 → Mar-2026 (via HDFC Current + No-Lien + Cash). Same overlap logic applies Jan-2026 → Mar-2026.

**Phase 1 deliverable:** Print a summary report:
```
RFPL: N Tally rows extracted, M RA rows extracted, K overlaps detected
RHHF: N Tally rows extracted, M RA rows extracted, K overlaps detected
Total vouchers for import: XXXX
```
Stop here and show the report. Do not proceed to Phase 2 without confirmation.

---

### Phase 2 — Validate

**2.1 Payee resolution (fixing bug A3)**

Build entity lookup table from `registry.entities` (Relish Suite DB):
```sql
SELECT e.id, e.display_name, e.legal_name, e.alias
FROM registry.entities e
JOIN registry.entity_roles er ON er.entity_id = e.id
WHERE er.role IN ('vendor', 'supplier', 'contractor', 'customer', 'employee', 'partner')
```

For each extracted voucher:
- Exact match on `display_name` or `alias` → assign `entity_id`
- Fuzzy match (threshold 85%) → flag for review, show match candidate
- No match → flag as `UNRESOLVED_PAYEE`, do not block import (will import with null entity_id, fixable post-import)

Report: N resolved exact, M resolved fuzzy (list them), K unresolved (list payee names).

**2.2 Bank ledger resolution (fixing bug A4)**

Build bank ledger map from `pramaana.ledgers`:
```sql
SELECT id, name FROM pramaana.ledgers 
WHERE is_bank_account = true AND entity_id IN (RFPL_UUID, RHHF_UUID)
```

Map payment source → ledger_id:

For RFPL:
- `paid_from_account` contains "Federal" or account "4513" → Federal Bank ledger
- `paid_from_account` contains "Canara" or "1375" → Canara Bank ledger
- `paid_from_account` contains "ICICI" → ICICI ledger (if exists)
- `payment_mode == "Cash"` → Cash ledger
- null `paid_from_account` + `payment_mode == "Account Transfer"` → **DO NOT default to Federal**. Flag as `UNRESOLVED_BANK`. Verify against Canara statement: if amount+date match found in Canara CSV → assign Canara. If found in Federal statement (if available) → assign Federal. If neither → leave null, flag for manual review.
- Tally vouchers: derive from which Tally book the row came from (HDFC Current → HDFC Current ledger; No-Lien → HDFC No-Lien ledger; Canara book → Canara ledger; Cash → Cash ledger)

For RHHF:
- Exact string match (case-insensitive, strip whitespace): "HDFC Current A/c", "HDFC Current Account", "HDFC No Lien", "HDFC No-Lien A/c" → respective ledgers
- "ICICI" or "Motty" in account string → Motty ICICI ledger
- Cash → Cash ledger

Report: N resolved, M unresolved (list them with amounts).

**2.3 Status mapping (fixing bug A5)**
- RA `status == "paid"` → Pramaana `status = "posted"` (not "approved")
- Tally vouchers → `status = "posted"`

**2.4 Crosswalk standardisation (fixing bug A6)**

Going forward, ONE format: `ref_document_number = 'RA-' + ra_serial_number` for both RFPL and RHHF.
- RFPL currently has raw UUID format → the UTR sync script already handles both; Phase 2 standardises the new import to use the serial format.

**2.5 Amount validation**
- Every voucher must have `amount > 0`
- Sum all RFPL vouchers Dr side, verify roughly matches Tally closing balance
- Sum all RHHF vouchers, verify roughly matches HDFC closing balance

**Phase 2 deliverable:** Validation report with all flags. Show to Motty before proceeding. Do not proceed to Phase 3 without sign-off on unresolved payees and unresolved banks.

---

### Phase 3 — Transform

Build the final insert payload for each voucher:

```python
{
  # pramaana.vouchers
  "id": uuid4(),
  "company_id": RFPL_UUID | RHHF_UUID,
  "voucher_number": str,           # preserve source number
  "voucher_date": date,
  "voucher_type_id": UUID,         # resolve from pramaana.voucher_types by name
  "entity_id": UUID | None,        # from Phase 2.1
  "amount": Decimal,
  "status": "posted",              # always posted (fixes A5)
  "source": "tally" | "ra",
  "narration": str,
  "bank_ledger_id": UUID | None,   # from Phase 2.2 (fixes A4)
  "utr_number": str | None,
  "ref_document_number": str,      # 'RA-' + serial (fixes A6)
  "paid_from_account": str | None,

  # pramaana.voucher_entries (two rows per voucher minimum)
  "entries": [
    {"ledger_id": expense_ledger_id, "entry_type": "Dr", "amount": Decimal},
    {"ledger_id": bank_ledger_id,    "entry_type": "Cr", "amount": Decimal},
  ]
}
```

**Ledger resolution for expense side:**
- Map `head_of_account` + `sub_head` from RA → `pramaana.ledger_groups` → `pramaana.ledgers`
- Tally `Particulars` → fuzzy match to existing ledger names
- Unresolved → assign to Suspense ledger, flag for manual reclassification

**Phase 3 deliverable:** Print transform summary. Show first 10 rows of payload for Motty to eyeball. Confirm before Phase 4.

---

### Phase 4 — Load (DESTRUCTIVE — REQUIRES EXPLICIT GO-AHEAD)

> ⚠️ **STOP. Do not execute Phase 4 without Motty explicitly typing "proceed with Phase 4 delete" in this session. Prior approval from a previous session does NOT carry over.**

**Delete scope** — vouchers only, opening balances and master data untouched:
```sql
-- RFPL: delete all vouchers dated >= 2025-04-01
DELETE FROM pramaana.voucher_entries 
WHERE voucher_id IN (
  SELECT id FROM pramaana.vouchers 
  WHERE company_id = 'bc455c94-0bcd-4d66-a040-d29ed880d22f'
  AND voucher_date >= '2025-04-01'
);
DELETE FROM pramaana.vouchers
WHERE company_id = 'bc455c94-0bcd-4d66-a040-d29ed880d22f'
AND voucher_date >= '2025-04-01';

-- RHHF: same
DELETE FROM pramaana.voucher_entries 
WHERE voucher_id IN (
  SELECT id FROM pramaana.vouchers 
  WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
  AND voucher_date >= '2025-04-01'
);
DELETE FROM pramaana.vouchers
WHERE company_id = 'b8beb440-df7f-48e8-a012-ac5750502eca'
AND voucher_date >= '2025-04-01';
```

Also reset settlement tables:
```sql
DELETE FROM pramaana.invoice_settlements WHERE TRUE;
DELETE FROM pramaana.recon_matches WHERE TRUE;
```

Then insert the Phase 3 payload in batches of 100.

**After insert:** Re-run the batch-post RPC to set all new vouchers to `status = 'posted'` (the insert sets them posted directly, but run the RPC as a safety check).

---

### Phase 5 — Verify

**5.1 Trial Balance check**
```sql
SELECT 
  SUM(CASE WHEN entry_type = 'Dr' THEN amount ELSE 0 END) as total_dr,
  SUM(CASE WHEN entry_type = 'Cr' THEN amount ELSE 0 END) as total_cr,
  SUM(CASE WHEN entry_type = 'Dr' THEN amount ELSE 0 END) -
  SUM(CASE WHEN entry_type = 'Cr' THEN amount ELSE 0 END) as difference
FROM pramaana.voucher_entries ve
JOIN pramaana.vouchers v ON v.id = ve.voucher_id
WHERE v.company_id = '<company_id>'
AND v.status = 'posted';
```
Expected: difference = 0 (or equals opening balance Dr excess for RHHF).

**5.2 Bank ledger reconciliation**
For RFPL Canara: sum all Cr entries on Canara ledger, compare to sum of Canara CSV Credits. Tolerance ±₹100.

For RHHF HDFC Current: closing balance in Tally FY26-27 file row 0 shows ₹2,64,563.47 on 01-Apr-2026. Verify HDFC Current ledger closing balance matches.

**5.3 Opening balance anchor check (RFPL)**
From the audited BS (31-Mar-2025):
- Peninsular ledger opening: ₹10,68,100 Cr
- TDS Receivable opening: ₹2,28,771 Dr
- Rent Deposit opening: ₹54,00,000 Cr
- Canara Bank opening: ₹170 Dr
- Tarun Philip opening: ₹2,37,890 Dr

Query each ledger's `opening_balance` + `opening_dr_cr` and confirm. These are set in ledger master data and should be untouched by the reimport.

**5.4 Voucher count spot-check**
- RFPL: expect ~944 (Tally) + ~166 (RA FY25-26) + ~434 (RA FY26-27) minus overlaps
- RHHF: expect ~337+19+263+35 (Tally) + ~647 (RA) minus overlaps

**5.5 Payee coverage**
```sql
SELECT 
  COUNT(*) as total,
  COUNT(entity_id) as with_entity,
  COUNT(*) - COUNT(entity_id) as missing_entity
FROM pramaana.vouchers
WHERE company_id = '<company_id>'
AND status = 'posted'
AND voucher_date >= '2025-04-01';
```
Target: >90% coverage. List the missing ones for manual follow-up.

**5.6 Bank ledger coverage**
```sql
SELECT 
  COUNT(*) as total,
  COUNT(bank_ledger_id) as with_bank,
  COUNT(*) - COUNT(bank_ledger_id) as missing_bank
FROM pramaana.vouchers
WHERE company_id = '<company_id>'
AND status = 'posted'
AND voucher_date >= '2025-04-01';
```
Target: >85% coverage.

---

## Standing Rules for Claude Code

1. **Step-by-step execution with per-step confirmation.** Do not run Phase N+1 until Motty confirms Phase N output.
2. **Verify fixes via actual query results, not commit messages.** Several past "fixed" commits didn't land.
3. **No silent `.catch(() => [])` on data fetches.** Errors must surface.
4. **Schema assumptions must be verified against live `information_schema`.** Do not assume column names.
5. **Pramaana and Approvals are separate DBs.** One-way historical migrations only, never write back to Approvals.
6. **Pre-1-Apr-2026 Pramaana data in the ledger master (openings) is audited-BS-sourced and untouchable.** The delete scope is vouchers only, dated >= 2025-04-01.
7. **Phase 4 delete requires Motty to explicitly say "proceed with Phase 4 delete" in the current session.** No assumed carry-over from prior sessions.
8. **The trigger `fn_prevent_posted_edit` (not `fn_prevent_posted_voucher_update`) blocks updates on posted vouchers.** If any post-insert update is needed, DISABLE/ENABLE TRIGGER USER on the specific table — never ALL.
9. **`utr_number` is exempt from the posted-edit trigger** (migration 077 was applied 8-Aug-2026). The UTR sync script `scripts/sync_utr.py` is idempotent — re-run it after reimport.
10. **Sequence counters** live in `registry.sequence_counters` keyed by text ID (e.g. `RFPL_RCPT_2627`), with `year` as INTEGER and `last_number` as INTEGER. FY year is derived from `CURRENT_DATE`, not `voucher_date`.

---

## Key Entity & Ledger IDs (do not hardcode others without verifying)

```
RFPL company_id:       bc455c94-0bcd-4d66-a040-d29ed880d22f
RHHF company_id:       b8beb440-df7f-48e8-a012-ac5750502eca
Peninsular entity:     190921c6-9b3c-42ed-abc6-f8ae316c11c3
Peninsular ledger:     74ecf056-0658-4193-8ec5-6b4802e016e0
FoodStream ledger:     9d430192-1845-414d-8d2e-50031a0943dd
Rent Deposit ledger:   1b955279-...  (verify from DB — used in Advance Outstanding fix)
P&L residual ledger:   8c7c0e48-5d4b-45c4-8623-e216d405d11a
```

All other IDs must be queried live from the DB before use.

---

## Post-Reimport Tasks (after Phase 5 passes)

1. Re-run `scripts/sync_utr.py` — repopulates `utr_number` on all reimported vouchers from the Approvals crosswalk
2. Re-run bank recon match engine on Federal + Canara (RFPL) and HDFC (RHHF)
3. Rebuild Peninsular settlement chain (RCPT/2627/0001–0010) — verify all still posted and settlement amounts correct
4. Verify July 2026 invoice (SALE/2627/0006, ₹2,60,190) settlement status
5. Fix `get_outstanding_invoices` RPC — currently computes from voucher_entries only, omits `ledgers.opening_balance` (causes ₹42,446 display residual on RCPT/0009)
6. Backfill `settlement_narration` UUID→voucher_number (9 receipts have UUID in narration instead of voucher number)
