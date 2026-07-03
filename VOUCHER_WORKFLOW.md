# Pramaana — Voucher Lifecycle & Pay Now Workflow

> Single source of truth for voucher states, transitions, roles, and the full Pay Now / UPI payment flow.
> Last updated: 2026-07-03

---

## 0. User Manual — Pramaana Voucher Entry

Practical reference for data entry staff. Each scenario shows the exact ledger rows to enter.

---

### 0.1 Accounting Rules You Must Know

| Rule | What it means in practice |
|---|---|
| **Dr = Cr always** | Every voucher must balance. The "Balanced ✅" indicator must be green before you can submit. |
| **Income ledger = taxable value** | Never put the GST-inclusive total into a Sales / Income ledger. Only the amount before GST goes there. |
| **GST Payable ≠ GST Input Credit** | Sales vouchers → CGST/SGST **Payable** (liability). Purchase vouchers → CGST/SGST **Input Credit** (asset). Using the wrong ledger silently mis-states both your tax liability and your ITC balance. |
| **TDS is a receivable, not an expense** | When a customer deducts TDS, the withheld amount is RFPL's advance tax paid to the government. Book it as `TDS Receivable` (asset), not as a loss. |
| **Security deposits are liabilities** | Deposits received from tenants are refundable. They go to a Liability ledger, not to income. |

---

### 0.2 Approval Flow by Voucher Type

| Voucher type | On admin approval | OTP sent? | Moves to Payments page? |
|---|---|---|---|
| **Payment** | Status → Awaiting OTP | ✅ Yes — to payee's mobile | ✅ Yes, after OTP verified |
| **Receipt** | Status → Posted immediately | ❌ No | ❌ No |
| **Sales** | Status → Posted immediately | ❌ No | ❌ No |
| **Purchase** | Status → Posted immediately | ❌ No | ❌ No |
| **Journal** | Status → Posted immediately | ❌ No | ❌ No |
| **Contra** | Status → Posted immediately | ❌ No | ❌ No |

---

### 0.3 GST Ledger Reference

Create these six ledgers once. Tag each with `is_tax_ledger = true` and the matching `tax_type`.

| Ledger name | Group | Nature | tag | Used on |
|---|---|---|---|---|
| CGST Payable | Duties & Taxes | LIABILITY | `CGST` | Sales vouchers |
| SGST/TNGST Payable | Duties & Taxes | LIABILITY | `SGST` | Sales vouchers |
| IGST Payable | Duties & Taxes | LIABILITY | `IGST` | Sales vouchers (inter-state) |
| CGST Input Credit | Current Assets | ASSET | `CGST` | Purchase vouchers |
| SGST Input Credit | Current Assets | ASSET | `SGST` | Purchase vouchers |
| IGST Input Credit | Current Assets | ASSET | `IGST` | Purchase vouchers (inter-state) |

> **⚡ GST Quick-Add** auto-fills these rows once the ledgers are tagged. It finds any ledger with the matching `tax_type`. Create both sets (Payable + Input Credit) so the right one appears depending on context.

---

### 0.4 Scenario A — Sales Invoice with GST (Intra-state)

**Example:** RFPL issues lease rent invoice INV 036 to Peninsular Fisheries Pvt Ltd.  
Taxable value ₹2,10,000 · CGST 9% · SGST 9% · Invoice total ₹2,47,800

**Voucher type:** Sales  
**Entry method:** Full double-entry form → ⚡ GST Quick-Add → add Bank row manually

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Peninsular Fisheries (Debtor) | 2,47,800 | — | Sundry Debtors group |
| 2 | Lease Rent Income | — | 2,10,000 | Taxable value only |
| 3 | CGST Payable | — | 18,900 | Auto-filled by GST Quick-Add |
| 4 | SGST/TNGST Payable | — | 18,900 | Auto-filled by GST Quick-Add |
| **Total** | | **2,47,800** | **2,47,800** | ✅ Balanced |

> If Peninsular pays in the same transaction (cash sale): replace row 1 with `Dr Canara Bank ₹2,47,800` and skip the Receipt step.

---

### 0.5 Scenario B — Receipt of Lease Rent (with TDS & Deposit Deduction)

**Example:** Peninsular settles INV 036.  
- Invoice: ₹2,47,800  
- TDS deducted @ 10% on taxable value: ₹21,000  
- Monthly deposit deduction: ₹21,000  
- **Net cash received: ₹2,05,800**

**Voucher type:** Receipt  
**Entry method:** Full double-entry form (5 legs — do not use Simplified form)

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Canara Bank | 2,05,800 | — | Actual cash received |
| 2 | TDS Receivable — Sec 194I | 21,000 | — | RFPL's advance tax credit |
| 3 | Security Deposit — Peninsular | 21,000 | — | Monthly adjustment of deposit |
| 4 | Peninsular Fisheries (Debtor) | — | 2,47,800 | Closes the Sales voucher receivable |
| **Total** | | **2,47,800** | **2,47,800** | ✅ Balanced |

> Use **BillAllocPanel** (Bill Step) to link this Receipt to the open Sales invoice (INV 036). This closes the outstanding balance in the Receivables report.

---

### 0.6 Scenario C — Receiving a Security Deposit (one-time)

**Example:** Peninsular pays ₹2,10,000 security deposit at lease start.

**Voucher type:** Receipt → Direct receipt — no invoice  
**Bill Step:** Choose **⏳ Advance received — to settle later**

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Canara Bank | 2,10,000 | — | Cash received |
| 2 | Security Deposit — Peninsular | — | 2,10,000 | Liability — refundable at lease end |
| **Total** | | **2,10,000** | **2,10,000** | ✅ Balanced |

