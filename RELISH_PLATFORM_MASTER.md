# Relish Platform — Master Reference Document
**Last Updated:** June 12, 2026  
**Maintained by:** Motty Philip · motty.philip@gmail.com  
**Update this file** after every significant build session in Suite or Pramaana.

---

## 0. How to Use This Document

This is the single source of truth for the entire Relish digital platform. It lives in both repos:
- `relish-suite/RELISH_PLATFORM_MASTER.md`
- `pramaana/RELISH_PLATFORM_MASTER.md`

**Before every Claude Code session:** paste the relevant sections of this document as context.  
**After every Claude Code session:** update the STATUS columns and PENDING ITEMS.

---

## 1. Platform Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SINGLE SUPABASE PROJECT                      │
│                  mmkbknnzgpvsqgnynrbe (relish-suite)            │
│                                                                 │
│  schema: registry   → companies, entities, entity_roles,       │
│                        profiles, company_users, biometrics,     │
│                        attendance, onboarding_queue, visitors,  │
│                        sequence_counters, app_access            │
│                                                                 │
│  schema: suite      → purchase_orders, po_line_items,          │
│                        invoices, invoice_line_items,            │
│                        invoice_packing_lines, products,         │
│                        delivery_addresses, tally_config,        │
│                        tally_exports, kpi_snapshots,            │
│                        activity_feed, shell_stock               │
│                                                                 │
│  schema: pramaana   → ledger_groups, ledgers, cost_centres,    │
│                        voucher_types, approval_rules,           │
│                        approval_actions, vouchers,              │
│                        voucher_entries, voucher_line_items,     │
│                        suspense_settlements, voucher_attachments│
│                        capture_sessions, notifications,         │
│                        push_subscriptions, otp_sessions,        │
│                        settlement_sessions, gst_details,        │
│                        period_locks, audit_log                  │
│                                                                 │
│  schema: clamflow   → (DDL defined, not yet migrated)          │
└─────────────────────────────────────────────────────────────────┘

Three read-only external Supabase projects:
  ewbguvwrejdvlhzcqlbp  →  Relish Approvals (legacy payments — READ ONLY)
  idwgenbkguejgwtzbicu  →  ClamFlow production app (READ ONLY)
```

---

## 2. The Three Companies

| Code | Legal Name | Type | State | GSTIN |
|------|-----------|------|-------|-------|
| RHHF | Relish Hao Hao Chi Foods | Partnership | Kerala | 32AAUFR0742E1ZB |
| RFPL | Relish Foods Pvt Ltd | Private Limited | Tamil Nadu | 33AAACR7749E2ZD |
| CW | CalciWorks | Division of RHHF | Kerala | (uses RHHF GSTIN) |

**CalciWorks is NOT a separate company.** It is:
- A cost centre in `pramaana.cost_centres` (code: `CW_DIV`) under RHHF
- A department filter in Suite and ClamFlow
- Never appears as a company option in any dropdown

---

## 3. The Two Applications

### 3.1 Relish Suite
- **Repo:** `relishclam/relish-suite`
- **URL:** `https://relishsuite.vercel.app`
- **Tech:** React 18 + Vite + TypeScript + plain CSS modules
- **Purpose:** Operations — Purchase Orders, Invoices, Entity Master, Tally Export, CalciWorks

### 3.2 Pramaana
- **Repo:** `relishclam/pramaana`
- **URL:** `https://pramaana-tau.vercel.app`
- **Tech:** React 18 + Vite + TypeScript + CSS modules
- **Purpose:** Accounting — Ledgers, Vouchers, Approvals, Suspense, Financial Reports

Both apps share the same Supabase project (`mmkbknnzgpvsqgnynrbe`) and the same auth (`registry.profiles` + `registry.company_users`). A user logs in once — the JWT is valid across both apps.

---

## 4. Auth Pattern (Same in Both Apps)

```typescript
// After login, always fetch:
supabase.schema('registry').from('profiles')
  .select('*').eq('id', user.id).single()

supabase.schema('registry').from('company_users')
  .select('*, company:companies(*)').eq('user_id', user.id)

// is_super_admin → from profiles.is_super_admin
// per-company role → from company_users.role
// valid roles: super_admin | admin | accounts | auditor | hr | operations | viewer
```

**Super admin** (`is_super_admin = TRUE` on profiles) has access to all companies and all features across both apps.

---

## 5. Entity Model — The Foundation

All people and organisations live in `registry.entities`. This is the single record for every vendor, customer, staff member, and management person across the entire Relish Group.

```
registry.entities          → One record per person / organisation
registry.entity_roles      → What role does that entity play in which company?

Example: "Coastal Suppliers Pvt Ltd"
  entities row: id, display_name, gstin, mobile, bank details
  entity_roles rows:
    → role='Vendor',   company_id=RHHF → appears in Suite PO vendor dropdown
    → role='Supplier', company_id=CW   → appears in ClamFlow supplier list
    → role='Vendor',   company_id=RHHF → appears in Pramaana payee search
```

**This is why Suite Onboarding must be built before Pramaana can be fully used.** Without entities in `registry.entities`, Pramaana's payee typeahead returns nothing.

### Entity Role Values
`Management | Staff | Vendor | Supplier | Customer | Auditor | Government | Fisher | Contractor`

### Entities, Personnel and Vendors — What's the Difference?

These three views in Suite Master Data are often confused:

| Tab | Shows | Source | Editable |
|-----|-------|--------|----------|
| **Vendors** | entity_roles WHERE role=Vendor only | registry schema | Yes |
| **Buyers** | entity_roles WHERE role=Customer only | registry schema | Yes |
| **Entities** | ALL roles — Vendor, Customer, Staff, Management, Government, Contractor, Fisher, Auditor, Supplier | registry schema | Yes |
| **Personnel** | ClamFlow plant workers at RHHF Panavally only | ClamFlow DB (READ-ONLY) | No |

**Entities is the master view.** It is NOT a vendors list. It shows every person and organisation registered against the active company, regardless of role.

**Personnel tab** is a read-only view of workers from the legacy ClamFlow database. These people are not yet in `registry.entities`. They cannot be paid via Pramaana until the Plant Worker Onboarding module (Phase 2.5) is built.

### Who Can Be a Payee in Pramaana?
Any entity with role NOT 'Customer'. The payee typeahead filters:
```typescript
.in('role', ['Vendor','Supplier','Staff','Management','Contractor','Government','Auditor'])
```

**Payee search is GLOBAL — not scoped to the active company (June 12, 2026).** An entity registered under RFPL appears in RHHF payee search and vice versa. This reflects reality: Motty Philip, Anil Kumar, Sebin Jose and others work across both companies. The voucher itself remains company-scoped.

---

## 6. Sequence Numbers

All document numbers come from `registry.sequence_counters` via two functions:

| Function | Format | Used For |
|----------|--------|----------|
| `registry.next_cal_sequence` | `RFPL/PO/2026/0001` | Suite: POs, Invoices |
| `registry.next_fy_sequence` | `RHHF/PYMT/2526/0001` | Pramaana: Vouchers |

**In Supabase JS:**
```typescript
// Suite
supabase.schema('registry').rpc('next_cal_sequence', {
  p_company_id: company.id,
  p_company_code: company.code,  // 'RHHF' or 'RFPL'
  p_prefix: 'PO'                 // or 'INV', 'GINV'
})

// Pramaana
supabase.schema('registry').rpc('next_fy_sequence', {
  p_company_id: company.id,
  p_company_code: company.code,
  p_prefix: 'PYMT'              // or 'RCPT', 'JNL', 'SUS', etc.
})
```

---

## 7. Relish Suite — Module Map

### 7.1 Modules Built ✅

| Module | Route | Description |
|--------|-------|-------------|
| Auth | `/login` | Supabase email/password |
| Company Select | `/select-company` | Pick RHHF or RFPL |
| Dashboard | `/dashboard` | KPI cards, activity feed |
| Purchase Orders | `/purchase-orders` | Create/edit POs, PDF, Tally export |
| Commercial Invoices | `/invoices` | Export invoices with packing list |
| GST Tax Invoice | `/gst-invoices` | RFPL factory lease to Peninsular Fisheries |
| CalciWorks | `/calciworks` | Shell stock ledger (RHHF division) |
| Master Data | `/master-data` | Vendors, Buyers, Products, Delivery Addresses, **Entities** |
| Tally Export | `/tally-export` | Reads Relish Approvals (READ ONLY), generates XML |
| User Management | `/admin/users` | super_admin only |
| Settings | `/settings` | Profile + company settings |

### 7.2 Master Data Tabs (in `/master-data`)

| Tab | Table | Notes |
|-----|-------|-------|
| Companies | `registry.companies` | super_admin only |
| Vendors | `registry.entity_roles` WHERE role=Vendor | Subset of Entities — legacy simplified view |
| Buyers | `registry.entity_roles` WHERE role=Customer | Subset of Entities — legacy simplified view |
| Products | `suite.products` | default_unit field (not 'unit') |
| Delivery Addresses | `suite.delivery_addresses` | pincode field (not 'postal_code') |
| **Entities** | `registry.entities` + `entity_roles` — ALL roles | **BUILT June 2026** — master view for all people and organisations |
| Tally Config | `suite.tally_config` | Per-company Tally XML export settings |
| ClamFlow Suppliers | ClamFlow `suppliers` + `person_records` (READ-ONLY) | Raw material suppliers at Panavally plant |
| Personnel | `registry.entities` WHERE `authorized_locations` includes `panavally_plant` | Plant workers, fishers & plant-facing suppliers for RHHF Panavally. **Owned by Suite.** Onboarded via Phase 2.5 form. Not sourced from ClamFlow. |

