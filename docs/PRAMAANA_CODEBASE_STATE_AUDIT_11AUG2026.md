# PRAMAANA — CODEBASE STATE AUDIT REPORT

**Date:** 11 August 2026
**Basis:** Live queries against Pramaana DB + RA DB + source code inspection
**Purpose:** Pre-reimport verification. Read-only — no fixes applied during this audit.

---

## SECTION A — Migration/Import Code Paths

### A1 — Every script that has ever written vouchers from RA into Pramaana

**`ra_to_pramaana_migration.py`** (repo root)
- Last modified: **29-Jul-2026 07:19 IST**
- Git status: **never committed** — untracked, local file only
- Scope: **RFPL only** (`company_id = "relish-foods"`, hard-coded)
- Date range: 1-Apr-2026 → 31-Jul-2026 (hard-coded)
- Still runnable: yes, but RFPL only. No RHHF equivalent exists in this repository.

**No RHHF migration script exists in this repository.**
The 423 RHHF vouchers (Apr–Jul 2026) have `ref_document_number = 'RA-VCH-2026-27-NNNNN'` — a format different from RFPL (which uses the raw RA UUID). The script that created those RHHF vouchers was run in a prior session from a codebase or notebook that no longer exists here.

**`scripts/sync_utr.py`**
- Last committed: `a7c50ba` (UTR sprint)
- Writes `utr_number` from RA `payment_reference` into Pramaana `vouchers.utr_number`
- Active and runnable. Last run: 11-Aug-2026 (this session)

### A2 — Every script that has ever imported Tally data into Pramaana

**`tally_xml_import.py`** (repo root)
- Last modified: **30-Jul-2026 16:34 IST**
- Git status: **never committed** — untracked, local file only
- Scope: **RFPL only** (`PM_RFPL_COMPANY_ID` hard-coded)
- Produces vouchers with `ref_document_number = 'Tally-{type}-{seq}'` format
- Status written: directly `posted` (the Tally importer is correct on this point — it does not use `"approved"`)

### A3 — Payee mapping: exact code

`migrate_vouchers()` in `ra_to_pramaana_migration.py` builds this dict for every voucher:

```python
pm_voucher = {
    "id":                  pm_vid,
    "company_id":          PM_COMPANY_ID,
    "voucher_type_id":     vt_ids[v_type],
    "voucher_number":      v["serial_number"],
    "voucher_date":        v_date,
    "narration":           narration,
    "status":              "approved",           # ← see A5
    "payment_mode":        payment_mode_norm,
    "amount":              amount,
    "ref_document_type":   "relish_approvals",
    "ref_document_number": v["id"],              # ← raw RA UUID, not 'RA-' prefix
    "source":              "manual",
    "created_by":          None,
}
```

**`entity_id` (payee) is not in this dict. There is no payee mapping, no name lookup, and no fallback — it silently stays `NULL` on every migrated voucher.**

Confirmed by live query:
- RFPL: 26/1,454 posted have `entity_id` (1.8%) — the 26 are from the Approvals Pay Now flow, not the migration
- RHHF: 0/1,142 have `entity_id` (0%)

### A4 — Bank ledger mapping: exact code

```python
BANK_LEDGER_MAP = {
    "RFPL – Canara Bank (A/C …1375)":    "Canara Bank",
    "RFPL - Canara Bank (A/C ...1375)":  "Canara Bank",
    "Canara Bank":                        "Canara Bank",
    "RFPL – Federal Bank (A/C …4513)":   "Federal Bank",
    "RFPL - Federal Bank (A/C ...4513)": "Federal Bank",
    "Federal Bank":                       "Federal Bank",
    "ICICI - Motty Philip's A/c":        "Motty Philip",
}

# 471 vouchers with null paid_from_account all default to Federal Bank
DEFAULT_BANK_FOR_NULL_ACCOUNT_TRANSFER = "Federal Bank"

def resolve_bank(paid_from_account, payment_mode) -> str | None:
    if payment_mode == "Cash":
        return "Cash"
    if paid_from_account:
        return BANK_LEDGER_MAP.get(paid_from_account)   # exact string match, no fuzzy
    if not paid_from_account:
        return DEFAULT_BANK_FOR_NULL_ACCOUNT_TRANSFER
    return None
```