> Security Deposit ledger should be under **Current Liabilities** (if lease < 12 months) or **Long-term Liabilities** (if > 12 months).

---

### 0.7 Scenario D — Outward Payment to Vendor (with OTP)

**Example:** RFPL pays freight charges to ABC Logistics ₹15,000 cash.

**Voucher type:** Payment  
**Entry method:** Simplified Conversational Form → Direct expense → no invoice

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Freight & Transport Charges | 15,000 | — | Expense ledger (Indirect Expenses) |
| 2 | Cash / Petty Cash | — | 15,000 | Payment account |
| **Total** | | **15,000** | **15,000** | ✅ Balanced |

Flow: Submit → Admin approves → **OTP sent to ABC Logistics mobile** → OTP verified → appears on Payments page → Mark as Paid → Posted.

---

### 0.8 Scenario E — Purchase Invoice + Immediate Payment (Atomic)

**Example:** RFPL receives a packaging supplies invoice from Vendor X for ₹50,000 + 12% GST = ₹56,000 and pays immediately.

**Voucher type:** Payment → **📄 New purchase invoice — enter it now**  
*(Uses `create_linked_vouchers()` RPC — atomically creates Purchase + Payment)*

The system creates **two vouchers in one action:**

**Auto-created Purchase voucher:**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Packaging Supplies (Expense) | 50,000 | — |
| 2 | CGST Input Credit | 3,000 | — |
| 3 | SGST Input Credit | 3,000 | — |
| 4 | Vendor X (Creditor) | — | 56,000 |

**Auto-created Payment voucher:**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Vendor X (Creditor) | 56,000 | — |
| 2 | Canara Bank | — | 56,000 |

Both vouchers are linked via `voucher_allocations`. The admin sees both on one combined approval screen, approves once, and the OTP is sent to Vendor X.

---

### 0.9 Scenario F — Salary / Wages (Direct Payment, No Invoice)

**Example:** RFPL pays monthly salary to staff member Sibi ₹25,000 via UPI.

**Voucher type:** Payment → **📋 Direct expense — no invoice**

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Salaries & Wages | 25,000 | — | Indirect Expenses group |
| 2 | Canara Bank | — | 25,000 | Bank account |
| **Total** | | **25,000** | **25,000** | ✅ Balanced |

> Salary payments are **direct expenses** — no purchase invoice exists. Choose "Direct expense — no invoice" in the Bill Step to explicitly acknowledge this. Do NOT choose "Advance payment" unless you're paying an advance before the month ends.

---

### 0.10 Scenario G — Travel Advance to Employee

**Example:** Staff member gets ₹5,000 travel advance from petty cash before a trip.

**Voucher type:** Payment → **⏳ Advance payment — to settle later**

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Advances to Staff — [Name] | 5,000 | — | Current Assets group |
| 2 | Petty Cash | — | 5,000 | Cash account |
| **Total** | | **5,000** | **5,000** | ✅ Balanced |

When the employee submits actual expense bills, create a **Journal voucher:**
```
Dr  Travel Expenses      ₹5,000   (actual expense hit P&L)
Cr  Advances to Staff    ₹5,000   (advance cleared)
```
If the employee returns unused cash, create a **Receipt voucher** to Dr Petty Cash / Cr Advances to Staff for the returned amount.

---

### 0.11 Scenario H — Contra (Bank to Bank / Cash to Bank Transfer)

**Example:** Transfer ₹1,00,000 from Canara Bank Current A/c to Federal Bank OD A/c.

**Voucher type:** Contra  
**Payment mode:** Bank / NEFT / RTGS

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Federal Bank OD | 1,00,000 | — | Money arriving |
| 2 | Canara Bank | — | 1,00,000 | Money leaving |
| **Total** | | **1,00,000** | **1,00,000** | ✅ Balanced |

> Contra vouchers do **not** require a party entity and do **not** go through OTP. They post immediately on admin approval.

---

### 0.12 GST Filing Reconciliation

At the end of each quarter:

1. **GSTR-1 (Sales):** Trial Balance → Sales Accounts + CGST/SGST/IGST Payable ledger balances = total output tax owed
2. **GSTR-3B / ITC claim (Purchases):** CGST/SGST/IGST Input Credit ledger balances = ITC to claim
3. **Net GST payable:** Output tax − ITC = amount to pay via GST Portal
4. **Payment of GST (Journal/Payment voucher):**

| # | Ledger | Dr | Cr |
|---|---|---|---|
| 1 | CGST Payable | ₹X | — |
| 2 | SGST Payable | ₹Y | — |
| 3 | Canara Bank | — | ₹(X+Y) |

5. **TDS Reconciliation:** `TDS Receivable` ledger balance should match Form 26AS. Claim as advance tax credit at ITR filing.

---

## 1. Voucher Types (Nature)

Every voucher belongs to a **Voucher Type** which defines its accounting nature.  
These are two entirely separate dimensions from the workflow status below.

| Nature | Description | Entity Field | Entity Required | Payment Mode |
|---|---|---|---|---|
| `payment` | Outward payment to a vendor / payee | Payee / Beneficiary | ✅ mandatory | ✅ required |
| `receipt` | Inward receipt from a customer | Received From | ✅ mandatory | ✅ required |
| `purchase` | Purchase / liability entry | Vendor / Supplier | ⚠️ optional\* | optional |
| `sales` | Sales / receivable entry | Customer / Billed To | ⚠️ optional\* | optional |
| `journal` | General journal adjustment | — | ❌ | ❌ |
| `contra` | Cash ↔ Bank transfer | — | ❌ | ✅ required |

\* Optional for purchase/sales — but **needed for bill tracking** (bill allocation, Receivables/Payables reports, and the "New Invoice — enter it now" flow all depend on entity being set).