### 7.3 Key Lib Files

| File | Schema | Purpose |
|------|--------|---------|
| `src/lib/supabase.js` | — | Suite DB client (mmkbknnzgpvsqgnynrbe) |
| `src/lib/supabaseApprovals.js` | — | **READ ONLY** — ewbguvwrejdvlhzcqlbp |
| `src/lib/supabaseClamFlow.js` | — | **READ ONLY** — idwgenbkguejgwtzbicu |
| `src/lib/vendors.js` | registry | entity_roles WHERE role='Vendor' |
| `src/lib/buyers.js` | registry | entity_roles WHERE role='Customer' |
| `src/lib/products.js` | suite | suite.products |
| `src/lib/deliveryAddresses.js` | suite | suite.delivery_addresses |
| `src/lib/purchaseOrders.js` | suite | suite.purchase_orders + po_line_items |
| `src/lib/invoices.js` | suite | suite.invoices + line items |
| `src/lib/auditLog.js` | registry | registry.audit_log |
| `src/lib/permissions.js` | — | Role → permission map (source of truth) |
| `src/lib/entities.js` | registry | registry.entities + entity_roles — full CRUD, dup check, multi-role |

### 7.4 Suite Schema Query Pattern
```javascript
// ALWAYS use schema prefix — never use public schema
supabase.schema('registry').from('entities')
supabase.schema('suite').from('purchase_orders')
// Never: supabase.from('vendors') — old pattern, will fail
```

### 7.5 Cross-Schema FK Joins
PostgREST cannot join across schemas. Always fetch separately and merge in JS:
```javascript
// Fetch PO, then fetch entity by vendor_entity_id from registry.entities
const po = await fetchPO(id)
const entity = await supabase.schema('registry').from('entities')
  .select('*').eq('id', po.vendor_entity_id).single()
```

### 7.6 Migrations Applied to Production

| File | Status | Notes |
|------|--------|-------|
| 001_create_schemas.sql | ✅ Applied | registry, suite, pramaana, clamflow + vector |
| 002_registry_schema.sql | ✅ Applied | Companies (RHHF, RFPL seeded), profiles, entities |
| 003_suite_schema.sql | ✅ Applied | POs, invoices, products, delivery addresses, tally |
| 004_migrate_public_to_schemas.sql | ✅ Applied | Moved existing data |
| 005_rls_and_grants.sql | ✅ Applied (patched) | Non-recursive RLS via is_super_admin() |
| 006_rls_fixes.sql | ✅ Applied | Documents 4 dashboard fixes |
| 007_calciworks_shell_stock.sql | ✅ Applied | shell_stock table + GST counter at 35 |
| 010_entities_bank_swift.sql | ✅ Applied | ADD COLUMN bank_swift on registry.entities |
| 011_entities_local_registration.sql | ✅ Applied | ADD COLUMN local_reg_number + local_tax_number on registry.entities |
| 022_seed_entities_from_approvals.sql | ✅ Applied (June 12 2026, corrected version with RESET block) | 110 entities seeded — Vendors, Staff, Management, Government for RFPL + RHHF. Superseded earlier uncorrected run. |

### 7.7 Entity Model — Implementation Notes (June 2026)

**Multi-role entities:** A single `registry.entities` row can have multiple `entity_roles` rows (e.g. FoodStream Ltd. is both Vendor and Customer). The `UNIQUE(entity_id, company_id, role)` constraint prevents duplicate roles per company.

**Duplicate check on create:** Before inserting, `searchDuplicateEntity()` in `entities.js` checks GSTIN → mobile → display_name (in priority order). If a match is found the UI presents an inline warning with an "Add [Role] to this" option — avoiding duplicate entity records.

**Country-aware form fields:**

| Country | Registration fields | Bank routing field |
|---|---|---|
| India (or blank) | GSTIN (role-conditional) + PAN | IFSC Code |
| Any other | Company Reg. No. + Tax/VAT Reg. No. | SWIFT / BIC Code |

Overseas registration formats (Company Reg. No.):
- Hong Kong: BRC No. · Singapore: UEN · China: USCC (18-char) · Japan: Corporate No. (13-digit) · Thailand: CR No. · UAE: CR No. · UK: Companies House No.

For China and Japan the tax number is the same as the company registration number — leave Tax/VAT Reg. blank.

**Pramaana Ledger Name:** The `tally_ledger` column in `entity_roles` is displayed as "Pramaana Ledger Name" in the UI. It still powers Tally XML export during cut-over AND will be the Pramaana ledger reference post cut-over.

**Pre-deployment reset:** `supabase/scripts/pre_deployment_data_reset.sql` — run once manually in Supabase SQL editor before functional go-live. Clears all test entities, vouchers, POs, sequences. Preserves companies, users, ledger_groups, voucher_types.

**Entity seed corrections (June 12 2026):** The definitive `022_seed_entities_from_approvals.sql` includes a RESET block (deletes all `source_app IN ('approvals','manual')` rows before reinserting — does NOT touch `source_app='suite'`). Corrections baked into this version:

- ~30 individual humans (electricians, plumbers, drivers, staff etc.) corrected from ORGANISATION → PERSON
- Sherine Motty → Management (Director, RHHF + RFPL), not Vendor
- Tarun Philip → Management (Director, RFPL)
- Motty Philip → single PERSON entity with Management roles on both RHHF (Managing Partner) and RFPL (Executive Director)
- KSEB and KSIDC → Government role, not Vendor
- Vijayan / Vijayan-Newspaper duplicate merged into single entity with alias
- Veda Associates → bank_name fixed (was incorrectly stored in bank_account_number column)
- All Indian mobiles standardised to `+91XXXXXXXXXX` (213 of 214 entities; VCT Traders mobile flagged as likely data-entry error — `99947151524` is 11 digits, needs manual verification)

**This is the canonical seed file going forward.** Any future re-seed should start from this version, not earlier uncorrected copies.

---


### 8.1 Modules Built ✅

| Module | Route | Who Can Access |
|--------|-------|---------------|
| Login | `/login` | Public |
| Company Select | `/select-company` | Authenticated |
| Dashboard | `/` | All roles |
| Ledger Master | `/ledgers` | admin, accounts, auditor, super_admin |
| Voucher Entry | `/vouchers/new` | admin, accounts, super_admin |
| Voucher Register | `/vouchers` | admin, accounts, auditor, super_admin |
| Approval Queue | `/approvals` | admin, accounts, auditor, super_admin |
| Suspense Register | `/suspense` | admin, accounts, auditor, super_admin |
| New Suspense | `/suspense/new` | admin, accounts, super_admin |
| Settlement Page | `/settle/:token` | **Public — no login** |
| Bill Relay Capture | `/relay` | **Public — no login** |

### 8.2 Modules Pending — Phase 3

| Module | Route | Notes |
|--------|-------|-------|
| Trial Balance | `/reports/trial-balance` | Query voucher_entries by ledger, date range |
| Ledger Statement | `/reports/ledger` | Single ledger transaction history |
| Day Book | `/reports/day-book` | All vouchers by date range |
| P&L Statement | `/reports/pl` | INCOME minus EXPENSE nature groups |
| Balance Sheet | `/reports/balance-sheet` | ASSET vs LIABILITY + CAPITAL |
| Tally XML Export | `/reports/tally-export` | Phase 3 |
| GST Reports | `/reports/gst` | Phase 4 |
| TDS Reports | `/reports/tds` | Phase 5 |

### 8.3 Pramaana Key Lib Files

| File | Purpose |
|------|---------|
| `src/lib/supabase.ts` | Supabase client (same project as Suite) |
| `src/lib/vouchers.ts` | VoucherType, fetchVoucherTypes, fetchBankLedgers, searchLedgers, getNextSequence, saveDraftVoucher, submitVoucher, formatIndianCurrency, PaymentAccount, fetchPaymentAccounts |
| `src/lib/vouchers-list.ts` | fetchVouchers (paginated+filtered), recallVoucher, deleteVoucher, submitDraftVoucher |
| `src/lib/approvals.ts` | fetchPendingVouchers, fetchVoucherFull, approveVoucher, rejectVoucher, fetchPendingCount |
| `src/lib/suspense.ts` | Full suspense workflow — see Section 8.5 |
| `src/lib/attachments.ts` | fetchVoucherAttachments, signed URLs |
| `src/lib/sms.ts` | sendSettlementLinkSms, sendPaymentApprovalOtpSms |
| `src/lib/whatsapp.ts` | buildWhatsAppLink, settlement link share — see Section 8.8 |
| `src/lib/permissions.ts` | getPermissions(role) → Permissions object |
| `src/contexts/AuthContext.tsx` | user, profile, activeCompany, activeRole, signOut |
| `src/contexts/ApprovalContext.tsx` | pendingCount, refreshCount |

