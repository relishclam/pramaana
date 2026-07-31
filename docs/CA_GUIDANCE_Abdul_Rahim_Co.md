# CA Guidance — Relish Foods Pvt Ltd (RFPL)
### Pramaana Accounting System — FY 2025-26 Closing Adjustments
**Addressed to:** Ms. Abdul Rahim & Co, Chartered Accountants  
**Prepared by:** Relish Business Suite — Pramaana Migration Team  
**Date:** 30 July 2026

---

## Background

RFPL's accounts for FY 2024-25 were finalised and under audit in Tally. For FY 2025-26, the company has migrated to **Pramaana**, a cloud-based double-entry accounting system. The following has been completed:

| Item | Status |
|---|---|
| Ledger master setup (136 ledgers) | Done |
| Opening balances (= FY 2024-25 Tally closing balances) | Done — with one known gap (see Section 2) |
| FY 2025-26 transaction vouchers (1,014 vouchers) | Migrated |
| Trial Balance as at 31-Mar-2026 | Shows **"Unbalanced — ₹1,89,260.04"** |

Two CA actions are required to close the books for FY 2025-26.

---

## Action 1 — Correct Opening Balances of Construction Creditors

### What the problem is

When opening balances were entered in Pramaana (representing RFPL's balance sheet as at 31-Mar-2025), the balances for the following construction-related creditor ledgers were entered at their **31-Mar-2026 values** (i.e., what they were after a full year of FY 2025-26 transactions) rather than their **31-Mar-2025 closing values**:

- Mullasseri Hardwares
- S N Timber
- Excel Aluminium
- Thiruvonam Agencies
- *(possibly other construction material suppliers)*

This resulted in the **Credit side of the Opening Balance Sheet being overstated by ₹1,89,260.04**, causing the Trial Balance to show "Unbalanced" by exactly that amount.

### Why this matters

In double-entry bookkeeping, the sum of all opening balances must net to zero (Total Opening Dr = Total Opening Cr). A Cr excess of ₹1,89,260.04 in opening balances means the balance sheet as at 31-Mar-2025 — as entered in Pramaana — does not agree with the audited Tally closing Trial Balance.

This affects:
1. **Trial Balance** — shows "Unbalanced" and cannot be signed off
2. **Balance Sheet** — overstates Current Liabilities by ₹1,89,260.04
3. **Creditor Ledger Statements** — show incorrect opening positions for the affected suppliers

### Why the Auditor must do this

The correct 31-Mar-2025 closing balances for each of these creditors exist only in the **audited Tally FY 2024-25 Trial Balance**, which the CA firm holds and has verified. Any correction to opening balances must trace back to a document the auditor has certified. Entering an incorrect opening balance correction without reference to the audited Tally TB would constitute an unsubstantiated adjustment.

### What we need from you

1. From the **Tally FY 2024-25 Closing Trial Balance**, extract the closing balance (Dr or Cr) as at 31-Mar-2025 for each of the following creditors. If a ledger did not exist in Tally on 31-Mar-2025 (i.e., it was opened during FY 2025-26), its correct opening balance is **₹0**.

   - Mullasseri Hardwares
   - S N Timber
   - Excel Aluminium
   - Thiruvonam Agencies
   - *(any other construction creditor ledger you identify as incorrectly entered)*

2. Confirm that the **total correction = ₹1,89,260.04 Dr** (i.e., the corrected Cr opening balances of these ledgers are collectively ₹1,89,260.04 less than currently entered).

3. Once confirmed, we will update the opening balances in Pramaana via the Ledger master and re-run the Trial Balance, which should then show **"Balanced"**.

> **Note:** This is an opening balance correction in the system master, not a journal entry. No voucher is created. It is the accounting equivalent of correcting the brought-forward balance before any FY 2025-26 transactions.

---

## Action 2 — Year-End Closing Entry: Transfer P&L to Reserve & Surplus

### What the entry is

At the close of every financial year, the balances of all **nominal accounts** (income and expenses) are transferred to the **Profit & Loss Account**, and the resulting net profit or loss is transferred to **Reserve & Surplus**. This is the standard year-end closing entry.

**FY 2025-26 P&L Summary (from migrated Tally vouchers):**

| | Amount |
|---|---|
| Rent Received | ₹24,68,814.00 Cr |
| Round Off | ₹0.64 Cr |
| **Total Income** | **₹24,68,814.64** |
| Building Construction | ₹3,94,412.65 Dr |
| Material Purchase | ₹2,62,660.32 Dr |
| Travelling Expense | ₹1,24,965.45 Dr |
| Petrol & Diesel Charges | ₹1,13,679.26 Dr |
| Tarun Philip Room Rent | ₹1,11,528.00 Dr |
| Insurance | ₹63,991.50 Dr |
| Electricity Charges | ₹49,718.80 Dr |
| Accommodation Expenses | ₹29,086.00 Dr |
| Telephone & Internet | ₹20,919.65 Dr |
| Supermarket Expenses | ₹19,086.54 Dr |
| All other expenses | ₹70,501.79 Dr |
| **Total Expenses** | **₹12,80,548.96** |
| **Net Profit FY 2025-26** | **₹11,88,265.68 Cr** |

**The journal entry to be passed (dated 31-Mar-2026):**

```
Dr  Rent Received                    ₹24,68,814.64
Dr  [All Expense Accounts — each line individually]
    Building Construction                ₹3,94,412.65
    Material Purchase                    ₹2,62,660.32
    Travelling Expense                   ₹1,24,965.45
    Petrol & Diesel Charges              ₹1,13,679.26
    Tarun Philip Room Rent               ₹1,11,528.00
    Insurance                              ₹63,991.50
    Electricity Charges                    ₹49,718.80
    Accommodation Expenses                 ₹29,086.00
    Telephone & Internet Charges           ₹20,919.65
    Supermarket Expenses                   ₹19,086.54
    [Other expenses per detailed ledger]   ₹70,501.79
Cr  Reserve & Surplus                ₹11,88,265.68
```

*(Total Dr = ₹24,68,814.64 = Total Cr ₹12,80,548.96 + ₹11,88,265.68)*

### Why this matters

Without this entry:
1. **Income and Expense ledgers remain open** — their FY 2025-26 balances carry into FY 2026-27, distorting the next year's P&L
2. **Reserve & Surplus does not reflect the FY 2025-26 net profit** — the Balance Sheet as at 31-Mar-2026 will show incorrect retained earnings
3. **The FY 2026-27 opening balance sheet** (which will be set up from the 31-Mar-2026 closing position) will be incorrect unless this entry is present

### Why the Auditor must pass this entry

1. The closing entry crystallises the **audited net profit for FY 2025-26**. The figure of ₹11,88,265.68 should be agreed by the CA based on review of all 1,014 vouchers, verification that all income has been recorded, and confirmation that no expense has been omitted or mis-classified.

2. The entry involves a **credit to Reserve & Surplus**, a Capital Account. Changes to capital accounts require CA sign-off to ensure the balance sheet remains auditable.

3. Once passed, this entry becomes the **basis for the FY 2026-27 opening balance** for Reserve & Surplus. If it is passed incorrectly, the error compounds into the next year.

---

## Summary of CA Actions Required

| # | Action | Trigger | Impact if not done |
|---|---|---|---|
| 1 | Provide 31-Mar-2025 closing balances for construction creditors from Tally FY 2024-25 TB | Immediately | TB remains "Unbalanced ₹1,89,260.04"; Balance Sheet overstates creditors |
| 2 | Review and confirm FY 2025-26 net profit figure (₹11,88,265.68) | After voucher review | — |
| 3 | Pass year-end closing journal entry dated 31-Mar-2026 in Pramaana | After confirmation of net profit | Income/expense accounts remain open into FY 2026-27; R&S incorrect |

---

## Technical Notes for Reference

- **System:** Pramaana (Supabase / PostgreSQL backend)
- **Company ID:** `bc455c94-0bcd-4d66-a040-d29ed880d22f`
- **Vouchers:** All 1,014 FY 2025-26 vouchers are posted and immutable. If any voucher correction is needed, a reversing journal must be passed (the system enforces this by design — posted vouchers cannot be edited).
- **Opening balance corrections** are done via Ledger master → Edit → Opening Balance in the Pramaana UI, or via a SQL UPDATE on `pramaana.ledgers`. Either method is equivalent and does not create a voucher trail.
- **After Action 1**, run Trial Balance "As at 31-Mar-2026" → should show **Balanced**.
- **After Action 2**, re-run Trial Balance → income/expense ledgers should net to zero; R&S should increase by ₹11,88,265.68.

---

*For queries contact the Pramaana system administrator.*