**Entity role filter by nature** (entity search in UI):
- `payment` → Vendor, Supplier, Staff, Management, Contractor, Government, Auditor, Fisher
- `receipt` → Customer, Vendor, Supplier (vendors can issue refunds)
- `sales` → Customer, Client
- `purchase` → Vendor, Supplier

**Voucher Number Format:** `{COMPANY_CODE}/{TYPE_PREFIX}/{FY_YEAR}/{SEQ:04d}`  
Example: `RHHF/PYMT/2627/0005`  
The sequence number is generated at submission time (not on draft save).

---

## 2. Voucher Creation Paths

Three distinct paths lead to a submitted voucher. All paths end at `pending_approval`.

---

### 2.1 Path A — Simplified Conversational Form (Payment & Receipt)

**Rendered when:** active type = `payment` or `receipt`  
**Component:** `src/pages/SimplifiedPaymentEntry.tsx`

The form reveals steps sequentially as each is completed.

```
Step 1 — Who?
  Entity search (role-filtered: payment→vendors/staff; receipt→customers)
  or [ Skip — no party ]

  ↓ Entity selected → load open bills / sales invoices for that entity

Bill Step — Is there an invoice? (shown between Step 1 and 2)
┌──────────────────────────────────────────────────────────────────┐
│  Open bills / sales invoices found:                              │
│    [ Allocate against existing bill ]  ← BillAllocPanel         │
│  No bills, or user dismisses:                                    │
│    [ 📄 New invoice — enter it now ]   ← creates Purchase+Pay   │
│    [ 📋 Direct expense / income ]      ← hits P&L immediately   │
│    [ ⏳ Advance payment / received ]   ← Balance Sheet until settled │
└──────────────────────────────────────────────────────────────────┘

Step 2 — How much? (total amount)
Step 3 — What for? (income / expense ledger lines, must balance to total)
Step 4 — Which account? (company bank / cash account)
Step 5 — Payment mode (only shown for bank accounts)
Step 6 — Reference / narration (optional)
Step 7 — Attachments (invoices, transfer receipts, PDFs)
Step 8 — Submit → status = pending_approval
```

**"New invoice — enter it now" sub-path:**  
Calls `pramaana.create_linked_vouchers()` Postgres RPC atomically:
1. Purchase/Sales voucher (`pending_approval`) — liability / receivable
2. Payment/Receipt voucher (`pending_approval`) — cash movement
3. `voucher_allocation` row linking the two  

Entity's creditor/debtor ledger (found via `ledgers.entity_id`) is the intermediary account. The approver sees both vouchers on a combined approval screen — one OTP, one decision.

---

### 2.2 Path B — Full Double-Entry Form (Purchase, Sales, Journal, Contra)

**Rendered when:** active type = `purchase`, `sales`, `journal`, or `contra`  
**Component:** `src/pages/VoucherEntry.tsx` (two-column layout)

```
Left column:                       Right column:
  Ref document number                ACCOUNTING ENTRIES
  Entity field (purchase/sales)      ⚡ GST Quick-Add panel
  Payment mode (optional)              Taxable amount
  Bank ledger (if bank mode)           GST Rate (5/12/18/28/custom)
  Cost centre (optional)               Supply type (intra/inter)
  Narration                            [ + Add GST Entry Rows ]
  Attachments                        Entry rows (ledger, Dr/Cr, amount, narration)
                                     Dr Total / Cr Total / Difference
  [ Save as Draft ]  [ Submit ]
```

**GST Quick-Add** (`sales` and `purchase` only): user enters taxable amount + rate + supply type → button appends CGST+SGST or IGST rows with pre-tagged ledger IDs. Tax ledgers must be tagged `is_tax_ledger = true` with correct `tax_type` in Ledgers → GST/Tax Ledger.

**Intra vs inter-state detection:** auto-detected when both party GSTIN and company GSTIN are present (first two digits = state code).

---

### 2.3 Path C — Scan Invoice (GPT-4o Vision OCR)

**Entry points:**  
- **Inline button:** "Scan Invoice" on the New Voucher page → `InvoiceScanModal`  
- **Scan Inbox:** `/invoices/scan` upload → `/invoices/inbox` → Scan Detail → "Create Voucher"

#### Inline modal flow (primary)

```
Step 1 — Upload
  Drop / browse: PDF, JPG, PNG (max 5 MB)
  PDFs: page 1 rendered to JPEG at 2× scale before OCR

Step 2 — Processing (GPT-4o via /api/ocr-edge)
  Extracts: invoice_no, invoice_date, supplier_name, supplier_gstin,
            recipient_name, recipient_gstin, line items (description, HSN,
            qty, rate, amount), taxable_value, cgst, sgst, igst, total_gst,
            total_amount, gst_type (intra/inter), confidence %

Step 3 — Review
  All extracted fields editable
  GSTIN validation — highlighted red if invalid format
  Our company's fields locked to Company Master (authoritative)
  Counter-party GSTIN looked up in registry.entities → auto-selects entity
  Supply type (intra/inter) auto-routed from GSTIN state codes
  Confidence badge shown; < 75% triggers review warning

Step 4 — "Create Draft Voucher" (button label)
  → navigate('/vouchers/new') with full prefill payload:
       entity_id     (if GSTIN-matched — skips entity search entirely)
       entity_name   (for entity chip)
       taxable_value, cgst, sgst, igst, total_gst, gst_type
       narration, bill_ref (= invoice number), invoice_date
  → scan PDF stored in module-level holder; VoucherEntry stages it
  → modal closes

VoucherEntry mounts / receives prefill:
  ✅ Voucher type pre-selected (Sales / Purchase)
  ✅ Entity chip shows name (scan-verified or name-searched)
  ✅ Reference No = invoice number
  ✅ Narration pre-filled
  ✅ Taxable amount in GST Quick-Add
  ✅ GST rate auto-computed, snapped to nearest standard (5/12/18/28%)
  ✅ Supply type set (intra / inter)
  ✅ CGST + SGST (or IGST) entry rows auto-generated after tax ledgers load
  ✅ Scanned PDF staged as attachment
  → User fills remaining row(s) (income/expense ledger), reviews, submits
```

