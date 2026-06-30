# Pramaana — Voucher Lifecycle & Pay Now Workflow

> Single source of truth for voucher states, transitions, roles, and the full Pay Now / UPI payment flow.
> Last updated: 2026-07-01

---

## 1. Voucher Types (Nature)

Every voucher belongs to a **Voucher Type** which defines its accounting nature.  
These are two entirely separate dimensions from the workflow status below.

| Nature | Description | Party Required | Payment Mode Required |
|---|---|---|---|
| `payment` | Outward payment to a vendor / payee | ✅ | ✅ |
| `receipt` | Inward receipt from a customer | ✅ | ✅ |
| `journal` | General journal adjustment | ❌ | ❌ |
| `contra` | Cash ↔ Bank transfer | ❌ | ✅ |
| `purchase` | Purchase entry | ❌ | ❌ |
| `sales` | Sales entry | ❌ | ❌ |

**Voucher Number Format:** `{COMPANY_CODE}/{TYPE_PREFIX}/{FY_YEAR}/{SEQ:04d}`  
Example: `RHHF/PYMT/2627/0005`  
The sequence number is generated at submission time (not on draft save).

---

## 2. Voucher Workflow States

### State Definitions

| Status | Display Label | Meaning |
|---|---|---|
| `draft` | **Draft** | Created but not submitted. No voucher number yet. Editable, recallable, deletable. |
| `pending_approval` | **Pending Approval** | Submitted. Voucher number assigned. Awaiting admin sign-off. |
| `approved` | **Awaiting OTP** | Admin approved. OTP generated & sent to payee's mobile. Awaiting verbal OTP confirmation. |
| `completed` | **OTP Verified** | OTP confirmed. Payment can now be initiated. |
| `awaiting_payment` | **Awaiting Payment** | Queued on the Payments page. Payment in progress. |
| `posted` | **Posted** | Payment recorded. Final state. Included in all financial reports. |
| `cancelled` | **Cancelled** | Manually cancelled (reserved; not used in the standard flow). |

---

## 3. Full Lifecycle — State Transitions

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
| `posted` | View only | View only | View only |

---

## 4. OTP Workflow Detail

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

## 5. Pay Now Workflow

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

## 6. Company Payment Accounts ("Pay From")

Managed in **Admin Panel → Payment Accounts**.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `company_id` | UUID → `registry.companies` | One set of accounts per company |
| `label` | TEXT | Free-text label e.g. `HDFC Current A/C`, `Federal Bank OD` |
| `created_at` | TIMESTAMPTZ | |

These populate the **paid_from_account** autocomplete datalist in the Pay Now modal.

> **Planned:** Replace free-text labels with structured bank accounts (bank name, account number, IFSC, UPI ID) as part of the Company Profiles feature.

---

## 7. Net Banking & Bank App Lookup

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

## 8. Database Schema Reference

### `pramaana.vouchers` — payment-related columns

| Column | Type | Set at state | Notes |
|---|---|---|---|
| `status` | ENUM | every transition | Drives the entire workflow |
| `payment_mode` | TEXT | creation | Stored lowercase: `upi`, `bank`, `neft`, `rtgs`, `imps`, `cheque`, `cash` |
| `entity_id` | UUID | creation | FK → `registry.entities` |
| `posted_at` / `posted_by` | TIMESTAMPTZ / UUID | `approved` | Admin who approved |
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

## 9. Source Files

| File | Purpose |
|---|---|
| `src/lib/vouchers.ts` | Voucher types, `saveDraftVoucher`, `submitVoucher` |
| `src/lib/vouchers-list.ts` | Register listing, `recallVoucher`, `deleteVoucher`, `submitDraftVoucher` |
| `src/lib/approvals.ts` | `fetchPendingVouchers`, `approveVoucher`, `rejectVoucher`, `fetchVoucherFull` |
| `src/lib/otp.ts` | `initiatePaymentOtp`, `verifyPaymentOtp` |
| `src/lib/pay-now.ts` | `fetchAwaitingPayments`, `queueForPayment`, `dequeuePayment`, `markVoucherPaid`, company payment accounts |
| `src/pages/VoucherEntry.tsx` | Create / edit voucher UI |
| `src/pages/VoucherRegister.tsx` | All-vouchers list with Pay Now wired in |
| `src/pages/ApprovalQueue.tsx` | Approve / reject / OTP verification UI |
| `src/pages/AwaitingPayments.tsx` | `/payments` — queued payment list |
| `src/components/PayNowModal.tsx` | Pay Now modal (UPI QR, bank details, Mark Paid) |
| `src/pages/AdminPanel.tsx` | Company payment accounts management |
| `supabase/migrations/036_pay_now.sql` | `paid_from_account` column + `company_payment_accounts` table |
| `supabase/migrations/039_awaiting_payment_status.sql` | `awaiting_payment` status enum value |