### 8.4 Pramaana Schema Query Pattern
```typescript
// ALWAYS use schema prefix
supabase.schema('pramaana').from('vouchers')
supabase.schema('registry').from('entities')   // for entity lookups
supabase.schema('registry').rpc('next_fy_sequence', {...})
// Never: supabase.from('vouchers') — will query public schema, fail
```

### 8.5 Suspense Advance Functions (suspense.ts)

| Function | Description |
|----------|-------------|
| `fetchSuspenseVouchers(companyId, userId, role, page)` | List of suspense advances |
| `fetchSuspenseSession(advanceVoucherId)` | Settlement session for one advance |
| `fetchSuspenseSettlements(advanceVoucherId)` | Expense entries for one advance |
| `createSuspenseVoucher(payload, entries)` | Create advance (status=pending_approval) |
| `approveSuspenseVoucher(voucherId, companyId, code, prefix, userId)` | Generates SUS number, status=open |
| `rejectSuspenseVoucher(voucherId, userId, reason)` | status=rejected |
| `createOrRefreshSession(companyId, entityId, userId, voucherId, amount)` | Create/rotate token |
| `buildSettlementUrl(token)` | Returns `{origin}/settle/{token}` |
| `addTopUp(voucherId, companyId, entityId, amount, desc, userId)` | Increase advance + reopen if closed |
| `approveSettlement(settlementId, userId)` | Approve entry, recalculate balance |
| `rejectSettlement(settlementId, userId, reason)` | Reject entry |
| `getSessionByToken(token)` | Public — validate token, return PublicSession |
| `submitExpenseEntry(payload)` | Public — staff submits expense (anon) |

### 8.6 Migrations Applied to Production

| File | Status | Notes |
|------|--------|-------|
| 008_pramaana_schema.sql | ✅ Applied | 19 tables, 4 triggers, RLS, ledger_groups seed (25 rows), voucher_types seed (6 rows) |
| 008a_fix_prevent_posted_edit.sql | ✅ Applied | Patch: fn_prevent_posted_edit DELETE path |
| 009_ledger_bank_fields.sql | ✅ Applied | is_bank_account, bank_name, account_number, ifsc on pramaana.ledgers |
| 010_seed_test_ledgers.sql | ✅ Applied | Test ledgers for RHHF (SBI, Cash, Creditors, Expenses) |
| 021_suspense_schema_extension.sql | ✅ Applied | is_suspense, suspense_balance on vouchers; token, advance_voucher_id on settlement_sessions; entry_type, description on suspense_settlements; anon RLS policies |

### 8.7 Storage

| Bucket | Access | Used For |
|--------|--------|---------|
| `voucher-attachments` | Private — signed URLs | Bills, receipts, invoices attached to vouchers |

### 8.8 Messaging Integration

#### SMS via 2Factor (OTP only)

| Template | 2Factor | Vilpower/DLT | Variables |
|----------|:-------:|:------------:|-----------|
| `Pramaana-Payment-Approval` | ✅ | ✅ | XXXX = OTP |

> **Decision:** SMS is used exclusively for Payment Approval OTP — the only template that needs to remain on 2Factor + Vilpower/DLT. Settlement-Link and Payment-Confirmed SMS templates are superseded by WhatsApp (below) and do not need Vilpower resubmission.

Edge Function: `api/send-sms.ts` (Vercel)  
Env var: `TWOFACTOR_API_KEY` (set in Vercel dashboard)

#### WhatsApp — Interim via `wa.me` deep link (no API required)

**Status: Implemented June 12 2026** (see Section 21.3, P1)

`https://wa.me/{mobile}?text={url_encoded_message}` opens WhatsApp Web or the WhatsApp app with the message pre-filled in the chat box. The user reviews and taps Send manually — no Business API approval needed, works with any regular WhatsApp number.

```typescript
function buildWhatsAppLink(phone: string, message: string): string {
  const cleanPhone = phone.replace(/[^\d]/g, '') // strip +, spaces — wa.me wants digits only
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
}
```

**Settlement Link template:**
```
🧾 *Relish — Advance Settlement*

Hi {{name}},

You have a pending advance of *₹{{amount}}* from RHHF for {{purpose}}.

Please submit your expenses using the link below:
👉 {{settlement_url}}

_This link is valid for 7 days. Tap "Add to Home Screen" to save it for quick access._

— Relish Accounts
```

> **Note:** No "Payment Confirmed" message is sent. If a payee has not received a payment, they will contact the office directly — a confirmation message is unnecessary overhead.

"Send via WhatsApp" button appears next to the existing settlement link in the Suspense Advances settlement screen. If the entity has no mobile number on record, the button is hidden and "No mobile number on file" is shown instead.

#### WhatsApp — Full Business API via 2Factor (Phase 2)

**Status: Onboarding initiated June 12 2026** — 2Factor connect request submitted via `2factor.in/v3/lp/official-whatsapp-business-api-india.php`. Same 2Factor account/API key as SMS — no separate Meta Developer integration needed. Typical approval window 24-48h for existing customers.

Once approved:
- `api/send-whatsapp.ts` Vercel Edge Function
- Env vars: `TWOFACTOR_WHATSAPP_KEY`, `TWOFACTOR_WHATSAPP_PHONE_ID`
- The Settlement Link template above gets submitted for Meta template approval (via 2Factor) — same content, now with a tappable URL button instead of a plain link
- `messaging.ts` becomes channel-aware: WhatsApp preferred for settlement links, SMS retained only for OTP
- The "Send via WhatsApp" button in Pramaana switches from opening `wa.me` to calling `api/send-whatsapp.ts` directly — same message content, no UI rework needed

---

## 9. How Suite and Pramaana Interact

This is the critical section. The two apps are NOT independent.

### 9.1 Data Flow: Entity Creation → Pramaana Payee

```
Suite: Create Vendor (Onboarding → Entities tab)
  ↓ INSERT registry.entities (name, mobile, bank, GSTIN)
  ↓ INSERT registry.entity_roles (role='Vendor', company_id=RHHF)
  ↓
Pramaana: Voucher Entry → Party typeahead
  ↓ SELECT registry.entity_roles WHERE role IN (Vendor, Staff, ...)
  ↓ JOIN registry.entities
  → Vendor appears in dropdown immediately ✅
```

### 9.2 Data Flow: Suite Invoice → Pramaana Receivable

```
Suite: Commercial Invoice created (status=final)
  → Customer owes Relish money
  → Accountant must create a Sales voucher in Pramaana:
      Dr: Sundry Debtors (customer ledger)
      Cr: Sales (income ledger)
  → When customer pays, create Receipt voucher:
      Dr: Bank
      Cr: Sundry Debtors
```

*(Phase 3: automate this — Suite invoice triggers draft Sales voucher in Pramaana)*

### 9.3 Data Flow: Suite PO → Pramaana Purchase Payable

```
Suite: Purchase Order approved + goods received
  → Relish owes vendor money
  → Accountant creates Purchase voucher in Pramaana:
      Dr: Purchase Accounts
      Cr: Sundry Creditors (vendor ledger)
  → Payment voucher when paid:
      Dr: Sundry Creditors
      Cr: Bank
  → PO reference number goes in voucher ref_document_number field
```

### 9.4 Data Flow: GST Invoice → Pramaana

```
Suite: GST Tax Invoice (RFPL factory lease to Peninsular Fisheries)
  → Created monthly, PDF generated
  → Accountant creates Sales voucher in Pramaana:
      Dr: Sundry Debtors (Peninsular Fisheries ledger)
      Cr: Rental Income
      Cr: CGST Payable (if intra-state)
      Cr: SGST Payable (if intra-state)
```

### 9.5 Data Flow: CalciWorks Shell Stock → Pramaana

```
Suite: CalciWorks page records shell stock receipts/sales
  → Shell sales create revenue
  → Accountant creates Sales voucher in Pramaana tagged to CW_DIV cost centre:
      Dr: Sundry Debtors
      Cr: CalciWorks Sales (income ledger)
```

---

### 9.6 Registry as Platform Master — ClamFlow Integration Plan

#### The North Star

```
Suite Registry (registry.entities) = The ONE Master Record.
ALL onboarding happens here.
ALL apps READ from here. No app owns its own person data.

         Suite Registry
              │
    ┌─────────┼──────────┬──────────────┐
    ▼         ▼          ▼              ▼
 Pramaana  ClamFlow   Future App    Future App
 (reads)   (reads)    (reads)       (reads)
```

#### Who Onboards Whom

| Category | Onboarding Flow | Who Does It |
|----------|----------------|-------------|
| Management (Directors, Partners) | Suite Entities tab | admin / super_admin |
| Office Staff (accounts, HR, ops) | Suite Entities tab | admin / HR role |
| Vendors, Customers, Government, Auditors | Suite Entities tab | admin / accounts |
| Plant Employees + Daily Wage Workers (RHHF Panavally) | Suite Plant Worker Onboarding — Phase 2.5 | Plant supervisor (PWA on phone at plant) |
| Fishers / Boat Operators | Suite Plant Worker Onboarding — Phase 2.5 | Plant supervisor |
| Raw Material Suppliers (clams, coir, shell) | Suite Plant Worker Onboarding — Phase 2.5 | Plant supervisor |
| Overseas / Foreign entities | Suite Entities tab (overseas mode) | admin |