**GSTIN wrong / not found:** counter-party lookup fails silently; `party_name` always passed → entity search field pre-filled with scanned name; user confirms from dropdown.

#### Scan Inbox flow (secondary)

Scans uploaded via `/invoices/scan` are stored in `pramaana.invoice_scans` with full OCR data. From the Scan Detail page, "Create Voucher" navigates to `/vouchers/new` with the same prefill payload (implemented in `CreateVoucherButton.tsx`).

---

## 3. Voucher Workflow States

### State Definitions

| Status | Display Label | Meaning |
|---|---|---|
| `draft` | **Draft** | Created but not submitted. No voucher number yet. Editable, recallable, deletable. |
| `pending_approval` | **Pending Approval** | Submitted. Voucher number assigned. Awaiting admin sign-off. |
| `approved` | **Awaiting OTP** | Admin approved. OTP generated & sent to payee's mobile. Awaiting verbal OTP confirmation. |
| `completed` | **OTP Verified** | OTP confirmed. Payment can now be initiated. |
| `awaiting_payment` | **Awaiting Payment** | Queued on the Payments page. Payment in progress. |
| `posted` | **Posted** | Payment recorded. Final state. Included in all financial reports. **Immutable** — see §4.1. |
| `cancelled` | **Cancelled** | Manually cancelled (reserved; not used in the standard flow). |

---

## 4. Full Lifecycle — State Transitions

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                        VOUCHER ENTRY                                 │
 │                                                                      │
 │  Creator fills: Type · Date · Party · Entries · Payment Mode · Ref  │
 │                                                                      │
 │        [Save as Draft]              [Submit for Approval]            │
 └──────────┬──────────────────────────────────┬───────────────────────┘
            │                                  │
            ▼                                  ▼
       ┌─────────┐   ← Submit ──────────► ┌──────────────────┐
       │  DRAFT  │                         │ PENDING APPROVAL │
       └─────────┘   ◄── Recall ─────────  └──────────────────┘
            │                                       │
            │  (delete only while draft)       Admin Approves
            ▼                                       │  → OTP sent via SMS to payee
          (gone)                                    ▼
                                           ┌─────────────────┐
                          Admin Rejects ──► │  AWAITING OTP   │ (status = 'approved')
                          → back to draft   └─────────────────┘
                                                    │
                                         Admin enters OTP
                                         (payee reads over phone)
                                                    │ OTP verified
                                                    ▼
                                           ┌─────────────────┐
                                           │   OTP VERIFIED  │ (status = 'completed')
                                           └─────────────────┘
                                                    │
                                    Accounts queues for payment
                                                    │
                                                    ▼
                                       ┌──────────────────────┐
                          Dequeue ◄─── │  AWAITING PAYMENT    │ (status = 'awaiting_payment')
                          (return to   └──────────────────────┘
                           completed)              │
                                         Pay Now → Mark as Paid
                                                    │
                                                    ▼
                                           ┌─────────────────┐
                                           │     POSTED      │ (status = 'posted')
                                           └─────────────────┘
                                           Final state — appears in
                                           Trial Balance, P&L, Balance Sheet
```

### Allowed Actions per State

| State | Creator | Accounts | Admin / Super Admin |
|---|---|---|---|
| `draft` | Edit, Submit, Delete | — | Edit, Submit, Delete |
| `pending_approval` | Recall (→ draft) | — | Approve, Reject |
| `approved` | — | — | Enter OTP, Resend OTP |
| `completed` | — | Queue for Payment | Queue for Payment, Pay Now |
| `awaiting_payment` | — | Dequeue, Pay Now (bank modes) | Dequeue, Pay Now |
| `posted` | View only | View only | View only — **DB trigger blocks any edit** |

---

### 4.1 Posted Voucher Immutability & Reversal

**`posted` is a terminal, immutable state.**

Migration `044_posted_voucher_immutability.sql` adds two Postgres `BEFORE` triggers:

| Trigger | Table | What it blocks |
|---|---|---|
| `trg_prevent_posted_voucher_update` | `pramaana.vouchers` | Any `UPDATE` where the row is already `posted` |
| `trg_prevent_posted_entry_insert/update/delete` | `pramaana.voucher_entries` | Any `INSERT`, `UPDATE`, or `DELETE` on entries whose parent voucher is `posted` |

The transition **to** `posted` (i.e. the `markVoucherPaid()` write where `OLD.status = 'awaiting_payment'`) is explicitly allowed.

#### Reversal Pattern

To correct a posted voucher, **create a new Journal voucher** with exactly reversed amounts — every `Dr` becomes `Cr` and vice versa. Reference the original voucher number in both the narration and the `ref_document_number` field.

**Example — reversing a mis-posted payment:**

Original posted voucher `RHHF/PYMT/2627/0042`:

| # | Ledger | Dr | Cr |
|---|---|---|---|
| 1 | Freight Charges | 15,000 | — |
| 2 | Canara Bank | — | 15,000 |

**Step 1 — Reversing Journal** (new voucher, ref: `RHHF/PYMT/2627/0042`):

| # | Ledger | Dr | Cr |
|---|---|---|---|
| 1 | Canara Bank | 15,000 | — |
| 2 | Freight Charges | — | 15,000 |

**Step 2 — Correcting entry** (if needed — e.g. correct ledger or amount):

| # | Ledger | Dr | Cr |
|---|---|---|---|
| 1 | Correct Expense | 15,000 | — |
| 2 | Canara Bank | — | 15,000 |

The original + reversing vouchers net to zero in all reports. The correct entry stands alone. GST filing integrity is maintained because filed-period data is never touched.

---

## 5. OTP Workflow Detail

Triggered automatically when an admin **approves** a voucher.

```
Admin clicks Approve
        │
        ▼
