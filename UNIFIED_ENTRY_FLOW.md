# Pramaana — Unified Entry Flow Design

> **Context:** Analysis of the Purchase/Payment and Sales/Receipt relationship, existing gaps, and a proposed unified UI that captures commercial intent without losing simplicity.
> **Date:** 2026-07-02  
> **Status:** Reviewed — critical issues addressed, open gaps documented, build order set.

---

## 1. Are Sales Linked to Receipts? Are Purchases Linked to Payments?

**Yes — via `pramaana.voucher_allocations` (migration `040_bill_allocations.sql`).**

The pairing is already hardcoded in `SimplifiedPaymentEntry.tsx`:

```ts
const billNature: 'purchase' | 'sales' | null =
  voucherType.nature === 'payment' ? 'purchase' :
  voucherType.nature === 'receipt' ? 'sales' : null
```

When creating a **Payment**, the UI loads open **Purchase** vouchers for that entity.  
When creating a **Receipt**, it would load open **Sales** vouchers.  
`BillAllocPanel` shows them; `saveAllocations()` writes the link to `voucher_allocations`.

### Current State of Each Flow

| Flow | Status |
|---|---|
| Payment → links to an **existing** open Purchase | ✅ Works (`SimplifiedPaymentEntry`) |
| Receipt → links to an existing open Sale | ⚠️ Logic exists in code — but `SimplifiedPaymentEntry` is only rendered for `payment` nature. Receipts still use the full manual double-entry form. |
| Create **new Purchase + Pay it immediately** | ❌ Not supported. Two separate entries required. |
| Create **new Sale + Receive it immediately** | ❌ Same gap. |

---

## 2. The Three Real-World Intents

The tabs **Payment / Purchase / Sales / Receipt** are an *accounting-first* view.  
What data entry staff actually perform maps to exactly **three real-world intents:**

```
INTENT 1 — "I paid someone"
  ├── Against an existing purchase I already booked  →  Allocate against open bill             (works today)
  ├── Invoice just arrived, paying on the spot        →  Create Purchase + Payment linked        (GAP)
  └── Direct payment — no invoice
        ├── Expense (P&L hit immediately)             →  Debit expense ledger                   (works today)
        └── Advance (sits on Balance Sheet until        →  Debit advance/debtor ledger             (GAP — needs sub-branch)
             settled — e.g. travel advance to staff)

INTENT 2 — "I received money"
  ├── Against a sales invoice I already raised        →  Allocate against open sale              (GAP — logic exists, not rendered)
  ├── Cash sale — selling and receiving simultaneously →  Create Sale + Receipt linked            (GAP)
  └── Direct receipt — advance, misc income           →  Receipt only, no sale                   (GAP — Receipt not in SimplifiedPaymentEntry)

INTENT 3 — "Internal or adjustment"
  ├── Journal                                         →  Full double-entry form                  (works today)
  ├── Contra (Cash ↔ Bank)                            →  Full double-entry form                  (works today)
  └── Transfer between bank accounts                  →  Contra under the hood — but label this  (UX gap: staff won't think
                                                          as "Transfer" in the UI gate             "Contra" = bank transfer)
```

---

## 3. Proposed Unified UI Flow

Replace the 4-tab type selector with a **2-button intent gate**, with Journal/Contra falling through to the existing full form.

```
┌─────────────────────────────────────────────────────────────┐
│              What type of entry is this?                    │
│                                                             │
│      [ 💸 Money going OUT ]   [ 💰 Money coming IN ]       │
│                                                             │
│            [ 📒 Journal / Contra / Other ]                  │
└─────────────────────────────────────────────────────────────┘
```

---

### 3.1 Money Going OUT flow

```
Step 1 — Who are you paying?
  ┌──────────────────────────────────────────┐
  │  Entity search  (vendor / staff / govt)  │
  │  or  [ Skip — no party ]  (petty cash)   │
  └──────────────────────────────────────────┘
            │
            ▼
Step 2 — Is there an invoice?
  ┌──────────────────────────────────────────────────────┐
  │  [ Against an existing bill ]      ← BillAllocPanel  │  ← already works
  │  [ New invoice — enter it now ]    ← PROPOSED        │  ← GAP
  │  [ Direct payment — no invoice ]   ← explicit skip   │  ← already works
  └──────────────────────────────────────────────────────┘
            │
            ▼
Step 3 — Amount + expense lines
Step 4 — Which company account? (payment account)
Step 5 — Payment mode (if bank account)
Step 6 — Reference / narration
Step 7 — Attachments
Step 8 — Submit
```

---

### 3.2 Money Coming IN flow

