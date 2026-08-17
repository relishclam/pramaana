# Pramaana — Voucher Entry Workflow
## Accountant's Field Guide
**Version:** Aug-2026 | Applies to: RFPL & RHHF

---

## 1. The Five Rules You Cannot Break

| # | Rule | What to do |
|---|---|---|
| 1 | **Dr = Cr always** | The "Balanced ✅" indicator must be green before you can submit. Never submit an unbalanced voucher. |
| 2 | **Income = taxable value only** | On sales vouchers, the Sales/Income ledger gets the pre-GST amount. GST goes to separate GST Payable ledgers. |
| 3 | **GST Payable ≠ Input Credit** | Sales → credit **GST Payable** (liability). Purchases → debit **GST Input Credit** (asset). These are different ledgers. |
| 4 | **TDS deducted by customer = Receivable** | When a customer withholds TDS, debit `TDS Receivable` (asset). It is NOT a loss or expense. |
| 5 | **Security deposits are liabilities** | Deposits received are refundable. Credit a **Current/Long-term Liability** ledger, never Income. |

---

## 2. Voucher Types at a Glance

| Type | When to use | After admin approval |
|---|---|---|
| **Sales** | You raised an invoice to a customer | Posts immediately |
| **Purchase** | You received a supplier invoice | Posts immediately |
| **Receipt** | Cash or bank received from a customer | Posts immediately |
| **Payment** | Cash or bank paid to a vendor / employee | OTP sent → Payments page → Mark Paid → Posts |
| **Journal** | Adjustments, accruals, advance settlement | Posts immediately |
| **Contra** | Transfer between company bank/cash accounts | Posts immediately |

---

## 3. Step-by-Step: Creating Any Voucher

```
Vouchers → + New Voucher
     │
     ▼
Select Type → select Date → select Party (entity)
     │
     ▼
Enter ledger rows (Dr / Cr amounts)
     │
     ├── ⚡ GST Quick-Add  (appears on Sales / Purchase)
     │      Fills CGST + SGST / IGST rows automatically
     │      Set % rate → click → rows added instantly
     │
     ├── 📎 Attach invoice scan  (optional but recommended)
     │
     ├── 💬 Notes  (for internal reference)
     │
     ▼
Balanced ✅ → Submit for Approval
     │
     ▼
Admin reviews → Approves / Rejects
     │
     ├── Payment voucher → OTP sent to payee mobile
     │   OTP verified → moves to /payments → Mark Paid
     │
     └── All other types → Posted immediately ✅
```

---

## 4. Scenario Walkthroughs

### 4.1 Sales Invoice with GST (Intra-state)

> **Example:** Lease rent invoice to Peninsular Fisheries — ₹2,10,000 taxable + 9% CGST + 9% SGST = **₹2,47,800 total**

**Voucher type:** Sales

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Peninsular Fisheries (Debtor) | 2,47,800 | — | Sundry Debtors group |
| 2 | Lease Rent Income | — | 2,10,000 | Taxable value only |
| 3 | CGST Payable | — | 18,900 | ⚡ GST Quick-Add fills this |
| 4 | SGST Payable | — | 18,900 | ⚡ GST Quick-Add fills this |
| | **Total** | **2,47,800** | **2,47,800** | ✅ |

> Use ⚡ **GST Quick-Add** → type `9` in the rate box → click Add. It auto-fills rows 3 & 4 based on the taxable value.

---

### 4.2 Receipt from Customer (with TDS & Deposit Deduction)

> **Example:** Peninsular settles INV 036.
> Invoice ₹2,47,800 · TDS deducted ₹21,000 · Deposit deducted ₹21,000 · **Net cash received ₹2,05,800**

**Voucher type:** Receipt → use **Full double-entry form** (5 legs)

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | Canara Bank | 2,05,800 | — | Actual cash received |
| 2 | TDS Receivable — 194I | 21,000 | — | Advance tax credit |
| 3 | Security Deposit — Peninsular | 21,000 | — | Monthly deposit deduction |
| 4 | Peninsular Fisheries (Debtor) | — | 2,47,800 | Closes the Sales invoice |
| | **Total** | **2,47,800** | **2,47,800** | ✅ |