vouchers.status → 'approved'
approval_actions INSERT (action = 'approved')
        │
        ▼
initiatePaymentOtp()
  1. Fetch entity.mobile from registry.entities
  2. Cancel any existing pending OTP session for this voucher
  3. Generate 6-digit random OTP
  4. Hash OTP via /api/otp edge function (HMAC-SHA256 + PRAMAANA_OTP_SECRET)
  5. INSERT pramaana.otp_sessions {
       voucher_id, company_id, initiated_by,
       mobile, otp_hash, expires_at (+10 min),
       status = 'pending', failed_attempts = 0
     }
  6. Send SMS via 2Factor API
        │
        ▼
Payee receives SMS with OTP code
Payee calls / messages Admin and reads out the OTP
        │
        ▼
Admin enters OTP in the Approvals panel
        │
verifyPaymentOtp()
  1. Fetch active pending session (not expired, status = 'pending')
  2. Check failed_attempts < 3  (max 3 attempts — then session locked)
  3. Verify via /api/otp edge function (compare plain OTP against stored hash)
  4a. MISMATCH → increment failed_attempts, return attempts_left
  4b. MATCH →
        otp_sessions.status → 'verified'
        vouchers.status     → 'completed'
        vouchers.otp_verified_at / otp_verified_by set
        vouchers.completed_at  / completed_by set
```

**OTP session rules:**
- Expires in **10 minutes**
- Maximum **3 attempts** before the session is locked (`status = 'expired'`)
- Resend cooldown: **60 seconds** (enforced in UI)
- Resend cancels the previous pending session and creates a new one

---

## 6. Pay Now Workflow

Applies to any voucher where:
- `status = 'completed'` or `status = 'awaiting_payment'`
- `payment_mode ≠ 'cash'`
- User has the right role (see table above)

### 5.1 Queueing for Payment

```
OTP Verified voucher (status = 'completed')
        │
Accounts / Admin clicks "Queue for Payment" in Voucher Register
        │
        ▼
vouchers.status                → 'awaiting_payment'
vouchers.queued_at             → now()
vouchers.queued_for_payment_by → userId
        │
        ▼
Appears on /payments (Awaiting Payments page), sorted oldest first.
⚠ Overdue flag shown if queued_at > 48 hours ago.
```

To reverse: **Dequeue** returns the voucher to `completed`.

---

### 5.2 Pay Now Modal — Mode Behaviour

Opened from either the Voucher Register detail panel or the Awaiting Payments page.

The modal fetches entity payment details from `registry.entities`:
- `upi_id` — payee UPI VPA (e.g. `name@okaxis`)
- `bank_account_number` — bank account number
- `bank_ifsc` — IFSC code
- `bank_name` — used for net banking URL lookup
- `display_name` — shown as Payee

#### Payment mode routing

| DB value | Display Label | Desktop | Mobile |
|---|---|---|---|
| `upi` | UPI | QR code (api.qrserver.com, 220×220) + UPI ID | [Open in GPay] + [Any UPI App] |
| `bank` | Bank Transfer | Bank details card + Copy buttons + Net Banking link | Bank details card + Bank App launcher |
| `neft` | NEFT | Bank details card + Copy + Net Banking | Bank details card + Bank App |
| `rtgs` | RTGS | Bank details card + Copy + Net Banking | Bank details card + Bank App |
| `imps` | IMPS | Bank details card + Copy + Net Banking | Bank details card + Bank App |
| `cheque` | Cheque | Bank details card; **Cheque Number** field (not UTR) | Bank details card |
| `cash` | Cash | Pay Now not shown | Pay Now not shown |

#### UPI QR code

```
UPI URI:  upi://pay?pa={upi_id}&pn={payee_name}&am={amount}&cu=INR&tn=Voucher+{voucher_no}
QR URL:   https://api.qrserver.com/v1/create-qr-code/?size=220x220&data={encoded_upi_uri}
```

Admin opens camera / UPI app → scans QR → confirms payment in their banking app.

#### Mobile UPI deep links

```
GPay Android: intent://pay?pa=...#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end
GPay iOS:     gpay://upi/pay?pa=...
Any UPI:      upi://pay?pa=...
```

A `visibilitychange` listener fires when the user returns from the UPI app and auto-opens the Mark Paid panel.

---

### 5.3 Mark as Paid

```
Admin completes payment in their banking app / UPI app
        │
        ▼
Mark Paid panel:
  paid_from_account  — company bank account used (datalist from company_payment_accounts)
                       Required for bank transfer modes; optional for UPI
  paid_at            — date of payment (default: today)
  utr_number         — transaction reference (UPI, NEFT, RTGS, IMPS, Bank modes)
  cheque_number      — cheque number (Cheque mode only)
        │
        ▼
markVoucherPaid() →
  vouchers.status            → 'posted'
  vouchers.paid_from_account → selected account
  vouchers.paid_at           → payment date
  vouchers.paid_by           → auth user id (audit trail)
  vouchers.utr_number        → reference (non-Cheque modes)
  vouchers.cheque_number     → reference (Cheque mode)
        │
        ▼