```
Step 1 — Who paid you?
  ┌──────────────────────────────────────────┐
  │  Entity search  (customer / debtor)      │
  │  or  [ Skip — no party ]                 │
  └──────────────────────────────────────────┘
            │
            ▼
Step 2 — Is there an invoice?
  ┌──────────────────────────────────────────────────────┐
  │  [ Against an existing sale ]      ← BillAllocPanel  │  ← needs wiring
  │  [ New sale — enter it now ]       ← PROPOSED        │  ← GAP
  │  [ Direct receipt — no invoice ]   ← explicit skip   │  ← needs wiring
  └──────────────────────────────────────────────────────┘
            │
            ▼
Step 3 — Amount + income lines
Step 4 — Received into which account
Step 5 — Payment mode (if bank account)
Step 6 — Reference / narration
Step 7 — Attachments
Step 8 — Submit
```

---

## 4. What "New Invoice — Enter Now" Creates Atomically

When the user selects **"New invoice — enter it now"**, a single submit action produces:

| # | What is created | Status set to |
|---|---|---|
| 1 | `purchase` voucher (the commercial obligation) | `pending_approval` — approved in the same combined action as the Payment (see policy note) |
| 2 | `payment` voucher (the cash movement) | `pending_approval` → goes through OTP → Pay Now flow as normal |
| 3 | `voucher_allocation` row linking the two | — |

> ⚠️ **Status bug fixed:** An earlier draft set the inline Purchase to `posted` immediately. This was wrong — `posted` is the terminal state only reached after payment is recorded. Using it here would make the Purchase invisible in Day Book, Ledger, Receivables/Payables, and Trial Balance (all filter on `status = 'posted'` for financial reports), while the liability sits live in the DB. Correct status is `pending_approval`, approved as part of the combined action.

This makes it **architecturally impossible to pay without the purchase being recorded**, unless the staff explicitly chooses "Direct payment — no invoice", which forces a conscious acknowledgement of intent.

### Atomicity Requirement

The three writes above **must be wrapped in a single Postgres RPC/transaction** — not sequential client-side calls. If the network drops after the Purchase insert but before the Payment insert, you get an orphaned Purchase voucher sitting in the books as an unlinked liability, silently corrupting Payables. This matters especially here because there is a real time gap between voucher creation and OTP entry during which a partially-complete flow could be abandoned.

Implementation: a single `create_linked_vouchers(purchase_payload, payment_payload)` Postgres function that inserts both vouchers and the allocation row in one transaction, returning both IDs.

> **Scope note (important for the migration comment):** This RPC is intentionally **1:1:1** — one new Purchase, one new Payment, one allocation row. That is correct for this case, because by definition both vouchers are being born together in a single user action. It must not be generalised to accept arrays of purchases or payments — doing so would reintroduce the partial-transaction risk by looping inserts inside the function. Multi-bill allocation (one Payment settling several existing Purchase bills) and installment settlement (one Purchase paid across several Payments over time) both continue to use the existing `BillAllocPanel` → `saveAllocations()` path, which is outside this RPC entirely.

### Approval Policy — Recommendation

**Do not bypass approval for the inline Purchase — but make it a single combined approval action, not two separate queues.**

The concern is segregation of duties. The Purchase approval check ("is this liability legitimate, is the GST correct, is the vendor real?") is independent from the Payment approval check ("are funds available, is the payee correct, does the amount match?"). Auto-approving the Purchase because it is paired with a Payment removes the independent liability check — a fictitious purchase could be entered inline and auto-posted the moment the linked payment clears OTP.

Practical implementation: both the Purchase details and Payment details are shown together on the **same approval screen**. The approver sees the full picture and approves with one OTP. One decision, not two queues, but full visibility.

---

## 5. Code Changes Required

| Change | File(s) | Effort |
|---|---|---|
| Extend `SimplifiedPaymentEntry` to handle `receipt` nature | `src/pages/VoucherEntry.tsx` — change `isPayment` gate to `isPayment \|\| isReceipt` | Small |
| Wire `BillAllocPanel` for receipts (already coded, just not rendered) | `src/pages/VoucherEntry.tsx` | Trivial |
| Make "Direct payment — no invoice" an **explicit** choice rather than a silent skip | `src/pages/SimplifiedPaymentEntry.tsx` | Small |
| Replace 4-tab type selector with 2-button intent gate | `src/pages/VoucherEntry.tsx` render | Medium |
| Add "New invoice — enter it now" branch in bill step | `src/pages/SimplifiedPaymentEntry.tsx` + `src/lib/allocations.ts` — create purchase voucher atomically before submitting payment | Large |
| Wrap Purchase + Payment + allocation creation in a single Postgres RPC | New DB function `create_linked_vouchers()` in a new migration | Large |
| Add "Transfer between accounts" button to intent gate (routes to Contra) | `src/pages/VoucherEntry.tsx` | Small |
| Add Advance vs Expense sub-branch in Direct Payment path | `src/pages/SimplifiedPaymentEntry.tsx` | Medium |