The resolved bank ledger name is used **only to look up the Cr `ledger_id` in `voucher_entries`**. The `pm_voucher` dict **does not include `bank_ledger_id`**. The `vouchers.bank_ledger_id` column is never written by the migration.

**Confirmed: RFPL has 0/1,454 posted vouchers with `bank_ledger_id`.**

**Critical problem for RHHF reimport:** RHHF's RA data uses `"HDFC No-Lien A/c"` as the `paid_from_account` value. This string is **not in `BANK_LEDGER_MAP`** — it would be unmapped and those vouchers would be skipped entirely. The lost RHHF migration script must have handled this separately.

### A5 — Status mapping: the exact bug

Line ~292 of `migrate_vouchers()`:

```python
pm_voucher = {
    ...
    "status": "approved",   # HARDCODED. Always "approved". No conditional.
    ...
}
```

The RA source fetch includes `status IN ('paid', 'completed', 'approved')`. All three RA statuses produce Pramaana `approved`. There is no rule mapping RA `paid` → PM `posted`.

**Root cause of 423 RHHF vouchers being at `approved` instead of `posted`:**
Every migrated voucher — regardless of RA payment status — is created at `approved`. The intent was that a human would manually advance them through the workflow. The 423 RHHF vouchers were only moved to `posted` on 11-Aug-2026 by a manual batch-post operation in this session.

**Why RFPL's 393 RA-migrated vouchers are currently `posted`:** They were also created at `approved` and batch-posted in a prior session before this audit. The exact date is unknown; no git commit captures it.

---

## SECTION B — Current Data Integrity (live Pramaana DB)

### B1: Payee (`entity_id`) completeness on posted vouchers

| Company | Total Posted | Has `entity_id` | Missing |
|---|---|---|---|
| RFPL | 1,454 | 26 (1.8%) | **1,428 (98.2%)** |
| RHHF | 1,142 | 0 (0%) | **1,142 (100%)** |

### B2: Bank ledger (`bank_ledger_id`) completeness on posted vouchers

| Company | Total Posted | Has `bank_ledger_id` | Missing |
|---|---|---|---|
| RFPL | 1,454 | **0 (0%)** | 1,454 (100%) |
| RHHF | 1,142 | 423 (37%) | **719 (63%)** |

Note: The 423 RHHF with `bank_ledger_id` are vouchers created through the app's Pay Now / OTP flow (where `bank_ledger_id` is set at creation time). The 719 missing are the Tally import, which also does not set this field.

### B3: Balance integrity — Dr ≠ Cr

```
RFPL: ALL BALANCED ✓
RHHF: ALL BALANCED ✓
```

### B4: Status breakdown, both companies

| Company | Status | Count | Date Range | Sum |
|---|---|---|---|---|
| RFPL | posted | 1,454 | 2025-04-05 → 2026-07-27 | ₹57,70,068 |
| RHHF | posted | 1,142 | 2025-04-08 → 2026-07-30 | ₹2,82,65,991 |

No other statuses exist in either company. All vouchers are `posted`.

### B5: Duplicate voucher_number

```
RFPL: NO DUPLICATES ✓
RHHF: NO DUPLICATES ✓
```

### B6: Zero or null amount

```
RFPL: 0 zero/null-amount vouchers ✓
RHHF: 0 zero/null-amount vouchers ✓
```

### B7: `ref_document_number` crosswalk coverage

| Company | Total | `RA-` prefix | Raw RA UUID | `Tally-` style | null |
|---|---|---|---|---|---|
| RFPL | 1,454 | 0 | 393 (`ref_document_type = relish_approvals`) | ~1,036 | 25 |
| RHHF | 1,142 | 423 (`RA-VCH-2026-27-NNNNN`) | 0 | 719 | 0 |