Voucher disappears from Awaiting Payments page.
Appears in financial reports (Trial Balance, P&L, Balance Sheet).
```

---

## 7. Company Payment Accounts ("Pay From")

Managed in **Admin Panel → Payment Accounts**. Stored in `registry.company_bank_accounts` (not in the `pramaana` schema).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `company_id` | UUID → `registry.companies` | One set of accounts per company |
| `label` | TEXT | Display label e.g. `HDFC Current A/C`, `Federal Bank OD` |
| `account_holder_name` | TEXT | Legal name on the account |
| `bank_name` | TEXT | Used for mobile bank app launcher lookup |
| `bank_account_number` | TEXT | Account number |
| `bank_ifsc` | TEXT | IFSC code |
| `upi_id` | TEXT | Company UPI VPA (used as sender UPI for reference) |
| `is_primary` | BOOLEAN | Primary account shown first in datalist |
| `is_active` | BOOLEAN | Soft-delete flag |
| `created_at` | TIMESTAMPTZ | |

The `fetchCompanyPaymentAccounts()` in `src/lib/pay-now.ts` reads from this table, ordered by `is_primary DESC, created_at ASC`. These populate the **paid_from_account** autocomplete in the Pay Now modal.

---

## 8. Net Banking & Bank App Lookup

### Net Banking URLs (Desktop — from `entity.bank_name`)

| Bank name (substring match) | URL |
|---|---|
| Federal Bank | https://www.fednetbank.com |
| HDFC Bank / HDFC | https://netbanking.hdfcbank.com |
| Canara Bank | https://canarabank.com/User/logon.aspx |
| SBI | https://retail.sbi.co.in |
| Axis Bank | https://retail.axisbank.co.in |

### Bank App Packages (Mobile — from `paid_from_account` label)

| Label substring | Android package |
|---|---|
| Federal Bank | `com.corporatefedmobile` |
| HDFC Bank / HDFC | `com.hdfc.cbx` |
| Canara Bank | `com.symbiosis.canmobile` |

> **FedCorp note:** Federal Bank's FedCorp app supports maker-checker for NEFT/RTGS. Pramaana authorises the **payment decision** (via OTP); FedCorp authorises the **bank transaction**. Both are required for bank transfers from a Federal Bank current account.

---

## 9. Database Schema Reference

### `pramaana.vouchers` — payment-related columns

| Column | Type | Set at state | Notes |
|---|---|---|---|
| `status` | ENUM | every transition | Drives the entire workflow |
| `payment_mode` | TEXT | creation | Stored lowercase: `upi`, `bank`, `neft`, `rtgs`, `imps`, `cheque`, `cash` |
| `entity_id` | UUID | creation | FK → `registry.entities` |
| `posted_at` / `posted_by` | TIMESTAMPTZ / UUID | `posted` | Who finalised the voucher to posted state |
| `otp_verified_at` / `otp_verified_by` | TIMESTAMPTZ / UUID | `completed` | |
| `completed_at` / `completed_by` | TIMESTAMPTZ / UUID | `completed` | Same as otp_verified |
| `queued_at` / `queued_for_payment_by` | TIMESTAMPTZ / UUID | `awaiting_payment` | |
| `paid_at` / `paid_by` | TIMESTAMPTZ / UUID | `posted` | Who recorded the payment |
| `paid_from_account` | TEXT | `posted` | Company account used |
| `utr_number` | TEXT | `posted` | Transaction ref (non-Cheque) |
| `cheque_number` | TEXT | `posted` | Cheque number (Cheque mode) |

### `registry.entities` — payee payment details

| Column | Type | Notes |
|---|---|---|
| `upi_id` | TEXT | Payee UPI VPA |
| `bank_account_number` | TEXT | Bank account number |
| `bank_ifsc` | TEXT | IFSC code |
| `bank_name` | TEXT | Bank name |
| `mobile` | TEXT | Used for OTP SMS delivery |

Managed in **Relish Suite → Master Data → Entities**.

### `pramaana.otp_sessions`

| Column | Type | Notes |
|---|---|---|
| `voucher_id` | UUID | Which voucher this OTP is for |
| `company_id` | UUID | |
| `initiated_by` | UUID | Admin who triggered |
| `mobile` | TEXT | Payee mobile number |
| `otp_hash` | TEXT | HMAC-SHA256 hash (never stored plain) |
| `expires_at` | TIMESTAMPTZ | 10 minutes from creation |
| `status` | TEXT | `pending` → `verified` / `expired` / `cancelled` |
| `failed_attempts` | INT | 0–3; locked at 3 |

---

## 10. Bill Allocations

Added in migration `040_bill_allocations.sql`. Allows payment and receipt vouchers to be linked to the specific purchase/sales bills they settle, enabling per-invoice outstanding tracking.

> **Accounting note:** This is a business-intelligence layer on top of double-entry. It does **not** change `voucher_entries` — it only stores allocation metadata in `pramaana.voucher_allocations`.

### `pramaana.voucher_allocations`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `company_id` | UUID | FK → `registry.companies` |
| `entity_id` | UUID | FK → `registry.entities` (nullable) |
| `bill_voucher_id` | UUID | The purchase/sales voucher being settled |
| `payment_voucher_id` | UUID | The payment/receipt voucher doing the settling |
| `amount_allocated` | NUMERIC(15,2) | Portion of the bill settled by this payment |
| `is_advance` | BOOLEAN | `true` when payment preceded the bill (advance) |
| `allocated_at` | TIMESTAMPTZ | |
| `allocated_by` | UUID | FK → `auth.users` |

**Invariant:** `SUM(outstanding per entity)` must equal the entity's ledger balance.

### Bill Allocation Flow (SimplifiedPaymentEntry)

```
User selects entity + enters total amount
        │
        ▼