**Single Rule:** Every person and organisation lands in `registry.entities` before any other system can reference them. ClamFlow does not own people. Approvals does not own payees.

#### Deduplication Keys (already in schema)

| Column on `registry.entities` | Purpose |
|-------------------------------|---------|
| `legacy_clamflow_person_id` | Cross-reference to ClamFlow `person_records.id` for Phase 3 integration. **Not a migration key — ClamFlow is not yet in production and has no real data.** |
| `legacy_clamflow_supplier_id` | Links to ClamFlow `suppliers.id` |
| `legacy_approvals_payee_id` | Links to Approvals payee — used in 022_seed_entities_from_approvals.sql (June 2026) |

#### ClamFlow Integration — Three Phases

> **Correction (June 12 2026):** ClamFlow is NOT yet in production. All data in `idwgenbkguejgwtzbicu` is test data. There is nothing to migrate. Suite is the source of truth from day one — workers are onboarded directly in Suite, and ClamFlow will read from Suite when it goes live.

**Phase 1 — Suite Onboards Everything (now, via Phase 2.5):**
- All plant workers, fishers, and plant-facing suppliers are created in `registry.entities` directly via the Phase 2.5 onboarding form
- No "Register in Suite" migration button — there is no production ClamFlow data to import
- Personnel tab in Suite shows workers from `registry.entities` WHERE `authorized_locations` includes `panavally_plant`
- Workers onboarded in Suite become valid Pramaana payees immediately

**Phase 2 — Plant Worker Onboarding form in Suite (Phase 2.5):**
- Dedicated onboarding form for Staff / Fisher / Supplier roles (mobile-first PWA for plant floor)
- RFID tag assignment (requires migration 023 — see Known Issues)
- Face photo capture → AWS Rekognition `IndexFaces` API → `rekognition_face_id` stored in `registry.biometrics`
- AWS Rekognition collection: `relish-registry` (single collection for all Relish people, `ap-south-1`)
- Aadhaar last-4 via QR scan — **parse on-device only, send only last-4 to server, NEVER the full 12-digit number**
- `suspense_eligible = TRUE` toggle for daily wage advance payments
- `authorized_locations` multi-select (e.g. `panavally_plant`)
- Accessible to `hr` and `operations` roles
- **Mobile-first PWA** — designed for use on a phone at the plant floor, not a desktop

**Phase 3 — ClamFlow Reads from Registry (before ClamFlow goes to production):**
- ClamFlow face scanner calls AWS Rekognition `SearchFacesByImage` on collection `relish-registry` → receives `rekognition_face_id` → looks up `registry.biometrics` → gets `entity_id`
- ClamFlow attendance events write to `registry.attendance`
- ClamFlow supplier lookup reads `registry.entities WHERE role='Supplier' AND authorized_locations ∋ 'panavally_plant'`
- ClamFlow `person_records` used only for ClamFlow app system accounts (staff who log into the ClamFlow UI) — not for people master data
- **The OpenCV / Haar cascade implementation in `face_recognition_unified.py` must be replaced with AWS Rekognition before ClamFlow goes to production.** The current code generates a 256-bin greyscale histogram — it is not face recognition and cannot identify individuals.

---

## 10. Permissions Map

### Suite (src/lib/permissions.js)

| Permission | super_admin | admin | accounts | auditor | hr | operations | viewer |
|-----------|:-----------:|:-----:|:--------:|:-------:|:--:|:----------:|:------:|
| canCreatePO | ✅ | ✅ | ✅ | | | | |
| canApprovePO | ✅ | ✅ | ✅ | | | | |
| canCreateInvoice | ✅ | ✅ | ✅ | | | | |
| canViewReports | ✅ | ✅ | ✅ | ✅ | | | |
| canPostVouchers | ✅ | ✅ | | | | | |
| canApprovePayments | ✅ | ✅ | | | | | |
| canManageUsers | ✅ | ✅ | | | | | |
| canManageMasterData | ✅ | ✅ | ✅ | | | | |
| canExportTally | ✅ | ✅ | ✅ | ✅ | | | |
| canViewClamFlow | ✅ | ✅ | | | | ✅ | |
| canManageOnboarding | ✅ | ✅ | | | ✅ | ✅ | |
| canManageHR | ✅ | ✅ | | | ✅ | | |

### Pramaana (src/lib/permissions.ts)

| Permission | super_admin | admin | accounts | auditor | viewer |
|-----------|:-----------:|:-----:|:--------:|:-------:|:------:|
| canCreateVouchers | ✅ | ✅ | ✅ | | |
| canApprovePayments | ✅ | ✅ | | | |
| canPostVouchers | ✅ | ✅ | | | |
| canViewReports | ✅ | ✅ | ✅ | ✅ | |
| canExportTally | ✅ | ✅ | | ✅ | |
| canLockPeriod | ✅ | | | | |
| canManageUsers | ✅ | | | | |
| canManageLedgers | ✅ | ✅ | | | |

---

## 11. Pramaana Ledger Groups (Seeded — Fixed UUIDs)

System groups with `company_id = NULL`. Never delete or modify these.

| UUID suffix | Code | Name | Nature |
|------------|------|------|--------|
| ...0001 | ASSETS | Assets | ASSET |
| ...0002 | LIABILITIES | Liabilities | LIABILITY |
| ...0003 | INCOME | Income | INCOME |
| ...0004 | EXPENDITURE | Expenditure | EXPENSE |
| ...0011 | FIXED_ASSETS | Fixed Assets | ASSET |
| ...0012 | CURR_ASSETS | Current Assets | ASSET |
| ...0014 | CASH_IN_HAND | Cash in Hand | ASSET |
| ...0015 | BANK_ACCTS | Bank Accounts | ASSET |
| ...0016 | SUNDRY_DEB | Sundry Debtors | ASSET |
| ...0017 | LOANS_GIVEN | Loans & Advances (Given) | ASSET |
| ...0021 | CAPITAL | Capital Account | LIABILITY |
| ...0023 | CURR_LIAB | Current Liabilities | LIABILITY |
| ...0024 | SUNDRY_CRED | Sundry Creditors | LIABILITY |
| ...0025 | DUTIES_TAXES | Duties & Taxes | LIABILITY |
| ...0028 | SUSPENSE_GRP | Suspense Account | LIABILITY |
| ...0031 | SALES_ACCTS | Sales Accounts | INCOME |
| ...0032 | OTHER_INCOME | Other Income | INCOME |
| ...0041 | PURCH_ACCTS | Purchase Accounts | EXPENSE |
| ...0042 | DIRECT_EXP | Direct Expenses | EXPENSE |
| ...0043 | INDIRECT_EXP | Indirect Expenses | EXPENSE |

---

## 12. Pramaana Voucher Types (Seeded)

| Code | Name | Prefix | Nature | Affects Bank |
|------|------|--------|--------|:------------:|
| PYMT | Payment | PYMT | payment | ✅ |
| RCPT | Receipt | RCPT | receipt | ✅ |
| JNL | Journal | JNL | journal | |
| CNTR | Contra | CNTR | contra | ✅ |
| PURCH | Purchase | PURCH | purchase | |
| SALE | Sales | SALE | sales | |

Voucher number format: `RHHF/PYMT/2526/0001` (company/type/FY/sequence)

---

## 13. Tally Cut-Over Plan

| Date | Action |
|------|--------|
| Now → July 31 2026 | Continue Tally for all entries. Build + test Pramaana in parallel. |
| ASAP | Accountant exports data from Tally (see Section 14) |
| Before July 31 | Import Tally data into Pramaana |
| August 1 2026 | All new vouchers in Pramaana. Tally = archive only. |

---

## 14. Tally Data Export — Instructions for Accountant

Run these exports for **RHHF and RFPL separately**.

### Export 1 — Ledger Groups
*Gateway of Tally → Display More Reports → List of Accounts → Groups*  
Columns needed: `Group Name | Parent Group Name | Nature`  
Save as: `RHHF_Groups.xlsx`, `RFPL_Groups.xlsx`

### Export 2 — Ledgers with Closing Balances
*Gateway of Tally → Display More Reports → Account Books → Ledger*  
Date range: April 1 2026 to July 31 2026  
Columns needed: `Ledger Name | Group Name | Closing Balance | Dr/Cr`  
Save as: `RHHF_Ledgers.xlsx`, `RFPL_Ledgers.xlsx`

### Export 3 — Full FY 2025-26 Day Book
*Gateway of Tally → Display More Reports → Day Book*  
Date range: April 1 2025 to March 31 2026  
Columns needed: `Date | Voucher Type | Voucher Number | Party | Dr Ledger | Dr Amount | Cr Ledger | Cr Amount | Narration`  
Save as: `RHHF_Vouchers_FY2526.xlsx`, `RFPL_Vouchers_FY2526.xlsx`

### Export 4 — Current FY to Cut-Off
Date range: April 1 2026 to July 31 2026  
Save as: `RHHF_Vouchers_Apr_Jul_2026.xlsx`, `RFPL_Vouchers_Apr_Jul_2026.xlsx`