**Two incompatible crosswalk formats are in use across the two companies:**
- RFPL RA-migrated: `ref_document_number = <raw RA UUID>` (e.g. `f8dbab4e-0b9d-4d16-892b-806a5aab3e97`)
- RHHF RA-migrated: `ref_document_number = 'RA-VCH-2026-27-NNNNN'` (e.g. `RA-VCH-2026-27-00478`)

The `sync_utr.py` crosswalk uses the `RA-VCH-` pattern for RHHF but falls back to `voucher_number` matching for RFPL. The two formats must be standardised before any reimport.

### B8: UTR coverage on posted vouchers

| Company | Total Posted | Has UTR | % |
|---|---|---|---|
| RFPL | 1,454 | 87 | 6.0% |
| RHHF | 1,142 | 238 | 20.8% |

---

## SECTION C — Entity/Ledger Foundation

### C1: Ledgers with non-zero opening balances

| Company | Count | Total OB |
|---|---|---|
| RFPL | 92 ledgers | ₹1,68,43,593.00 |
| RHHF | 10 ledgers | ₹19,84,842.72 |

**RFPL sample** (first 20 of 92): A K Musaliyar Constructional Trades (Cr ₹4,319), Abdurahim & Co (Cr ₹17,700), Acer Laptop (Dr ₹22,230), Building (Dr ₹80,150), Car (Dr ₹59,310), Car Loan (Cr ₹91,785), Cash (Dr ₹1,86,500), CGST (Cr ₹3,84,076), Federal Bank, and 82 more.

**RHHF (all 10):** Air Conditioner (Dr ₹37,500), Balachandran Staff (Dr ₹2,000), Cash (Dr ₹11,125), Land Development (Dr ₹1,48,080), Motty Philip Capital (Cr ₹1,00,000), Motty Philip Current (Cr ₹4,11,671), P&L (Dr ₹7,36,233), Rent Advance (Dr ₹25,000), Suspense (Dr ₹22,233), Tarun Philip Capital (Cr ₹4,91,000).

**These are the audited-source baseline. Opening balances live in `ledgers.opening_balance`, not in `vouchers`. A `DELETE FROM vouchers WHERE voucher_date >= '2026-04-01'` will not touch them.**

### C2: Pre-April-2026 RFPL vouchers (Tally FY25-26 import)

```
count = 1,030   min_date = 2025-04-01   max_date = 2026-03-31   total = ₹94,62,169.32
```

These 1,030 vouchers are the Tally FY2025-26 import. (Session memory had noted 1,014 — the live count is **1,030**; the live count is authoritative.) A `WHERE voucher_date >= '2026-04-01'` delete will not touch these. Safe.

### C3: Master data structures

| Structure | RFPL | RHHF |
|---|---|---|
| `ledger_groups` | 3 | 3 |
| `ledgers` | 138 | 74 |
| `voucher_types` (shared) | 6: PYMT, RCPT, JNL, CNTR, PURCH, SALE | same |

These are company-level configurations. A voucher-level reimport does not touch them. Safe.

---

## SECTION D — Approvals (RA) Source Data Readiness

### D1: Payee completeness at source

| Company | Total paid/completed | Has `payee_id` | Missing |
|---|---|---|---|
| RFPL | 590 | **590 (100%)** | 0 |
| RHHF | 636 | **636 (100%)** | 0 |

**Source is complete. The payee gap in Pramaana (Section B1) is entirely a migration script omission — `entity_id` was simply never written.**

### D2: `paid_from_account` values at source — clean mapping analysis

**RFPL (590 paid/completed):**