> In the **Bill Step**, link this receipt to INV 036 to close the outstanding balance in the Receivables report.

---

### 4.3 Security Deposit Received (one-time)

> **Example:** Peninsular pays ₹2,10,000 security deposit at lease start.

**Voucher type:** Receipt → **No invoice (direct receipt)**
**Bill Step:** Choose ⏳ *Advance received — to settle later*

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Canara Bank | 2,10,000 | — |
| 2 | Security Deposit — Peninsular | — | 2,10,000 |
| | **Total** | **2,10,000** | **2,10,000** | ✅ |

---

### 4.4 Outward Payment to Vendor (Direct Expense)

> **Example:** Freight charges to ABC Logistics ₹15,000 via NEFT.

**Voucher type:** Payment → **📋 Direct expense — no invoice**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Freight & Transport | 15,000 | — |
| 2 | Canara Bank | — | 15,000 |
| | **Total** | **15,000** | **15,000** | ✅ |

**Flow after Submit:**
```
Submit → Admin Approval → OTP sent to ABC Logistics mobile
→ OTP verified → appears on Payments page
→ Mark as Paid (enter UTR) → Posted ✅
```

---

### 4.5 Purchase Invoice + Immediate Payment (Atomic)

> **Example:** Packaging supplies ₹50,000 + 12% GST = ₹56,000. Paid same day.

**Voucher type:** Payment → **📄 New purchase invoice — enter it now**

The system creates **two linked vouchers automatically:**

**Purchase voucher (auto-created):**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Packaging Supplies | 50,000 | — |
| 2 | CGST Input Credit | 3,000 | — |
| 3 | SGST Input Credit | 3,000 | — |
| 4 | Vendor X (Creditor) | — | 56,000 |

**Payment voucher (auto-created):**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Vendor X (Creditor) | 56,000 | — |
| 2 | Canara Bank | — | 56,000 |

Both vouchers are linked. Admin approves once; OTP goes to Vendor X.

---

### 4.6 Salary / Wages

> **Example:** Monthly salary ₹25,000 via UPI to staff Sibi.

**Voucher type:** Payment → **📋 Direct expense — no invoice**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Salaries & Wages | 25,000 | — |
| 2 | Canara Bank | — | 25,000 |
| | **Total** | **25,000** | **25,000** | ✅ |

> Salary is a direct expense. Do **not** choose "Advance payment" unless you're paying before month-end.

---

### 4.7 Travel Advance to Employee

**Voucher type:** Payment → **⏳ Advance payment — to settle later**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Advances to Staff — [Name] | 5,000 | — |
| 2 | Petty Cash | — | 5,000 |

When the employee submits bills, create a **Journal** to settle:

```
Dr  Travel Expenses    ₹5,000
Cr  Advances to Staff  ₹5,000
```

If unused cash is returned, create a **Receipt**: Dr Petty Cash / Cr Advances to Staff.

---

### 4.8 Bank-to-Bank Transfer (Contra)

> **Example:** Transfer ₹1,00,000 from Canara Current to HDFC OD account.

**Voucher type:** Contra

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | HDFC OD Account | 1,00,000 | — |
| 2 | Canara Bank | — | 1,00,000 |

Posts immediately after admin approval. No OTP.

---

### 4.9 Purchase Invoice with TDS (Vendor Payment, TDS Deducted)

> **Example:** Professional fee to CA firm ₹50,000. TDS @ 10% u/s 194J = ₹5,000. Net payment ₹45,000.

**Step 1 — Purchase voucher:**

| # | Ledger | Dr (₹) | Cr (₹) |
|---|---|---|---|
| 1 | Audit Fee / Prof. Fee (Expense) | 50,000 | — |
| 2 | CA Firm (Creditor) | — | 50,000 |