---

## 15. Build Roadmap

### ✅ Phase 1 — Suite Core (Complete)
Auth, company switching, RBAC, Purchase Orders, Commercial Invoices, GST Invoice, CalciWorks, Master Data (Vendors, Buyers, Products, Addresses), Tally Export, User Management, PWA

### ✅ Phase 2 — Pramaana Core (Complete)
Ledger Master, Voucher Entry (simplified + advanced mode), Approval Queue, Voucher Register, Suspense Advances, Settlement Page (public), Bill Relay Capture, SMS Integration (2Factor), WhatsApp interim share (wa.me)

### 🔲 Immediate — Pramaana Dashboard (replaces placeholder)
Four KPI cards:
- **Today's Payments** — sum of payment vouchers posted today
- **Pending Approvals** — count of `status='pending_approval'` vouchers for this company
- **Bank Balance** — sum of closing balances across all bank ledgers
- **Open Suspense Advances** — count of suspense vouchers with `status='open'` or `'partial'`

### 🔲 Next — Suite Entity Master (BLOCKER for Pramaana testing)
~~Add Entities tab to `/master-data` in Suite.~~  
**✅ DONE (June 2026)** — `src/lib/entities.js` + Entities tab in MasterData.jsx  
Creates vendors, staff, customers in `registry.entities` + `registry.entity_roles`.  
Pramaana payee typeahead will now return results once entities are seeded here.

**Fields per entity type (India):**

| Field | Vendor | Staff | Customer | Management |
|-------|:------:|:-----:|:--------:|:----------:|
| Display Name | ✅ Required | ✅ Required | ✅ Required | ✅ Required |
| Mobile | ✅ | ✅ | ✅ | ✅ |
| GSTIN | ✅ Required | | ✅ | |
| PAN | ✅ | ✅ | ✅ | ✅ |
| Bank Details | ✅ Required | ✅ Required | ✅ Optional | ✅ Required |
| IFSC | ✅ | ✅ | | ✅ |
| UPI ID | ✅ | ✅ | ✅ | ✅ |
| Pramaana Ledger Name | ✅ Required | | ✅ Required | |
| Designation | | ✅ | | ✅ Required |

**Fields per entity type (Overseas — country ≠ India):**

| Field | Replaces |
|-------|----------|
| Company Reg. No. | GSTIN |
| Tax / VAT Reg. No. | PAN |
| SWIFT / BIC Code | IFSC Code |
| Account / IBAN | Account Number |

### 🔲 Phase 2.5 — Plant Worker Onboarding (Suite)

Dedicated onboarding flow inside Suite for plant employees, daily wage workers, fishers and raw material suppliers. Suite is the source of truth — ClamFlow is not yet in production, so all workers are created fresh here. No data migration from ClamFlow.

- New worker form: Display Name, Mobile, Designation, Role (dropdown of plant roles), Firm Name (suppliers), Boat Reg. No. (fishers)
- Aadhaar last-4 via QR scan — **parse on-device only**, send only last-4 to server
- Face photo capture → AWS Rekognition `IndexFaces` on collection `relish-registry` → store `rekognition_face_id` in `registry.biometrics`
- RFID tag assignment field → `registry.biometrics.rfid_tag`
- `suspense_eligible = TRUE` toggle for workers eligible for advance payments
- `authorized_locations` multi-select (e.g. `panavally_plant`)
- Accessible to `hr` and `operations` roles
- **Mobile-first PWA** — designed for use on a phone at the plant floor, not a desktop

**Prerequisites:**
- Migration 023 — `ALTER TABLE registry.biometrics ADD COLUMN rfid_tag TEXT UNIQUE; ADD COLUMN rfid_issued_at TIMESTAMPTZ; ADD COLUMN rfid_issued_by UUID REFERENCES auth.users(id);`
- Migration 024 — `ALTER TABLE registry.entities ADD COLUMN aadhaar_last4 CHAR(4); ADD COLUMN boat_reg_number TEXT;`
- AWS Rekognition collection `relish-registry` created in `ap-south-1`
- Supabase Storage bucket `worker-photos` created (private, signed URLs)

### 🔲 Phase 3 — Pramaana Financial Reports
Trial Balance, Ledger Statement, Day Book, P&L, Balance Sheet

### 🔲 Phase 3 — UPI Pay Now (Pramaana)
"Pay Now" button on Approval Queue + Voucher Register detail panels, shown when status=posted, payee has upi_id, amount>0. Mobile → UPI deep link (`upi://pay?...`) opens GPay/PhonePe chooser. Desktop → QR code via `qrcode` npm package. "Mark Paid" button records payment_mode + utr_number after manual payment.

### 🔲 Phase 3 — Tally Import Tool
CSV import for Ledger Groups, Ledgers, and historical Vouchers

### 🔲 Phase 4 — GST Module
GSTR-1 data extraction, JSON export, GSP API integration

### 🔲 Phase 5 — TDS Reports
Form 26Q data, quarterly TDS filing data

### 🔲 Phase 6 — Schedule III Financials
Balance Sheet and P&L in Companies Act format for RFPL ROC filing

---

## 16. Known Issues & Technical Debt

| Issue | Location | Priority | Notes |
|-------|----------|----------|-----------| 
| Entity payee search is intentionally GLOBAL | `VoucherEntry.tsx`, `SimplifiedPaymentEntry.tsx` | Resolved June 12 2026 | Removed company_id filter — entities from either company visible as payees in any voucher. Voucher itself remains company-scoped. |
| `rfid_tag` column missing from `registry.biometrics` | DB Schema | Medium | Required before Phase 2.5. Pending migration 023: ADD COLUMN rfid_tag TEXT UNIQUE + rfid_issued_at + rfid_issued_by |
| Plant workers not yet in `registry.entities` | Phase 2.5 | High | ClamFlow is not in production — no data to migrate. All plant workers will be onboarded fresh via the Phase 2.5 form. Blocks Pramaana payee access for plant staff until Phase 2.5 is built. |
| Dashboard is placeholder | Both apps | Medium | No live KPI cards yet |
| CalciWorks sync button | Suite | Low | Query proven, no plant data yet |
| `fp_forms` table empty | ClamFlow | — | Plant not processing batches yet. Sync will work when data exists. |
| WhatsApp Business API onboarding (2Factor) | Both | Medium | Initiated June 12 2026 via 2Factor's official WhatsApp onboarding form. Awaiting connect/approval (~24-48h). Interim `wa.me` share is live in the meantime — see Section 8.8. |
| `/vouchers/:id/edit` route | Pramaana | Medium | **FIXED** — VoucherEdit.tsx built, route added to App.tsx (draft status only) |
| Voucher Edit form not tested end-to-end | Pramaana | Medium | VoucherEdit.tsx built but no confirmation it saves correctly — test with a real draft voucher |
| VCT Traders mobile number anomaly | `registry.entities` | Low | Mobile stored as `99947151524` (11 digits) — likely data-entry error. Needs manual verification against source records before standardising to `+91` format. |

---

## 17. Non-Negotiable Rules (Never Break These)

### Both Apps
1. Every `.from(` must have `.schema('registry')`, `.schema('suite')`, or `.schema('pramaana')` — never use `public` schema
2. Approvals database (`ewbguvwrejdvlhzcqlbp`) is READ ONLY — zero INSERT/UPDATE/DELETE
3. ClamFlow database (`idwgenbkguejgwtzbicu`) is READ ONLY — zero INSERT/UPDATE/DELETE
4. CalciWorks is NOT a company — never show it in company selectors
5. Cross-schema FK joins do not work in Supabase JS — always fetch separately and merge in JS
6. **Every app in the Relish ecosystem is a PWA — there are no native apps, no separate tablet apps, no Electron apps.** Mobile-first always. Some features are desktop-optimised (reports, tally export, admin) but the app itself must be installable and usable on a phone.
7. **AWS Rekognition is the ONLY face recognition system for the entire Relish platform.** No OpenCV embeddings, no histograms, no local ML models. Face matching always goes through Rekognition API calls. Region: `ap-south-1`.

### Suite Only
6. `supabaseApprovalsReadOnly` is the only client for the Approvals database — renamed to make this explicit
7. Vendor/buyer entity_id on POs and Invoices → `vendor_entity_id` / `buyer_entity_id` referencing `registry.entities`
8. Products use `default_unit` (not `unit`)
9. Delivery addresses use `pincode` (not `postal_code`)

### Pramaana Only
10. Posted vouchers (`status = 'posted'` or `'cancelled'`) are IMMUTABLE — no edit, no delete. Show "Create Reversal" (Phase 3)
11. Voucher Dr must equal Cr before posting — enforced by DB trigger `fn_validate_voucher_balance`
12. Entity select for payment vouchers is a typeahead — never free text
13. `tally_ledger_name` on ledgers is required — warn prominently if blank
14. OTP hash is stored via bcrypt — plain OTP is NEVER stored anywhere
15. Settlement page `/settle/:token` is public — no auth required. Token possession is the credential.
16. `anon` role has SELECT on `settlement_sessions` + `vouchers` (suspense only) + INSERT on `suspense_settlements` with session guard
17. Pramaana does not send payment confirmation messages of any kind (SMS or WhatsApp). If a payee believes a payment is missing, they contact the office directly.

