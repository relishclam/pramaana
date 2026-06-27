# Pay Now — Voucher Payment Initiation Workflow

## Overview

After a voucher is OTP-verified and moves to **Completed**, Admin / Super Admin can trigger a payment directly from the dashboard via a **"Pay Now"** button. The button opens the appropriate payment app with payee details and amount pre-filled.

---

## Feasibility by Payment Mode

| Payment Mode | Deep Link Support | Notes |
|---|---|---|
| **UPI** | ✅ Full — universal `upi://` protocol | Works on all UPI apps (GPay, PhonePe, BHIM, Paytm, any bank app) |
| **IMPS** | ⚠️ Partial — no universal standard | Show a pre-filled copy card for manual entry |
| **NEFT** | ⚠️ Partial — no universal standard | Show a pre-filled copy card for manual entry |
| **RTGS** | ⚠️ Partial — no universal standard | Show a pre-filled copy card for manual entry |

> **Note:** UPI deep links only open on **mobile** (Android / iOS). On desktop, show a QR code as fallback.

---

## End-to-End Flow

```
Voucher OTP Verified
        │
        ▼
Status → "completed"
        │
        ▼
Appears in Admin / Super Admin → Completed Vouchers List
        │
        ▼
Admin clicks "Pay Now"
        │
        ├─ Payment mode = UPI ──────────────────────────────────────────────────────┐
        │                                                                           │
        │   Build deep link:                                                        │
        │   upi://pay?pa=<VPA>&pn=<Name>&am=<Amount>&cu=INR&tn=Voucher+<No>        │
        │                                                                           │
        │   On mobile → UPI app chooser opens → user approves                      │
        │   On desktop → QR code displayed → user scans with phone                 │
        │                                                                           ▼
        └─ Payment mode = NEFT / RTGS / IMPS ──────────────────────────────────────┐
                                                                                    │
            Show pre-filled bank details card:                                      │
            ┌─────────────────────────────────┐                                    │
            │  Payee: <Name>                  │                                    │
            │  Account No: <XXXXXXXX>         │                                    │
            │  IFSC: <XXXXXXXXX>              │                                    │
            │  Bank: <Bank Name>              │                                    │
            │  Amount: ₹<Amount>              │                                    │
            │  Reference: <Voucher No>        │                                    │
            │  [Copy All Details]             │                                    │
            └─────────────────────────────────┘                                    │
                                                                                    ▼
                                                                    Admin completes payment
                                                                    manually in banking app
```

---

## What Needs to Be Built

### 1. Database — Add Payment Details to Entities

**New migration file:** `036_entity_payment_details.sql`

```sql
ALTER TABLE registry.entities
  ADD COLUMN IF NOT EXISTS upi_vpa         TEXT,         -- e.g. name@okicici
  ADD COLUMN IF NOT EXISTS bank_account_no TEXT,
  ADD COLUMN IF NOT EXISTS bank_ifsc       TEXT,
  ADD COLUMN IF NOT EXISTS bank_name       TEXT;
```

---

### 2. Entity Edit UI

Add a **Payment Details** section to the entity edit form (AdminPanel or entity management page):

| Field | Type | Example |
|---|---|---|
| UPI VPA | Text input | `rahul.sharma@okicici` |
| Bank Account No | Text input | `012345678901` |
| IFSC Code | Text input | `ICIC0001234` |
| Bank Name | Text input | `ICICI Bank` |

---

### 3. Completed Vouchers List in Admin Dashboard

- Filter vouchers where `status = 'completed'` (OTP verified)
- Show columns: Voucher No · Payee · Amount · Payment Mode · Date · **Pay Now**
- "Pay Now" button behaviour depends on `payment_mode` stored on the voucher

---

### 4. UPI Deep Link Builder

```typescript
function buildUpiUrl(
  vpa:       string,
  payeeName: string,
  amount:    number,
  voucherNo: string,
): string {
  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `Voucher ${voucherNo}`,
  })
  return `upi://pay?${params}`
}
```

**Mobile:** `<a href={upiUrl}>Pay Now via UPI</a>` — opens UPI app chooser  
**Desktop:** Render a QR code of the same URL using a library like `qrcode`

---

### 5. Bank Transfer Copy Card (NEFT / RTGS / IMPS)

```tsx
<div className={styles.bankCard}>
  <div className={styles.bankRow}><span>Payee</span><strong>{entity.display_name}</strong></div>
  <div className={styles.bankRow}><span>Account No</span><strong>{entity.bank_account_no}</strong></div>
  <div className={styles.bankRow}><span>IFSC</span><strong>{entity.bank_ifsc}</strong></div>
  <div className={styles.bankRow}><span>Bank</span><strong>{entity.bank_name}</strong></div>
  <div className={styles.bankRow}><span>Amount</span><strong>₹{amount}</strong></div>
  <div className={styles.bankRow}><span>Reference</span><strong>{voucherNo}</strong></div>
  <button onClick={() => copyAll(...)}>Copy All Details</button>
</div>
```

---

## Limitations

| Limitation | Detail |
|---|---|
| **No payment confirmation** | UPI deep links do not return a success/failure callback. Pramaana cannot auto-confirm payment. A payment gateway (Razorpay, Cashfree) would be needed for that — significant additional complexity and cost. |
| **UPI on desktop** | `upi://` links silently fail on desktop. Must show a QR code fallback. |
| **VPA / bank details are manual** | There is no API to auto-fetch a payee's UPI VPA. Accounts staff must enter it when onboarding the entity. |
| **IMPS / NEFT / RTGS** | No universal deep link standard exists. Only a copy card is possible. |

---

## Implementation Effort

| Task | Effort |
|---|---|
| DB migration — UPI + bank fields on entities | ~10 min |
| Entity edit form — payment details section | ~1–2 hrs |
| Admin completed vouchers list with Pay Now button | ~2–3 hrs |
| UPI deep link builder | ~15 min |
| Bank copy card (NEFT / RTGS / IMPS) | ~30 min |
| Desktop QR code fallback for UPI | ~1 hr |
| **Total** | **~1 day** |

---

## Future Upgrade Path

If confirmed payment status is needed later, integrate a payment gateway:

```
Pramaana → Razorpay / Cashfree API → Payment link sent to Admin
Admin pays via link → Gateway sends webhook → Pramaana marks voucher as "paid"
```

This adds a `paid_at`, `payment_reference` column to vouchers and a webhook endpoint, but is a separate phase of work.