---

## 6. Open Design Issues

### 6.1 Advance vs. Expense in Direct Payment

"Direct expense — salary, wages, travel advance" is currently grouped as one thing. It is not.

| Sub-type | Accounting treatment | Ledger hit |
|---|---|---|
| **Expense** (salary, wages, rent) | Hits P&L immediately | Dr Expense ledger / Cr Bank |
| **Advance** (travel advance, security deposit) | Sits on Balance Sheet as a receivable until adjusted against actual expense bills | Dr Advance/Debtor ledger / Cr Bank |

If the current "Direct payment, no invoice" path always debits an expense ledger, every travel advance overstates expenses and understates receivables. The sub-branch must be explicit before Direct Payment ships.

### 6.2 Partial Allocation (Many-to-Many)

The design does not specify whether:
- One Payment can allocate across **multiple** open Purchase bills (e.g. one cheque settling three invoices)
- One Purchase can be settled in **installments** across multiple Payments

`voucher_allocations` has no constraint preventing either — the table is already many-to-many. `BillAllocPanel` needs to confirm it supports multi-bill allocation in one session (it appears to, based on the `AllocRow[]` array it accumulates), and `fetchOpenBills()` must correctly net out partial allocations already applied.

### 6.3 Failure / Rollback UX

If OTP fails or approval is rejected on the linked Payment, the already-created Purchase voucher stays in `pending_approval`. This is **accounting-correct** — the liability is real regardless of whether the payment cleared — but the UI must be explicit about it. The approver screen should show: *"Rejecting this payment will not remove the purchase voucher. The liability will remain on record."*

If the user abandons mid-flow after the RPC creates both vouchers but before any approval, both vouchers sit in `pending_approval`. The Approvals queue will surface them naturally. No compensating rollback needed — but this should be documented as expected behaviour, not a bug.

### 6.4 Contra / Bank Transfer Discoverability

Contra transactions (cash-to-bank, bank-to-bank transfers) are routed through the "Journal / Contra / Other" button. Data entry staff are unlikely to think of a bank transfer as a journal entry. Recommendation: add a **fourth visible button** on the intent gate — *"🔄 Transfer between accounts"* — that routes to the existing Contra voucher type under the hood. No new accounting logic; purely a UX label change.

### 6.5 Multi-Currency (Deferred — Needs Explicit Note)

The current design assumes all amounts are INR. FoodStream invoices are in HKD. The unified flow does not accommodate:
- Exchange rate capture at transaction date
- Forex gain/loss ledger entries
- Reporting in functional vs. presentation currency

This is deferred, but must be an **explicit note** in the Purchase entry form for foreign-currency entities, not silently assumed to be INR. At minimum, flag the entity's default currency and warn if it differs from the company's functional currency.

---

## 7. Suggested Build Order

1. **Fix the status reference** — `posted` → `pending_approval` in this design doc and in any whiteboard/spec before a single line of code is written. ✅ Done above.

2. **Wire Receipt into `SimplifiedPaymentEntry`** — smallest change, already coded, validates the pattern end-to-end before touching the larger flow. Change `isPayment` gate in `VoucherEntry.tsx` to `isPayment || isReceipt`. Confirm `BillAllocPanel` renders correctly for Sales bills on the Receipt path.

3. **Make "Direct payment — no invoice" an explicit choice** — add the Advance vs. Expense sub-branch. This affects Balance Sheet accuracy immediately on every salary/advance entry, not just in the new unified flow.

4. **Build the Postgres `create_linked_vouchers()` RPC** — wrap Purchase + Payment + allocation in one transaction. Write this before the UI branch that calls it, so the atomicity is guaranteed from day one.

5. **Add "New invoice — enter it now" branch** — the largest change. Now the RPC exists, the UI step can call it safely. Combined approval screen shows both voucher details together. One OTP, full visibility.

---

## 8. Why This Matters for Financial Accuracy

| Without unified flow | With unified flow |
|---|---|
| Data entry staff can create a Payment and forget to raise the Purchase | Impossible — intent is gated upfront |
| Receipt entered without a corresponding Sale → receivable never closed | Receipts go through the same guided flow |
| GST on purchases may be missed if Purchase voucher is skipped | Inline purchase capture includes GST quick-add |
| `voucher_allocations` stays empty → Receivables/Payables reports show wrong outstanding | Every payment/receipt is either allocated or explicitly marked as direct |

The `Receivables/Payables` report (`src/pages/ReceivablesPayables.tsx`) and `Outstanding` columns in `fetchOpenBills()` are only as accurate as the allocation data. The unified flow makes correct allocation the **default path**, not an optional extra step.