---

## 18. Environment Variables

### Relish Suite (Vercel)
```
VITE_SUPABASE_URL=https://mmkbknnzgpvsqgnynrbe.supabase.co
VITE_SUPABASE_ANON_KEY=<suite anon key>
VITE_APPROVALS_SUPABASE_URL=https://ewbguvwrejdvlhzcqlbp.supabase.co
VITE_APPROVALS_SUPABASE_ANON_KEY=<approvals anon key>
VITE_CLAMFLOW_SUPABASE_URL=https://idwgenbkguejgwtzbicu.supabase.co
VITE_CLAMFLOW_SUPABASE_ANON_KEY=<clamflow anon key>
# AWS Rekognition (for Phase 2.5 worker onboarding face enrollment in Suite)
VITE_AWS_REGION=ap-south-1
VITE_AWS_ACCESS_KEY_ID=<AWS access key with Rekognition permissions>
VITE_AWS_SECRET_ACCESS_KEY=<AWS secret key>
VITE_AWS_REKOGNITION_COLLECTION=relish-registry
```

> **Note for Suite:** Face enrollment in the Phase 2.5 onboarding form must be proxied through a server-side Vercel Edge Function — AWS credentials must never be exposed to the browser. Create `api/enroll-face.ts` on Vercel that accepts `{ face_image_b64, entity_id }`, calls Rekognition `IndexFaces` server-side, returns `{ rekognition_face_id }`.

### Pramaana (Vercel)
```
VITE_SUPABASE_URL=https://mmkbknnzgpvsqgnynrbe.supabase.co
VITE_SUPABASE_ANON_KEY=<same anon key as Suite>
TWOFACTOR_API_KEY=<2Factor API key>
TWOFACTOR_WHATSAPP_KEY=<2Factor WhatsApp key — post-approval>
TWOFACTOR_WHATSAPP_PHONE_ID=<2Factor WhatsApp phone ID — post-approval>
```

### ClamFlow Backend (Railway)
```
# Database
DATABASE_URL=<PostgreSQL connection string>
SECRET_KEY=<JWT signing key>

# AWS Rekognition
AWS_ACCESS_KEY_ID=<IAM user access key>
AWS_SECRET_ACCESS_KEY=<IAM user secret key>
AWS_REGION=ap-south-1

# Rekognition collection names (defaults shown)
AWS_REKOGNITION_STAFF_COLLECTION=clamflow-staff
AWS_REKOGNITION_VISITOR_COLLECTION=clamflow-visitors
```

> **AWS IAM Policy** — The IAM user/role needs only these Rekognition permissions:
> `rekognition:IndexFaces`, `rekognition:SearchFacesByImage`, `rekognition:DetectFaces`, `rekognition:DeleteFaces`, `rekognition:CreateCollection`, `rekognition:ListCollections`
>
> **One-time setup** — Before first use, create both collections in `ap-south-1`:
> ```python
> import boto3
> client = boto3.client('rekognition', region_name='ap-south-1')
> client.create_collection(CollectionId='clamflow-staff')
> client.create_collection(CollectionId='clamflow-visitors')
> # For Suite Phase 2.5 (single unified collection):
> client.create_collection(CollectionId='relish-registry')
> ```

### How Face Recognition Works End-to-End

#### ClamFlow Staff Enrollment
```
Browser camera → JPEG blob → POST /biometric/register-face (multipart UploadFile)
  → detect_faces(bytes) — must be exactly 1
  → index_face(bytes, str(user_profile.id), 'clamflow-staff')
  → Rekognition stores face + sets ExternalImageId = user_profile.id
  → Returns FaceId → saved to user_profiles.rekognition_face_id
```

#### ClamFlow Onboarding (auto-enroll on approval)
```
Onboarding form sends face_image_b64 (base64 JPEG) in data JSONB blob
  → On Admin approval: base64 decode → detect_faces → index_face
  → FaceId saved to user_profiles.rekognition_face_id
```

#### ClamFlow Attendance (face at gate)
```
Hikvision camera / tablet → JPEG → POST /api/attendance/log (UploadFile image)
  → search_face(bytes, 'clamflow-staff', threshold=80.0)
  → Returns external_id = str(UserProfile.id)
  → Load UserProfile by id → PersonRecord by system_account_id
  → INSERT attendance_logs
```

#### ClamFlow Face Login
```
Browser camera → JPEG → POST /biometric/face-login (UploadFile)
  → search_face(bytes, 'clamflow-staff', threshold=80.0)
  → Returns external_id → load UserProfile → issue JWT
```

#### ClamFlow Visitor Registration
```
Gate tablet → JPEG → POST /api/visitors/register (JSON body with face_image_b64)
  → index_face(bytes, str(visitor.id), 'clamflow-visitors')
  → FaceId saved to visitors.rekognition_face_id
```

#### ClamFlow Visitor Verification
```
Gate tablet camera → JPEG → POST /api/visitors/verify (JSON body with face_image_b64)
  → search_face(bytes, 'clamflow-visitors', threshold=80.0)
  → Returns external_id = str(Visitor.id) + confidence
  → Load Visitor, validate pass_valid, INSERT visitor_events
```

#### Suite Phase 2.5 Worker Enrollment
```
Suite onboarding form camera → JPEG → POST /api/enroll-face (Vercel Edge Function)
  → AWS SDK server-side: index_faces(bytes, str(entity_id), 'relish-registry')
  → Returns rekognition_face_id → saved to registry.biometrics
```

---

## 19. Git Commits — Session Log

| Date | Repo | Hash | Description |
|------|------|------|-------------|
| 2026-06-08 | relish-suite | `80ab86e` | Research: ClamFlow pipeline mapped, SAFE_COLUMNS updated |
| 2026-06-08 | relish-suite | `8d48d94` | Fix auditLog.js schema prefix, remove broken profiles FK join |
| 2026-06-08 | relish-suite | `ea7f564` | Add Pramaana schema DDL (008) — 19 tables, triggers, RLS |
| 2026-06-08 | relish-suite | `4ad605c` | feat: Screen 2 - Ledger Master complete with bank fields |
| 2026-06-08 | relish-suite | `c218b3f` | chore: extract pramaana/ into standalone repo |
| 2026-06-11 | relish-suite | `c9ccd3a` | feat(master-data): add Entities tab — registry.entities + entity_roles CRUD |
| 2026-06-11 | relish-suite | `ffbfdf3` | feat(entities): duplicate detection + multi-role support |
| 2026-06-11 | relish-suite | `426c12c` | feat(entities): SWIFT/BIC support — migration 010 |
| 2026-06-11 | relish-suite | `adc72e6` | feat(entities): overseas reg fields, Pramaana ledger label, reset script — migrations 010+011 |
| 2026-06-11 | relish-suite | `54a0c37` | chore(entities): expand overseas reg placeholder to include JP/CN/TH |
| 2026-06-10 | pramaana | `63107bd` | fix: mobile sidebar overlay + PWA manifest with square icons |
| 2026-06-10 | pramaana | `8b86ac0` | fix: remove is_active filter from entities query, fix deprecated PWA meta |
| 2026-06-10 | pramaana | `75789a9` | fix: add icon.png to PWA manifest and apple-touch-icon |
| 2026-06-10 | pramaana | `184b0a0` | fix: add vercel.json SPA rewrite so hard refresh works on all routes |
| 2026-06-10 | pramaana | `bdbbb72` | fix: ledger table mobile card layout, no column overflow on small screens |
| 2026-06-10 | pramaana | `2c6959b` | feat: simplified payment entry - conversational guided flow |
| 2026-06-10 | pramaana | `3021cd4` | feat: Screen 5 - voucher register with filters, pagination and detail panel |
| 2026-06-10 | pramaana | `f96cba9` | fix: PWA icons use symbol mark - regenerate 192/512 from icon.png |
| 2026-06-10 | pramaana | `57571da` | fix: add padding to PWA icons so symbol fits within circular crop |
| 2026-06-10 | pramaana | `fcabf1f` | feat: suspense workflow - migration 021 + src/lib/suspense.ts |
| 2026-06-10 | pramaana | `8dd08d3` | feat: suspense advance form + register with detail panel, settlements, top-up |
| 2026-06-10 | pramaana | `7d36dd6` | feat: suspense - /settle/:token public page, fix session_id null |
| 2026-06-10 | pramaana | `b888a5c` | fix: voucher_entries insert - remove company_id, rename to narration |
| 2026-06-10 | pramaana | `bb33df7` | feat: 2Factor SMS integration - payment OTP, settlement link, payment confirmed |
| 2026-06-10 | pramaana | `c8a0b46` | fix: SettleCapture submittedCount state + manifest update |
| 2026-06-12 | relish-suite | — | seed: 022_seed_entities_from_approvals.sql — initial 109-entity seed (uncorrected version) |
| 2026-06-12 | pramaana | — | fix: entity payee search made global — removed company_id filter from entity_roles query in SimplifiedPaymentEntry.tsx and VoucherEntry.tsx |
| 2026-06-12 | relish-suite | — | chore: RELISH_PLATFORM_MASTER.md updated — entity/personnel/vendor distinction, Registry Migration Plan, ClamFlow three-phase integration, Phase 2.5 roadmap |
| 2026-06-12 | pramaana | — | chore: RELISH_PLATFORM_MASTER.md synced with Suite copy |
| 2026-06-12 | relish-suite | — | fix: 022_seed_entities_from_approvals.sql corrected — RESET block added; PERSON/ORGANISATION type corrections (~30 entities); Sherine Motty/Tarun Philip/Motty Philip → Management roles; KSEB/KSIDC → Government; Vijayan duplicate merged; Veda Associates bank fields fixed; all mobiles standardised to +91 format. 110 entities seeded, verified via Pramaana payee typeahead. |
| 2026-06-12 | pramaana | — | feat: WhatsApp interim share via wa.me deep link — "Send via WhatsApp" button on Suspense Advances settlement screen, settlement link template ("Relish" branding, no payment-confirmed message) |
| 2026-06-12 | pramaana | — | design: UPI Pay Now feature spec — deep link + QR code for Approval Queue / Voucher Register detail panels (not yet built — Phase 3) |
| 2026-06-12 | both | — | arch: ClamFlow backend code reviewed — Section 21.1 A-H fully answered. Key decisions: Suite is source of truth from day one (ClamFlow pre-production, all data is test data); OpenCV face recognition is replaced by AWS Rekognition (`relish-registry` collection, ap-south-1); RFID in ClamFlow is product-box only; no migration needed; Phase 2.5 plan corrected to fresh onboarding not migration. Visitor Pass + Gate Vehicle Log modules added to roadmap. RELISH_PLATFORM_MASTER.md updated. |
| 2026-06-12 | clamflow_backend | `41805f6` | fix: replace OpenCV histogram face recognition with AWS Rekognition across all call sites. Rewrote `face_recognition_unified.py` as thin wrapper around `utils/aws_rekognition.py`. Fixed `api/attendance/routes.py` (SearchFacesByImage via STAFF collection). Fixed `api/visitors/routes.py` register (IndexFaces via VISITOR collection) and verify (SearchFacesByImage). Fixed `api/onboarding/routes.py` approve (auto-enroll face on Admin approval). Updated `api/visitors/schemas.py`: `face_embedding` List[float] → `face_image_b64` str. Updated RELISH_PLATFORM_MASTER.md with full Rekognition configuration, IAM policy, collection setup, and end-to-end flow. |

