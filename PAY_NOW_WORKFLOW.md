# Pay Now — Voucher Payment Initiation Workflow

## Overview

After a voucher is OTP-verified and moves to **Completed**, authorised users can initiate payment directly from the Voucher Register via a **💳 Pay Now** button. The modal provides mode-specific payment assistance, records which account the payment was sent from, and lets staff mark the voucher as paid with a UTR reference.

A companion **Awaiting Payments** page (`/payments`) lists all completed-but-unpaid vouchers, oldest first, with a ⚠ overdue flag after 48 hours.

---

## Role Visibility

The Pay Now button appears only when **all** of the following are true:

1. `voucher.status === 'completed'`
2. `voucher.payment_mode !== 'Cash'`
3. The current user satisfies **one** of:
   - `user.profile.is_super_admin === true`
   - `user.activeRole === 'admin'`
   - `user.activeRole === 'accounts'` **AND** `payment_mode` is one of `Bank | Cheque | NEFT | RTGS | IMPS`

> Accounts-role users can only Pay Now for bank-transfer modes, not UPI.

---

## Database Schema

### `pramaana.vouchers` (added by `036_pay_now.sql`)

| Column | Type | Notes |
|---|---|---|
| `paid_from_account` | `TEXT` | Which company account the payment was sent from |
| `paid_at` | `TIMESTAMPTZ` | When the payment was recorded as made |

Existing columns used by Pay Now: `utr_number`, `payment_mode`, `entity_id`.

### `registry.entities` (pre-existing columns)

| Column | Type | Notes |
|---|---|---|
| `upi_id` | `TEXT` | Payee UPI VPA, e.g. `name@okaxis` |
| `account_number` | `TEXT` | Bank account number |
| `ifsc` | `TEXT` | IFSC code |
| `bank_name` | `TEXT` | Bank name — used for net banking URL lookup |

### `pramaana.company_payment_accounts` (created by `036_pay_now.sql`)

Managed list of "Pay From" accounts per company. Populates the datalist autocomplete in the Pay Now modal.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | Primary key |
| `company_id` | `TEXT` | FK → `registry.companies(id)` |
| `label` | `TEXT` | Display name, e.g. `HDFC Current A/C`, `Federal Bank OD A/C` |
| `created_at` | `TIMESTAMPTZ` | |

RLS enabled; authenticated users have full access.

---

## Files

| File | Purpose |
|---|---|
| `supabase/migrations/036_pay_now.sql` | DB migration |
| `src/lib/pay-now.ts` | API layer — payment accounts CRUD, `markVoucherPaid`, `fetchAwaitingPayments` |
| `src/components/PayNowModal.tsx` | Pay Now modal component |
| `src/components/PayNowModal.module.css` | Modal styles |
| `src/pages/AwaitingPayments.tsx` | `/payments` route |
| `src/lib/approvals.ts` | Extended `VoucherFull` with entity payment fields + `paid_from_account` / `paid_at` |
| `src/pages/VoucherRegister.tsx` | Pay Now button + modal wired into detail panel |
| `src/pages/AdminPanel.tsx` | Pay-From Accounts management tab |
| `src/App.tsx` | `/payments` route + Payments nav item |

---

## Payment Mode Handling

| Pramaana Payment Mode | Category | Pay Now Behaviour |
|---|---|---|
| `UPI` | UPI | QR code (desktop) / GPay + Any UPI App (mobile) |
| `Bank` | Account Transfer | Bank details card + Copy All + net banking / bank app |
| `Cheque` | Account Transfer | Bank details card + Copy All |
| `NEFT` | Account Transfer | Bank details card + Copy All + net banking / bank app |
| `RTGS` | Account Transfer | Bank details card + Copy All + net banking / bank app |
| `IMPS` | Account Transfer | Bank details card + Copy All + net banking / bank app |
| `Cash` | — | Pay Now not shown |

---

## End-to-End Flow

```
Voucher OTP Verified
        │
        ▼
  status → "completed"
        │
        ▼
💳 Pay Now button visible in Voucher Register detail panel
(also visible on /payments Awaiting Payments page)
        │
        ▼
PayNowModal opens
        │
        ├─ mode = UPI, desktop ─────────────────────────────────────────────────┐
        │   QR code (api.qrserver.com, 220×220) + UPI ID shown                 │
        │   Admin scans QR on phone → UPI app opens → approves                 │
        │                                                                       │
        ├─ mode = UPI, mobile ──────────────────────────────────────────────────┤
        │   [Open in GPay]  → Android intent / iOS gpay:// deep link           │
        │   [Any UPI App]   → upi://pay?... deep link                          │
        │   visibilitychange listener fires on return → Mark Paid auto-opens   │
        │                                                                       │
        ├─ mode = Account Transfer, desktop ────────────────────────────────────┤
        │   Bank details card: Payee / Account No / IFSC / Bank /              │
        │     Amount / Reference — each with 📋 copy button                   │
        │   [📋 Copy All Details]                                               │
        │   [🌐 Open {Bank} Net Banking ↗]  (if bank matched in lookup table)  │
        │                                                                       │
        └─ mode = Account Transfer, mobile ────────────────────────────────────┤
            Bank details card + [📋 Copy All Details]                          │
            [📱 Open {Bank} App]  (Android intent, from paid_from_account)    │
                                                                               │
                                                               ▼
                                                   Admin completes payment
                                                           │
                                                           ▼
                                                  Mark Paid panel opens
                                                  (manually or auto on mobile)
                                                           │
                                                   paid_from_account (required
                                                   for Account Transfer)
                                                   paid_at (date, default today)
                                                   utr_number (optional, with
                                                   📋 Paste button)
                                                           │
                                                           ▼
                                               [Mark as Paid] → updates
                                               vouchers.paid_from_account
                                               vouchers.paid_at
                                               vouchers.utr_number
```