fetchOpenBills(companyId, entityId, billNature)
  → Returns purchase/sales vouchers with status IN
    ('approved', 'completed', 'awaiting_payment', 'posted')
  → Calculates outstanding = amount − already-allocated
  → Filters out fully-settled bills (outstanding < 0.005)
        │
        ▼
User allocates amounts across open bills in BillAllocPanel
        │
        ▼
voucher is created (submitVoucher / saveDraftVoucher)
        │
        ▼
saveAllocations(companyId, entityId, paymentVoucherId, userId, rows)
  → INSERTs rows into pramaana.voucher_allocations
```

To query which bills a payment settled: `fetchAllocationsForPayment(paymentVoucherId)`.

---

## 11. Voucher Attachments

Added in migrations `020_voucher_attachments.sql` (base table) and `038_attachment_type.sql` (`attachment_type` column).

Files are stored in Supabase Storage bucket **`voucher-attachments`** under path `{company_id}/{voucher_id}/{timestamp}_{random}.{ext}`.

### `pramaana.voucher_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `voucher_id` | UUID | FK → `pramaana.vouchers` |
| `company_id` | UUID | FK → `registry.companies` |
| `file_name` | TEXT | Original filename |
| `file_size` | BIGINT | Bytes (nullable) |
| `mime_type` | TEXT | MIME type (nullable) |
| `storage_path` | TEXT | Supabase Storage object path |
| `uploaded_by` | UUID | FK → `auth.users` |
| `uploaded_at` | TIMESTAMPTZ | |
| `is_deleted` | BOOLEAN | Soft-delete flag |
| `attachment_type` | TEXT | `'invoice'` \| `'transfer_receipt'` \| `'other'` |

### Upload flow

```
uploadVoucherAttachments(voucherId, companyId, userId, files, attachmentType)
  For each file:
    1. Upload to Storage → {company_id}/{voucher_id}/{ts}_{rand}.{ext}
    2. INSERT into pramaana.voucher_attachments
    3. On DB failure → remove orphaned Storage file (cleanup)
  Returns { ok: string[], failed: string[] }
```

Called **after** the voucher is saved (requires a real `voucher_id`).

---

## 12. Source Files

| File | Purpose |
|---|---|
| `src/lib/vouchers.ts` | Voucher types, `saveDraftVoucher`, `submitVoucher`, `fetchVoucherForEdit`, `updateDraftVoucher`, `fetchTaxLedgers`, `fetchEntityLedger` |
| `src/lib/vouchers-list.ts` | Register listing, `recallVoucher`, `deleteVoucher`, `submitDraftVoucher` |
| `src/lib/approvals.ts` | `fetchPendingVouchers`, `approveVoucher`, `rejectVoucher`, `fetchVoucherFull`, `fetchPendingCount` |
| `src/lib/otp.ts` | `initiatePaymentOtp`, `verifyPaymentOtp` |
| `src/lib/pay-now.ts` | `fetchAwaitingPayments`, `queueForPayment`, `dequeuePayment`, `markVoucherPaid`, `fetchCompanyPaymentAccounts`, `fetchAdminMobile`, `updateVoucherPaymentMode` |
| `src/lib/allocations.ts` | `fetchOpenBills`, `saveAllocations`, `fetchAllocationsForPayment` — bill allocation engine |
| `src/lib/attachments.ts` | `uploadVoucherAttachments`, `fetchVoucherAttachments`, `deleteVoucherAttachment` — Supabase Storage |
| `src/pages/VoucherEntry.tsx` | New Voucher page — type selector, scan prefill receiver, GST Quick-Add, full double-entry form (purchase/sales/journal/contra), entity field for all commercial types |
| `src/pages/SimplifiedPaymentEntry.tsx` | Step-based conversational form (payment/receipt) with entity search, bill allocation intent gate, "New invoice" branch, attachment upload |
| `src/hooks/useInvoiceScan.ts` | OCR scan state machine — upload → processing → review → prefill generation |
| `src/components/InvoiceScanModal.tsx` | Inline scan modal; "Create Draft Voucher" now navigates to VoucherEntry with full prefill; exports `consumeScanFile()` |
| `src/modules/invoice-scan/CreateVoucherButton.tsx` | Scan inbox "Create Voucher" — navigates to VoucherEntry with full GST prefill |
| `src/pages/VoucherRegister.tsx` | All-vouchers list with Pay Now, voucher print (attachment links), approval actions |
| `src/pages/ApprovalQueue.tsx` | Approve / reject / OTP verification UI |
| `src/pages/AwaitingPayments.tsx` | `/payments` — queued payment list |
| `src/components/PayNowModal.tsx` | Pay Now modal (UPI QR, bank details, Mark Paid) |
| `src/components/BillAllocPanel.tsx` | Bill allocation UI — links payments to open purchase/sales bills |
| `src/components/InvoiceScanModal.tsx` | OCR-based invoice scan (via `/api/ocr-edge`) — full prefill to VoucherEntry |
| `src/components/QRRelayModal.tsx` | QR relay modal for cross-device UPI payment |
| `src/pages/AdminPanel.tsx` | Company payment accounts management (`registry.company_bank_accounts`) |
| `supabase/migrations/020_voucher_attachments.sql` | `pramaana.voucher_attachments` table + Storage bucket policy |
| `supabase/migrations/036_pay_now.sql` | `paid_from_account` column + original `pramaana.company_payment_accounts` table |
| `supabase/migrations/038_attachment_type.sql` | `attachment_type` column on `voucher_attachments` |
| `supabase/migrations/039_awaiting_payment_status.sql` | `awaiting_payment` status enum value |
| `supabase/migrations/040_bill_allocations.sql` | `pramaana.voucher_allocations` table |
| `supabase/migrations/041_create_linked_vouchers.sql` | `pramaana.create_linked_vouchers()` RPC — atomic Purchase+Payment creation |
| `supabase/migrations/044_posted_voucher_immutability.sql` | Triggers preventing edits to posted vouchers and their entries |
| `supabase/migrations/20260625000000_invoice_scan_module.sql` | Invoice scan schema (scan sessions, OCR results) |