---

## 20. Contacts & External Services

| Service | Purpose | Account |
|---------|---------|---------|
| Supabase | Primary database | relishclam organisation |
| Vercel | Hosting both apps | relishclam organisation |
| GitHub | Code repos | relishclam/relish-suite + relishclam/pramaana |
| 2Factor.in | SMS OTP + WhatsApp Business API (onboarding in progress, June 12 2026) | Relish Hao Hao Chi Foods |
| Vilpower (Vi Business) | DLT SMS registration — Payment-Approval OTP only | Motty Philip — motty.philip@gmail.com |
| AWS Rekognition | Face recognition (ClamFlow) | ap-south-1 region |
| Meta for Developers | WhatsApp Cloud API (parallel exploration — app ID 979373741599924, "Relish Compliance" portfolio) — not the primary path; 2Factor preferred | motty.philip@gmail.com |

---

## 21. Legacy App Integration Harvest

This section is the **working checklist** for what must be understood and extracted from each legacy app before we can replace or integrate it. Updated each time a folder is opened for editing.

Status key: 🔲 Not started · 🔍 Folder open / in progress · ✅ Done · ⚠️ Blocked

---

### 21.1 ClamFlow — `idwgenbkguejgwtzbicu` (READ ONLY)

ClamFlow is the plant-floor operations app at RHHF Panavally. It manages worker registration, face recognition, RFID attendance, shift assignments, raw material (clam/shell) receipts from fishers, and daily production records.

**Folder status:** ✅ Backend code reviewed — June 12 2026

**Key Architecture Decisions (June 12 2026):**
- **ClamFlow is NOT yet in production.** All data in `idwgenbkguejgwtzbicu` is test data. There is nothing to migrate.
- **Suite is the source of truth from day one.** All workers, fishers, and suppliers are onboarded in `registry.entities`. ClamFlow will read from Suite when it goes live — ClamFlow never owns people data.
- **OpenCV face recognition (`face_recognition_unified.py`) is a mistake.** It generates a 256-bin greyscale histogram, not a face embedding. It cannot identify individuals. Must be replaced with AWS Rekognition before ClamFlow goes to production.
- **AWS Rekognition is the face recognition system for the entire Relish platform.** `rekognition_face_id` already exists on ClamFlow's `user_profiles`. Suite will store it in `registry.biometrics`. Single collection: `relish-registry` (`ap-south-1`).
- **RFID in ClamFlow is for product boxes, not workers.** `rfid_tags` links RFID tags to `lots` (clam product boxes). Worker RFID will be built cleanly in Suite (`registry.biometrics.rfid_tag` — migration 023).
- **No shifts table in ClamFlow.** Shifts will be designed fresh in Suite.
- **Aadhaar:** ClamFlow stores the full number in `person_records.aadhar_number`. Suite stores last-4 only. Never import or display the full number.
- **Fishers are in `person_records`** (`person_type='supplier'`, `boat_registration_number` populated) — not a separate table.
- **ClamFlow has a full Visitor Pass system** (`visitors` + `visitor_events`) and a **Gate Vehicle Log** (`gate_vehicle_logs` with driver OTP). Both will be built as new modules in Suite.

#### What We Know (Reviewed June 12 2026)

**A. Person / Worker Onboarding Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| A1 | Full schema of `person_records` | ✅ | `id, first_name, last_name, full_name, address, contact_number (NOT NULL), aadhar_number, person_type (staff/vendor/supplier), designation, firm_name, supplier_type, category, gst_number, boat_registration_number, linked_data (JSONB), status, start_date, end_date, system_account_id → user_profiles, created_by, approved_by, created_at, updated_at` |
| A2 | Onboarding UI flow | ✅ | Two-step: supervisor submits `OnboardingPending` (JSONB blob) → Admin approves → creates `PersonRecord` + `UserProfile` (system account, username like `SG_Rajan`) |
| A3 | How face photo is captured | ✅ | 512-float embedding sent from frontend webcam. Photo URL stored in `user_profiles.face_image` (String 500) |
| A4 | How face is sent to Rekognition | ✅ | **Not properly wired.** Primary path is OpenCV Haar cascade (not real face recognition). Rekognition field exists but is not the active code path. Must be fixed before production. |
| A5 | What is stored from Rekognition | ✅ | `user_profiles.rekognition_face_id` (String 255) |
| A6 | Face photo storage | ✅ | `user_profiles.face_image` (URL string). Specific Storage bucket not confirmed from backend code alone. |
| A7 | Aadhaar field | ✅ | **Full Aadhaar number** stored in `person_records.aadhar_number`. Suite stores last-4 only — never import. |
| A8 | Mobile number field | ✅ | `person_records.contact_number` (String 20, NOT NULL) |
| A9 | Worker categories / roles | ✅ | `person_type`: staff / vendor / supplier. App roles: Super Admin, Admin, Staff Lead, Production Lead, QC Lead, QC Staff, IT Staff, Production Staff, Maintenance Staff, Security Guard, Gate Staff |
| A10 | `person_records.department` | ✅ | **No department field.** Uses `designation` (role title) and `person_type` instead. |

**B. RFID / Attendance Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| B1 | Attendance events table schema | ✅ | `attendance_logs`: `id, person_id → person_records, method (rfid/face/camera_detection/override), timestamp, verified_by → user_profiles, override_reason, location, created_at` |
| B2 | RFID tag assignment to worker | ✅ | **No proper worker RFID assignment UI.** `rfid_tags.assigned_to` is borrowed informally. `rfid_tags` is a product-box tracking table. Worker RFID will be a clean new feature in Suite. |
| B3 | RFID scan event model | ✅ | Single-event — each scan = one `attendance_logs` row. No clock-in / clock-out pairing. |
| B4 | Shifts table | ✅ | **None.** No shifts table in ClamFlow. Will be designed fresh in Suite. |
| B5 | Daily attendance calculation | ✅ | Not implemented — raw scan logs only. Calculation logic will be built in Suite. |
| B6 | RFID reader ↔ Supabase | 🔲 | Hardware integration not visible from backend code. |

**C. Face Recognition Attendance Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| C1 | Face scanner Rekognition API call | ✅ | Should be `SearchFacesByImage`. Currently using OpenCV Haar cascade instead — not real face recognition. Must be replaced. |
| C2 | After face match — what is written | ✅ | `attendance_logs` row with `method='face'` |
| C3 | Face vs RFID — same table? | ✅ | Yes — both write `attendance_logs`, distinguished by `method` column |
| C4 | Confidence threshold | ✅ | Cosine similarity ≥ 0.72 (from visitor system — same threshold applies to worker matching) |

**D. Suppliers / Raw Material Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| D1 | `suppliers` table schema | ✅ | No separate `suppliers` table — fishers/suppliers are `person_records` with `person_type='supplier'` |
| D2 | Are fishers in `person_records` or `suppliers`? | ✅ | `person_records` — `person_type='supplier'`, `boat_registration_number` populated |
| D3 | Raw material receipt flow | ✅ | `lots` (supplier_id, weight, species) + `weight_notes` (per-box: gross/tare/net weight, temperature, visual quality, QC approval) |
| D4 | Supplier payment trigger | 🔲 | No direct link to Approvals visible from code reviewed. Likely manual process. |

