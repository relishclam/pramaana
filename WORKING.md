# WORKING — Schedule III + TDS Reports
> Current features: **Schedule III Financials** + **TDS Reports (Form 26Q)**

---

## Schedule III — Verified: Build Now (no schema changes)

`fetchTrialBalance()` already returns `group_name` + `group_nature`. Schedule III is a
remapping of those groups into the Companies Act format. `buildPLSide()` and `buildBSSide()`
already exist in PLStatement.tsx and BalanceSheet.tsx.

### Group → Schedule III mapping

| Pramaana group | Section | Heading | Sub-heading |
|---|---|---|---|
| Capital Account | equity | Shareholders' Funds | Share Capital |
| Reserves & Surplus | equity | Shareholders' Funds | Reserves and Surplus |
| Loans (Liability) | non_curr_liab | Non-Current Liabilities | Long-term Borrowings |
| Sundry Creditors | curr_liab | Current Liabilities | Trade Payables |
| Current Liabilities | curr_liab | Current Liabilities | Other Current Liabilities |
| Duties & Taxes | curr_liab | Current Liabilities | Other Current Liabilities |
| Provisions | curr_liab | Current Liabilities | Short-term Provisions |
| Suspense Account | curr_liab | Current Liabilities | Other Current Liabilities |
| Fixed Assets | non_curr_asset | Non-Current Assets | Fixed Assets |
| Investments | non_curr_asset | Non-Current Assets | Non-Current Investments |
| Loans & Advances (Given) | non_curr_asset | Non-Current Assets | Long-term Loans & Advances |
| Stock in Hand | curr_asset | Current Assets | Inventories |
| Sundry Debtors | curr_asset | Current Assets | Trade Receivables |
| Cash in Hand | curr_asset | Current Assets | Cash and Cash Equivalents |
| Bank Accounts | curr_asset | Current Assets | Cash and Cash Equivalents |
| Current Assets | curr_asset | Current Assets | Other Current Assets |
| Sales Accounts | revenue | Revenue | Revenue from Operations |
| Other Income | revenue | Revenue | Other Income |
| Purchase Accounts | expense | Expenses | Purchases / Cost of Materials |
| Direct Expenses | expense | Expenses | Manufacturing Expenses |
| Indirect Expenses | expense | Expenses | Other Expenses |

### Files to create
- `src/pages/ScheduleIII.tsx`
- `src/pages/ScheduleIII.module.css`
- Route in App.tsx: `/reports/schedule-iii`
- Nav in REPORT_ITEMS

---

## TDS Reports — Corrected Scope: 3 Steps

### Step 1 — Migration 048 ✅ (fixed with constraints)
Adds `tds_section_code TEXT` to `pramaana.ledgers`.
- Format guard: `~ '^[0-9]{2,3}[A-Z]?[A-Z]?$'` (catches obvious typos, not a closed enum)
- Consistency guard: `is_tds_applicable = true` requires `tds_section_code IS NOT NULL`
- Reverse also blocked: section code on a non-applicable ledger

### Step 2 — Migration 049 ✅ (new: per-transaction TDS table)
Creates `pramaana.voucher_tds_deductions` — one row per payment where TDS is withheld.

| Column | Purpose |
|---|---|
| `voucher_id` | which payment voucher |
| `deductee_entity_id` | registry.entities.id |
| `deductee_name` | captured at deduction time (denormalised) |
| `deductee_pan` | captured at deduction time — PAN can change |
| `section_code` | e.g. `194C`, `194J` |
| `gross_amount` | full invoice/payment before TDS |
| `tds_amount` | actual amount withheld |
| `tds_rate_applied` | effective rate (may differ from standard if lower-deduction cert) |
| `challan_bsr_code` | 7-digit BSR code of bank branch |
| `challan_date` | date TDS deposited to govt |
| `challan_serial` | challan identification number |

Accounts staff fill this in when creating TDS payment vouchers.
Challan columns are filled separately when TDS is deposited to the government (usually 7th of next month).

### Step 3 — TdsReports.tsx (update to use 049 table)
Current TdsReports.tsx infers TDS from voucher_entries — fragile, won't have challan details.
After 049 is applied: rebuild `fetchTdsData()` to query `voucher_tds_deductions` directly.
The report then has per-transaction data, PAN, and challan references for Form 26Q.

### What's NOT built yet (Phase 5+)
- UI to enter/edit `voucher_tds_deductions` rows (currently manual DB insert)
- Challan entry UI for recording TDS deposits to government
- Automated TDS row creation when a payment voucher is submitted

### Step 4 UI design decisions (resolve before building the entry form)

**1. Pre-fill `section_code` from the ledger, never free-type it.**
When accounts enters a TDS deduction row, the `section_code` field must be populated
from `pramaana.ledgers.tds_section_code` of the TDS Payable ledger hit by the voucher.
Free-typing is a data-quality hole: `194J` entered on a `194C` voucher produces a Form 26Q
that doesn't reconcile against the ledger master. The entry UI must look up the ledger's
section code and pre-fill it (editable only for override with a visible warning).

**2. Surface rate-mismatch flag on the TDS report.**
`tds_rate_applied` is allowed to differ from `ledgers.tds_rate` (lower-deduction
certificates, Section 206AB higher rate for non-filers). The TdsReports.tsx table must
show a ⚠ flag on any row where `tds_rate_applied ≠ ledger.tds_rate` so a reviewer
preparing the quarterly return can confirm each non-standard rate is deliberate, not
a data-entry error. Do not silently pass through rate differences.

**3. Challan-complete TDS rows block parent voucher deletion (already in 049 as a trigger).**
Once `challan_date IS NOT NULL`, the deduction is a real-world government-filing fact.
Deleting the parent voucher is blocked by `trg_protect_challan_complete_tds`.
The entry UI should inform accounts staff: *"This voucher has deposited TDS — contact
your CA before attempting to delete it."*

### Apply order
1. Apply 048 in Supabase
2. Apply 049 in Supabase
3. Update TdsReports.tsx to query `voucher_tds_deductions`
4. Add UI to `SimplifiedPaymentEntry.tsx` or separate form for entering TDS deductions