**Step 2 — Payment voucher (linked to Purchase):**

| # | Ledger | Dr (₹) | Cr (₹) | Notes |
|---|---|---|---|---|
| 1 | CA Firm (Creditor) | 50,000 | — | Clears the creditor |
| 2 | TDS Payable — 194J | — | 5,000 | TDS withheld |
| 3 | Canara Bank | — | 45,000 | Net cash out |
| | **Total** | **50,000** | **50,000** | ✅ |

> Record TDS in `voucher_tds_deductions` when creating the Payment voucher so it flows to Form 26Q.

---

## 5. Pay Now Workflow (Payment Vouchers Only)

After OTP verification, the voucher moves to `status = completed` and appears on the **Payments** page (`/payments`).

```
/payments page  OR  Voucher Register detail panel
        │
💳 Pay Now  (visible to: Super Admin, Admin, Accounts*)
        │
        ├─ UPI mode ────────────────────────────────────
        │   Desktop: QR code → scan with any UPI app
        │   Mobile:  [Open in GPay] or [Any UPI App]
        │   Returns automatically → Mark Paid opens
        │
        └─ Bank transfer (NEFT/RTGS/IMPS/Cheque) ─────
            Bank details card with copy buttons
            [Open Net Banking] or [Open Bank App]
            Enter UTR or Cheque No → Mark as Paid
                    │
                    ▼
            voucher.status → 'posted' ✅
            paid_from_account + paid_at recorded
```

*Accounts-role users can Pay Now only for bank-transfer modes (not UPI).

---

## 6. Voucher Status Lifecycle

```
Draft → Submitted → Approved → [OTP Flow*] → Completed → Posted
                  ↘ Rejected
```

| Status | Meaning | Editable? |
|---|---|---|
| `draft` | Saved, not yet submitted | ✅ Yes |
| `submitted` | Awaiting admin review | ❌ Locked |
| `approved` | Approved (non-payment types post here) | ❌ Locked |
| `awaiting_payment` | OTP sent, waiting for verification | ❌ Locked |
| `completed` | OTP verified; ready to mark paid | ❌ Locked |
| `posted` | Payment recorded; fully closed | ❌ Immutable |
| `rejected` | Sent back by admin | ✅ Edit & resubmit |

*OTP flow applies only to Payment vouchers.

---

## 7. Bill Step — Quick Reference

When asked "How does this relate to an invoice?" choose:

| Situation | Choose |
|---|---|
| Paying against a specific purchase invoice already in Pramaana | **📄 Against existing purchase invoice** |
| Creating a new purchase invoice and paying at the same time | **📄 New purchase invoice — enter it now** |
| Direct expense (salary, utility, freight) — no invoice exists | **📋 Direct expense — no invoice** |
| Paying an advance before goods/service are received | **⏳ Advance payment — to settle later** |
| Receipt that is an advance from customer | **⏳ Advance received — to settle later** |

---

## 8. GST Quick-Add — How It Works

1. Enter the Sales / Purchase ledger row with the taxable value
2. Click **⚡ GST Quick-Add**
3. Type the rate (e.g. `18` for 18%)
4. Select **Intra-state** (CGST + SGST) or **Inter-state** (IGST)
5. Click **Add** — two rows appear automatically

The tool scans for ledgers tagged `is_tax_ledger = true` and picks the matching `CGST` / `SGST` / `IGST` ledger. If it shows "No GST ledger found", the ledger hasn't been tagged — ask your admin to tag it in **Ledgers → Edit → GST/Tax Ledger**.

---

## 9. Attaching Invoices / Receipts

Every voucher supports file attachments:

- Click 📎 in the voucher form
- Upload the scanned invoice or bank receipt (PDF or image)
- Attachment is stored and visible to admin during approval

**Best practice:** always attach the vendor invoice for Purchase vouchers and the bank statement screenshot for Payment vouchers. This is mandatory for audit compliance.

---

*Last updated: 17 Aug 2026 — Pramaana v1*
