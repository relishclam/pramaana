# Pramaana — Settlement Module

**Module status:** Backend live (31-Jul-2026) · UI ready for integration
**Applies to:** RFPL and RHHF · schema `pramaana`
**Position:** Core module, alongside Vouchers, Ledgers, and Reports

---

## 1. Purpose

Real-world payments rarely match invoices one-to-one. A single invoice may
be settled by several bank transfers on different dates, less TDS withheld
by the payer, less a monthly advance-deposit rundown. A single bank credit
may span two invoices. The Settlement Module makes this reality first-class:

> **Every settlement must satisfy:**
> `bank lines + TDS + advance recovery = amount applied ≤ open balance`
>
> Applied exactly to zero → invoice **settled**. Applied short → **part_paid**.

It works in both directions:

| Mode | Flow | Party owes | Bank side | TDS side | Advance side |
|---|---|---|---|---|---|
| **Receipt** | Sales → Receipts | Buyer owes us | Dr bank | Dr TDS Receivable | Dr their deposit (liability ↓) |
| **Payment** | Purchase/Salary → Payments | We owe vendor/staff | Cr bank | Cr TDS Payable | Cr advance asset (recovery) |

The user never writes a journal entry. They answer three questions — which
document, what moved through the bank, what was held back — and the module
posts the balanced double-entry through the standard voucher flow.

---

## 2. Data layer

### 2.1 `party_config` — per-party accounting configuration

One row per (company, ledger). Drives Zone B auto-fill.

| Column | Meaning |
|---|---|
| `party_type` | `buyer` \| `vendor` \| `staff` |
| `tds_section_code`, `tds_rate` | e.g. 194I @ 10 (rent), 194C @ 2 (contractor); NULL where slab-based (192 salary) |
| `tds_threshold_annual` | informational threshold |
| `advance_outstanding` | live recoverable balance (module decrements it) |
| `advance_recovery_monthly` | standard monthly deduction |
| `notes` | human context (e.g. deposit breakups) |

Design rule: this is **accounting config, not master data**. Identity stays
in Relish Suite (`public` schema); `party_config` keys off
`pramaana.ledgers` and lives with the books.

### 2.2 `settlement_bank_lines`

One row per bank movement inside a settlement voucher — each keeps its own
`receipt_date`, `amount`, and `bank_reference` (UTR/NEFT). This is what
makes multi-date settlements a single voucher instead of a scatter of
receipts, and it is the future join target for bank-statement import.

### 2.3 `invoice_settlements`

The bill-wise link: (invoice/bill voucher) ↔ (settlement voucher), with the
split `amount_bank + amount_tds + amount_advance` (generated
`amount_total`) and `settlement_status`. One settlement voucher may link to
multiple documents (split receipts) and one document accumulates links
until settled. Outstanding is always derived, never stored:
`document total − Σ settlements`.

---

## 3. Logic layer — four RPCs

### 3.1 Outstanding lookups

- `get_outstanding_invoices(company, party)` — SALE vouchers, party **Dr**
  side, minus settlements. Powers the receipt-mode document dropdown.
- `get_outstanding_bills(company, party)` — PURCH **and JNL** vouchers
  (payroll journals: Dr Salary Expense / Cr Staff), party **Cr** side,
  minus settlements. Powers payment mode.

### 3.2 Atomic posting

- `post_settlement_receipt(...)` → voucher `<CO>/RCPT/<FY>/NNNN`
- `post_settlement_payment(...)` → voucher `<CO>/PYMT/<FY>/NNNN`

Each call, in one transaction:
1. Validates bank lines (> 0), total applied ≤ document open balance,
   advance recovery ≤ `advance_outstanding` (row-locked).
2. Takes the next number from `sequence_counters` (creates the FY row if
   absent). Voucher date = latest bank-line date.
3. Creates the voucher **draft → entries → approved** (required: the
   `prevent_posted_entry_mutation` trigger forbids adding entries to
   `posted` vouchers; `approved` is mutable, `posted` is immutable).
4. Posts the journal (per the direction table in §1) and writes
   `settlement_bank_lines`.
5. Writes the `invoice_settlements` link with `settled`/`part_paid`.
6. Decrements `party_config.advance_outstanding`. When it reaches zero the
   auto-fill stops offering the deduction — recoveries self-terminate.
7. Returns `{voucher_id, voucher_number, total_applied, status, remaining}`.

Hard guards raise exceptions: over-application, advance over-recovery,
TDS/advance amounts without their ledgers.

---

## 4. UI layer