---

## 13. Known Gaps & Engineering Notes

### 13.1 Voucher Sequence Generation — Atomicity Status

**Voucher number format:** `{COMPANY_CODE}/{TYPE_PREFIX}/{FY_YEAR}/{SEQ:04d}`  
**Sequence source:** `registry.next_fy_sequence()` Postgres RPC.

**Two invocation paths exist:**

| Path | Invocation | Atomic? |
|---|---|---|
| Single-voucher submit (`submitVoucher()` in `vouchers.ts`) | Client calls `next_fy_sequence` RPC, then inserts voucher — **two separate round-trips** | ❌ Not atomic at app level |
| Linked-voucher creation (`create_linked_vouchers()` RPC) | Both sequence calls and all inserts happen inside a single PL/pgSQL function body | ✅ Atomic |

**Race condition risk on the single-voucher path:**

The risk depends on how `registry.next_fy_sequence` is implemented:

- **If it uses a Postgres `SEQUENCE` object (`NEXTVAL`):** Each concurrent call gets a guaranteed-unique value. Two simultaneous submits cannot get the same number. Gaps on rollback are acceptable per standard accounting practice. ✅ Safe.
- **If it uses `SELECT MAX(seq_num) + 1`:** Two concurrent submits can read the same max and produce a duplicate number. ❌ Not safe — must be replaced with `SELECT ... FOR UPDATE` on the counter row, or migrated to a real Postgres `SEQUENCE`.

**Action:** Confirm which implementation `registry.next_fy_sequence` uses. The `041_create_linked_vouchers.sql` comment describes it as a "non-transactional counter" which is consistent with a Postgres `SEQUENCE` (sequences are non-transactional by design). If it is `MAX+1`, file a bug and fix before go-live.

**Gap behaviour:** Gaps in voucher numbering are normal — they occur when a draft with an assigned number is recalled and deleted, or when a transaction rolls back after a sequence call. This is acceptable under accounting convention; auditors accept gaps with explanation.

---

### 13.2 Multi-Currency / FX — Not Yet Modelled

The current schema has **no `currency` or `exchange_rate` column** anywhere in `pramaana.vouchers`, `pramaana.voucher_entries`, or `registry.entities`.

All amounts are implicitly INR.

**If RFPL ever invoices in USD or another foreign currency** (e.g. for cocopeat exports), the following schema additions will be needed before any FX transaction is entered:

| Column | Table | Notes |
|---|---|---|
| `currency` | `pramaana.vouchers` | ISO 4217 code, default `'INR'` |
| `exchange_rate` | `pramaana.vouchers` | INR per 1 unit of foreign currency at transaction date |
| `foreign_amount` | `pramaana.voucher_entries` | Amount in original currency; `amount` column remains INR equivalent |

GST reporting always requires INR values (converted at the RBI reference rate on the invoice date), so the `amount` column in `voucher_entries` must remain in INR regardless.

**This is a breaking schema change** — all existing report queries assume INR throughout. Do not bolt this on as an afterthought. If export invoicing in USD is likely before the next financial year, model it now while the schema is still young.

**Immediate action required:** Confirm with RFPL management whether any FY 26-27 invoices will be in a foreign currency. If yes, add the columns above before Tally cutover on July 31.

---

### 13.3 July 31 Tally Cutover — Priority Classification

| Component | Must be correct on day one? | Risk if rough |
|---|---|---|
| **Double-entry balance enforcement** (Dr = Cr guard in `create_linked_vouchers` + client-side) | ✅ **Day-one critical** | Silent Trial Balance mis-tie discovered weeks later |
| **GST ledger routing** (Payable vs Input Credit, CGST/SGST/IGST split) | ✅ **Day-one critical** | Wrong GST return figures for July filing |
| **Posted voucher immutability** (`044` trigger) | ✅ **Day-one critical** | Filed-period data can be edited retroactively |
| **OTP flow** (SMS delivery, 10-min expiry, 3-attempt lock) | ✅ **Day-one critical** | Payment authorisation can be bypassed |
| **Sequence uniqueness** (confirm `NEXTVAL` not `MAX+1`) | ✅ **Day-one critical** | Duplicate voucher numbers break audit trail |
| **Bill allocations** (BillAllocPanel, voucher_allocations) | ✅ **Day-one critical** for Receivables/Payables accuracy | Outstanding balances wrong from first month |
| **Atomic linked-voucher creation** (`create_linked_vouchers`) | ✅ **Day-one critical** | Partial state: Purchase created, Payment not (or vice versa) |
| **Combined approval UX** (approver sees both linked vouchers) | ⚠️ **Important but can ship rough** | Approver confusion; workaround via two separate approvals |
| **OCR invoice scan prefill** (GPT-4o, confidence badges) | ⚠️ **Nice to have** | Entry staff type manually — slower but not incorrect |
| **Scan Inbox flow** (upload → inbox → create voucher) | ⚠️ **Nice to have** | Inline modal covers the use case |
| **Net Banking / Bank App deep links** | ⚠️ **Nice to have** | Accounts staff open banking app manually |
| **QR Relay cross-device flow** | ⚠️ **Nice to have** | Standard UPI QR on same device covers most cases |
| **Multi-currency / FX columns** | ❌ **Not needed July 31** unless FX invoices exist | See §13.2 — plan before FX transaction occurs |