**E. What Suite Must Build**
| # | What to build | Target in Suite | Status |
|---|-------------|-----------------|--------|
| E1 | Face photo capture + Rekognition `IndexFaces` enrollment | `registry.biometrics` + `worker-photos` Storage bucket | 🔲 Phase 2.5 |
| E2 | RFID tag assignment (worker) | `registry.biometrics.rfid_tag` (migration 023) | 🔲 Phase 2.5 |
| E3 | Worker onboarding form (name, Aadhaar-4, mobile, designation, role) | `registry.entities` + `entity_roles` | 🔲 Phase 2.5 |
| E4 | Shift definition schema | `registry.shifts` (new table — design in Phase 2.5) | 🔲 Phase 2.5 |
| E5 | Attendance event schema | `registry.attendance` (model after `attendance_logs`) | 🔲 Phase 3 |
| E6 | Supplier / Fisher onboarding form | `registry.entities` WHERE role=Supplier + `boat_reg_number` | 🔲 Phase 2.5 |

**F. Security / Visitor System**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| F1 | Visitors / gate log tables | ✅ | `visitors` (name, phone, purpose, host_staff_id, face_embedding Vector(512), photo_url, rekognition_face_id, pass_token, valid_from, valid_until, status) + `visitor_events` (immutable audit: pass_issued/entry/exit/revoked) |
| F2 | Visitor check-in | ✅ | Face embedding match (cosine sim ≥ 0.72) OR QR `pass_token` scan |
| F3 | Unknown face | ✅ | Returns 401 if confidence < 0.72 — supervisor override required |
| F4 | Visitor identity linked to person_records? | ✅ | `visitors.host_staff_id` optionally links to `person_records` (who they're visiting). The visitor themselves is a separate record. |
| F5 | Gate logs vs attendance logs | ✅ | Separate. `gate_vehicle_logs` = vehicles in/out with driver OTP. `attendance_logs` = person face/RFID scans. |
| F6 | Blacklist / watchlist | 🔲 | Not visible in code reviewed |
| F7 | Security guard UI | 🔲 | Frontend not reviewed |

**G. Onboarding Module**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| G1 | Separate app or route? | ✅ | Route within the main ClamFlow backend (`api/onboarding/routes.py`) — not a separate app |
| G2 | Tech stack | ✅ | FastAPI backend (Python). Frontend not reviewed. |
| G3 | Phone or desktop optimised? | 🔲 | Frontend not reviewed |
| G4 | Handles new worker + visitor? | ✅ | Onboarding handles staff/vendor/supplier. Visitors are a separate module (`api/visitors/`). |
| G5 | Supabase tables written | ✅ | `OnboardingPending` → on approval: `PersonRecord` + `UserProfile` |
| G6 | Multi-step wizard? | 🔲 | Frontend not reviewed |
| G7 | Duplicate detection | ✅ | **None implemented** in backend onboarding code. Suite builds this via GSTIN → mobile → display_name check (already done in `entities.js`). |

**H. Production / Costing**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| H1 | Production data recorded | ✅ | `lots` (species, weight, arrival), `weight_notes` (per-box: gross/tare/net, temperature, visual quality), `ppc_forms`/`ppc_boxes` (product type, grade, weight), `fp_forms`/`fp_boxes` (final product with RFID tag) |
| H2 | Linked to supplier receipts? | ✅ | Yes — `lots.supplier_id → person_records.id` |
| H3 | Linked to specific workers? | ✅ | Yes — `ppc_forms.station_staff_id` and `fp_forms.station_staff_id → user_profiles.id` |
| H4 | Flows into Pramaana? | ✅ | Not automatic. Accountant creates Purchase voucher manually when goods are received and payment is due. |
| H5 | ClamFlow_Costing — separate app? | ✅ | Module within the main ClamFlow app — `ppc_forms`, `fp_forms`, `depuration_forms` tables in the same DB. |

---

### 21.2 Relish Approvals — `ewbguvwrejdvlhzcqlbp` (READ ONLY)

Approvals is the legacy payment workflow app. It holds RHHF and RFPL payees, historical payment approvals, and the mobile-OTP settlement link flow that Pramaana is replacing.

**Folder status:** 🔲 Not yet opened

#### What We Need to Understand

**A. Payee / Entity Data**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| A1 | Full schema of the payees table (name, columns, types) | 🔲 | |
| A2 | What payee categories exist? Do they map cleanly to our `role` enum? | 🔲 | |
| A3 | Are mobile numbers stored with `+91` prefix, without prefix, or mixed? | ✅ | Mixed — confirmed during 022 seed corrections (June 12 2026). Standardised to `+91XXXXXXXXXX` on import. |
| A4 | Is there a GSTIN / PAN field on payees? | 🔲 | |
| A5 | Are there duplicate payees across RHHF and RFPL, or is each payee scoped to one company? | ✅ | Confirmed — same individuals (Motty Philip, Anil Kumar, Sebin Jose, Varghese/Electrician, etc.) appear as payees under both RHHF and RFPL. Modeled as one `registry.entities` row with two `entity_roles` rows. |
| A6 | Are payees ever shared with ClamFlow (same person as a ClamFlow supplier)? | 🔲 | |

**B. Approval / Payment Workflow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| B1 | Full flow from payment request → approval → disbursement — what tables are written at each step? | 🔲 | |
| B2 | What is the `approval_status` enum — all possible values? | 🔲 | |
| B3 | How are multi-level approvals handled — is there an approver hierarchy table? | 🔲 | |
| B4 | What triggers an SMS to the payee — which event, which table write? | 🔲 | |
| B5 | What does the settlement link contain — token, amount, expiry? Schema of settlements table? | 🔲 | |
| B6 | How does a payee submit receipts / proof — file upload to Storage? Which bucket? | 🔲 | |

**C. What We Must Copy Into Pramaana**
| # | What to copy | Target in Pramaana | Status |
|---|-------------|-------------------|--------|
| C1 | Settlement link generation (token + expiry) | `pramaana.suspense` settlement_token + settlement_expires_at | ✅ Already built |
| C2 | SMS notification on payment approval | `pramaana.sms_log` — Pramaana sends via 2Factor.in | ✅ Already built |
| C3 | Payee list (all entities) | `registry.entities` seed (022_seed_entities_from_approvals.sql) | ✅ Done — 110 entities seeded and verified June 12 2026 |
| C4 | Multi-level approval hierarchy (if any) | `pramaana.approvals` — design TBD | 🔲 |
| C5 | Receipt / proof upload flow | Pramaana settlement capture page | 🔲 |
| C6 | Historical payment records (for opening balances) | `pramaana.vouchers` opening balance import | 🔲 |

---

### 21.3 Pramaana (Self-Reference — Features Still Needed)

Pramaana is active and in use. This sub-section tracks features that exist in the Approvals app or are user-requested that Pramaana still needs to build.

**Folder status:** ✅ Open — primary development app

| # | Feature | Source Inspiration | Priority | Status |
|---|---------|-------------------|----------|--------|
| P1 | WhatsApp share button for settlement links (wa.me interim) | User request (June 2026) | High | ✅ Done June 12 2026 |
| P2 | Payment Confirmed action in Voucher Register | User request (June 2026) | High | ❌ Dropped June 12 2026 — no payment-confirmed message is sent; payees contact the office if a payment is missing |
| P3 | Trial Balance report | Accounting standard | High | 🔲 |
| P4 | Ledger Statement (date-range, per ledger) | Accounting standard | High | 🔲 |
| P5 | Day Book (all vouchers in date order) | Accounting standard | Medium | 🔲 |
| P6 | Profit & Loss Statement | Accounting standard | Medium | 🔲 |
| P7 | Balance Sheet | Accounting standard | Medium | 🔲 |
| P8 | Multi-level payment approval hierarchy | Approvals app | Medium | 🔲 |
| P9 | Receipt / proof upload by payee at settlement | Approvals app | Medium | 🔲 |
| P10 | Period lock (prevent editing posted vouchers before lock date) | Accounting standard | Low | 🔲 |
| P11 | UPI Pay Now — deep link + QR code on voucher detail panels | User request (June 2026) | Medium | 🔲 Designed, not built |
| P12 | WhatsApp Business API via 2Factor — replaces wa.me interim | User request (June 2026) | Medium | 🔲 Onboarding initiated, awaiting 2Factor approval |

---

### 21.4 Update Protocol

When a legacy folder is opened for editing:
1. Read the schema files / migration SQL first
2. Fill in the Answer column for every open question in 21.1 / 21.2
3. Move answered rows to status ✅
4. Update the **Folder status** line
5. Add any new questions discovered during the session
6. Sync identical changes to `pramaana/RELISH_PLATFORM_MASTER.md`
7. Commit both copies together

---

*"An accountant should not need to think. A business owner should not need an accountant."*  
*— Pramaana design principle*

*"Every number, accounted for."*  
*— Pramaana tagline*