- **`SettlementSheet.tsx`** — one component, `mode="receipt" | "payment"`.
  Every mode difference (RPC names, param keys, date keys, labels) lives in
  a single `MODE` config object; layout, balance bar, guards, and
  auto-fill are shared. Zone A = bank lines (add/remove, per-line
  ledger/date/amount/reference). Zone B = TDS + advance, auto-filled from
  `party_config`, always editable. Balance bar shows Open / Bank /
  Adjusted / Remaining live, with **Fully settled**, **Will post as
  part-paid**, or **Over-applied** (submit blocked) states.
  `tdsBaseDivisor` prop (default 1.18) derives the TDS base from
  GST-inclusive totals; pass 1 for salary journals.
- **`SettlementPage.tsx`** — Receipts-in / Payments-out toggle, ledger
  fetching by group, TDS control ledger selection per mode, advance-ledger
  resolver (known mappings + name-convention fallback).

UI lives in the **Pramaana app**. Relish Suite is untouched.

---

## 5. Worked example — Peninsular Fisheries (the founding case)

Config: TDS 194I @ 10% and advance recovery ₹50,000/mo, **both starting
INV 033 (31-Mar-2026)**. Deposit ₹54L = ₹50L Additional Rent Deposit
(recd 18-Mar-2024, recoverable, 100 months → exhausts ~Jun-2034) + ₹4L
original deposit (permanent security, excluded). FY 25-26 receipts were
pure cash; a one-time FIFO backfill (053) linked them bill-wise —
outstanding after backfill matched the ledger gap **to the rupee**
(₹17,85,846). Tally Journal #348 (deposit adjustment ₹50,000) was
replicated (054) since the FY 25-26 import carried no journals.

INV 033 settlement (₹2,47,800):

| Component | ₹ |
|---|---|
| Canara credit 08-Apr-26 | 1,39,000 |
| Canara credit 25-Apr-26 (part of ₹75,600) | 37,800 |
| TDS 194I (10% × 2,10,000) | 21,000 |
| Advance recovery (via Journal #348) | 50,000 |
| **Total** | **2,47,800** ✓ |

The other ₹37,800 of the 25-Apr credit settles INV 034 — the split-receipt
case, handled natively.

Payment-mode mirror (staff): Jul salary journal Cr Staff ₹40,000 → settle
with bank ₹35,000 + advance recovery ₹5,000 → settled; advance
₹25,000 → ₹20,000; stops automatically at zero.

---

## 6. Roadmap

### 6.1 Challan linking (TDS lifecycle) — connects to the 048–049 TDS schema

`post_settlement_payment` accumulates Cr TDS Payable per section. The
missing lifecycle: **deduct → deposit → file**.

1. On payment posting, also insert a `tds_deductions` row (section, party
   PAN, base, rate, amount, quarter) — a small RPC extension once the
   048–049 column shape is confirmed.
2. Challan entry: government deposit (due 7th of following month) recorded
   with CIN/BSR, Dr TDS Payable / Cr bank, and linked to the deductions it
   covers.
3. Outputs: TDS Payable ageing (deposit-due alerts), quarterly Form
   26Q/24Q export, and on the receipt side, TDS Receivable vs Form 26AS
   reconciliation (Peninsular's deposit dates arrive from their side).

### 6.2 Bank statement import (auto-matching)

The Canara CSV/XLSX formats uploaded 31-Jul-2026 are the exact input.

1. Parse statements (Canara header block + `Txn Date / Description /
   Debit / Credit / Balance` rows; Federal/HDFC parsers same pattern).
2. Identify party from narration (`PENINSULAR FISHERIES…` → party ledger
   via alias map on `party_config`).
3. Propose pre-filled Settlement Sheets: bank line = statement row (date,
   amount, UTR), Zone B from config, FIFO-suggested document allocation.
   Human confirms; nothing auto-posts.
4. Match `settlement_bank_lines.bank_reference` ↔ statement references for
   bank reconciliation: every statement row either matched to a settlement
   or flagged.

### 6.3 Smaller follow-ups

- `default_bank_ledger_id` and `default_advance_ledger_id` columns on
  `party_config` (removes the resolver's name-convention fallback;
  Peninsular defaults to Canara).
- Settlement register report: per-party settlement history with
  bank/TDS/advance splits and ageing of `part_paid` documents.
- Authenticated-role grants/policies once the Pramaana app's auth pattern
  is settled (currently service-role only).

---

## 7. Migration index

| # | File | Contents |
|---|---|---|
| 050 | party_config + settlement tables | Tables, RLS, Peninsular seed |
| 052 | `052_settlement_rpc.sql` | Receipt-side RPCs (`entry_type` 'Dr'/'Cr') |
| 053 | `053_peninsular_billwise_backfill.sql` | One-time FY 25-26 FIFO backfill |
| 054 | Journal #348 replica | Draft→entries→post; advance −₹50K |
| 055 | `055_settlement_payment_rpc.sql` | Payment-side RPCs; `staff` party_type |