| Count | `paid_from_account` value | Maps to |
|---|---|---|
| 470 | `null` (mode=Account Transfer) | Federal Bank (default assumption) |
| 68 | `null` (mode=UPI) | Federal Bank (default assumption) |
| 20 | `RFPL – Federal Bank (A/C …4513)` | ✅ Federal Bank |
| 15 | `null` (mode=Cash) | ✅ Cash |
| 7 | `Federal Bank` | ✅ Federal Bank |
| 6 | `RFPL – Canara Bank (A/C …1375)` | ✅ Canara Bank |
| 3 | `ICICI - Motty Philip's A/c` | ✅ Motty Philip |
| 1 | `Canara Bank` | ✅ Canara Bank |

538/590 (91.2%) have `null` `paid_from_account`. The migration defaults all of these to Federal Bank — an assumption hard-coded in the script with a comment: *"Confirmed from Federal Bank statement — all null-bank VCH payments went from A/C 10150200014513."*

**RHHF (636 paid/completed):**

| Count | `paid_from_account` value | Maps to |
|---|---|---|
| 220 | `null` (mode=Account Transfer) | No RHHF `BANK_LEDGER_MAP` exists |
| 212 | `null` (mode=UPI) | No RHHF `BANK_LEDGER_MAP` exists |
| 196 | `HDFC No-Lien A/c` | **❌ UNMAPPED** — wrong string format |
| 5 | `null` (mode=Cash) | — |
| 2 | `ICICI - Motty philip's A/c` | **❌ UNMAPPED** (lowercase 'p') |
| 1 | `HDFC Current A/c` | **❌ UNMAPPED** |

**All 199 explicit `paid_from_account` values for RHHF are unmapped in the current `BANK_LEDGER_MAP`.** Any RHHF migration using the existing script would skip or misroute every one of those 199 vouchers. A RHHF `BANK_LEDGER_MAP` must be written from scratch before reimport.

---

## Consolidated Findings — Reimport Work Order Prerequisites

| # | Finding | Status |
|---|---|---|
| 1 | No RHHF migration script exists in this repo. RHHF crosswalk uses `RA-VCH-NNNNN`; must be reproduced from scratch. | **BLOCKER** |
| 2 | `entity_id` (payee) was never mapped by any migration script. RA source has 100% payee coverage. Gap is 1,428 RFPL + 1,142 RHHF posted vouchers. | **BLOCKER for payee data** |
| 3 | `vouchers.bank_ledger_id` is never written by the migration (only the Cr `voucher_entries.ledger_id` is set). RFPL: 0/1,454. RHHF Tally: 0/719. | **BLOCKER for bank recon** |
| 4 | `status` is hardcoded `"approved"` in `migrate_vouchers()`. All migrated vouchers require a batch-post step after import. | **Known — must be in work order** |
| 5 | RFPL uses raw RA UUID as crosswalk; RHHF uses `RA-VCH-` prefix. Two incompatible formats must be standardised. | **BLOCKER for UTR sync** |
| 6 | 538/590 RFPL RA vouchers have `null` `paid_from_account`; all mapped to Federal Bank by hard-coded assumption in script. | **Assumption — must be validated** |
| 7 | All 199 explicit RHHF `paid_from_account` values are unmapped (`"HDFC No-Lien A/c"` etc.). | **BLOCKER for RHHF reimport** |
| 8 | Pre-Apr-2026 RFPL Tally import is 1,030 vouchers (not 1,014 as previously noted). Live count is authoritative. | **Informational** |
| 9 | Opening balances: RFPL 92 ledgers / ₹1.68 Cr, RHHF 10 ledgers / ₹19.8 L. Date-filtered delete will not touch them. | **Safe ✓** |
| 10 | Master data (ledger_groups, ledgers, voucher_types) will survive reimport untouched. | **Safe ✓** |
| 11 | Dr = Cr on all posted vouchers in both companies. Double-entry is clean. | **Safe ✓** |
| 12 | No duplicate voucher_numbers in either company. | **Safe ✓** |
| 13 | No zero/null amounts in either company. | **Safe ✓** |