---

## Net Banking URL Map (Desktop)

Derived from `entity.bank_name` (case-insensitive substring match):

```typescript
const NET_BANKING_URLS = {
  'federal bank': 'https://www.fednetbank.com',
  'hdfc bank':    'https://netbanking.hdfcbank.com',
  'hdfc':         'https://netbanking.hdfcbank.com',
  'canara bank':  'https://canarabank.com/User/logon.aspx',
  'sbi':          'https://retail.sbi.co.in',
  'axis bank':    'https://retail.axisbank.co.in',
}
```

If no match, the button is not shown (no fallback text).

---

## Bank App Map (Mobile — from `paid_from_account`)

Derived from the **Pay From** account label (case-insensitive substring match):

```typescript
const BANK_APPS = {
  'federal bank': 'com.corporatefedmobile',   // FedCorp
  'hdfc bank':    'com.hdfc.cbx',             // HDFC Corp
  'hdfc':         'com.hdfc.cbx',
  'canara bank':  'com.symbiosis.canmobile',
}
```

Opens via Android intent: `intent://#{package}?#Intent;scheme=android-app;end`  
If app not installed, a toast fires: *"Could not open bank app — open it manually."*  
Not shown on desktop.

> **FedCorp note:** Federal Bank's FedCorp app supports maker-checker authorisation for payment transactions. If Relish's Federal Bank current account is configured on FedCorp, accounts staff creates the payment and the authoriser approves it within FedCorp. This complements Pramaana's OTP approval — Pramaana authorises the payment decision; FedCorp authorises the actual bank transaction.

---

## GPay Deep Link Format

```typescript
// Android
`intent://pay?pa=${upiId}&pn=${payeeName}&am=${amount}&cu=INR&tn=${voucherNo}
  #Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`

// iOS (detected via /iPhone|iPad/i.test(navigator.userAgent))
`gpay://upi/pay?pa=${upiId}&pn=${payeeName}&am=${amount}&cu=INR&tn=${voucherNo}`
```

---

## Mark Paid — Validation

- **Account Transfer:** `paid_from_account` is required before submitting. Validation message: *"Please select which account this payment was sent from."*
- **UPI:** `paid_from_account` is optional.
- `paid_at` defaults to today; user can change to a past date.
- `utr_number` is optional; updates the existing `vouchers.utr_number` column if provided.

---

## Awaiting Payments Page (`/payments`)

- Lists all vouchers where `status = 'completed'` AND `payment_mode != 'Cash'` AND `paid_at IS NULL`.
- Sorted by `completed_at ASC` (oldest first).
- Vouchers where `completed_at < now() - 48 hours` display an amber ⚠ **Pending 2+ days** badge.
- Pay Now button on each row opens PayNowModal with full entity payment data.
- Accessible to Admin / Super Admin / Accounts roles; Viewer and Auditor are redirected.

---

## Settings — Pay From Accounts (`AdminPanel → Pay-From Accounts tab`)

- Add: enter a label, press Enter or click **+ Add**. Duplicate labels (case-insensitive) are rejected.
- Remove: confirmation before deletion.
- Labels populate the `<datalist>` autocomplete in the Pay Now modal's **Paid From Account** field.
- Super Admin only (AdminPanel access gate).

---

## Data Flow Summary

```
AdminPanel → Pay-From Accounts tab
  → company_payment_accounts (add / delete)
         ↓
PayNowModal → Paid From Account datalist autocomplete
           → vouchers.paid_from_account (on Mark as Paid)

Voucher list (status=completed, mode≠Cash, authorised role)
  → 💳 Pay Now button
  → PayNowModal
      ├── UPI + desktop  → QR code (api.qrserver.com, 220×220)
      ├── UPI + mobile   → GPay deep link + upi:// deep link
      │                    visibilitychange → auto-open Mark Paid
      └── Account Transfer
            ├── desktop  → bank details card + net banking URL
            └── mobile   → bank details card + bank app launcher
                           (from paid_from_account field value)
          → Mark Paid panel → vouchers.paid_from_account / paid_at / utr_number

AwaitingPayments (/payments)
  → completed + unpaid vouchers, oldest first
  → ⚠ flag if completed_at > 48h ago
  → Pay Now button per row
```

---

## Payee Fields Required for Pay Now

| Payment Mode | Required Entity Fields |
|---|---|
| UPI | `upi_id` |
| Bank / NEFT / RTGS / IMPS / Cheque | `account_number`, `ifsc`, `bank_name` |

Set when creating or editing a payee entity via the Entity management UI.

---

## Limitations

| Limitation | Detail |
|---|---|
| **No payment confirmation** | UPI deep links do not return a success/failure callback. Staff must manually mark paid. |
| **UPI on desktop** | `upi://` links silently fail on desktop — QR code fallback is used. |
| **Bank details are manual** | No API to auto-fetch VPA or account details. Set during entity onboarding. |
| **Bank app launcher (Android only)** | The Android intent approach works only on Android. Not applicable on iOS or desktop. |

---

## Future Upgrade Path

If automatic payment confirmation is required:

```
Pramaana → Razorpay / Cashfree API → payment link or collect request
Payee / Admin pays → gateway webhook → Pramaana auto-sets paid_at + utr_number
```

This would add a webhook endpoint and a payment-gateway config screen but requires no schema changes beyond what is already in place.
