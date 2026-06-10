# Relish Platform — Master Reference Document
**Last Updated:** June 2026  
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

### Who Can Be a Payee in Pramaana?
Any entity with role NOT 'Customer'. The payee typeahead filters:
```typescript
.in('role', ['Vendor','Supplier','Staff','Management','Contractor','Government','Auditor'])
```

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
| Master Data | `/master-data` | Vendors, Buyers, Products, Delivery Addresses |
| Tally Export | `/tally-export` | Reads Relish Approvals (READ ONLY), generates XML |
| User Management | `/admin/users` | super_admin only |
| Settings | `/settings` | Profile + company settings |

### 7.2 Master Data Tabs (in `/master-data`)

| Tab | Table | Notes |
|-----|-------|-------|
| Vendors | `registry.entity_roles` WHERE role='Vendor' | entity_id → registry.entities |
| Buyers | `registry.entity_roles` WHERE role='Customer' | entity_id → registry.entities |
| Products | `suite.products` | default_unit field (not 'unit') |
| Delivery Addresses | `suite.delivery_addresses` | pincode field (not 'postal_code') |
| **Entities** | `registry.entities` + `entity_roles` | **NOT YET BUILT — PENDING** |

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

---

## 8. Pramaana — Module Map

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
| `src/lib/sms.ts` | sendSettlementLinkSms, sendPaymentConfirmedSms, sendPaymentOtpSms |
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

### 8.8 SMS Integration (2Factor)

| Template | Status | Variables |
|----------|--------|-----------|
| `Pramaana-Payment-Approval` | ✅ Approved (Vilpower + 2Factor) | XXXX = OTP |
| `Pramaana-Settlement-Link` | ✅ Approved (Vilpower + 2Factor) | XXXX=name, XXXX=amount, XXXX=url |
| `Pramaana-Payment-Confirmed` | ✅ Approved (Vilpower + 2Factor) | XXXX=amount, XXXX=voucher_no |

Edge Function: `api/send-sms.ts` (Vercel)  
Env var: `TWOFACTOR_API_KEY` (set in Vercel dashboard)

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
Ledger Master, Voucher Entry (simplified + advanced mode), Approval Queue, Voucher Register, Suspense Advances, Settlement Page (public), Bill Relay Capture, SMS Integration (2Factor)

### 🔲 Next — Suite Entity Master (BLOCKER for Pramaana testing)
Add Entities tab to `/master-data` in Suite.  
Creates vendors, staff, customers in `registry.entities` + `registry.entity_roles`.  
Without this, Pramaana payee typeahead returns nothing.

**Fields per entity type:**

| Field | Vendor | Staff | Customer | Management |
|-------|:------:|:-----:|:--------:|:----------:|
| Display Name | ✅ Required | ✅ Required | ✅ Required | ✅ Required |
| Mobile | ✅ | ✅ | ✅ | ✅ |
| GSTIN | ✅ Required | | ✅ | |
| PAN | ✅ | ✅ | ✅ | ✅ |
| Bank Details | ✅ Required | ✅ Required | ✅ Optional | ✅ Required |
| UPI ID | ✅ | ✅ | ✅ | ✅ |
| Tally Ledger Name | ✅ Required | | ✅ Required | |
| Designation | | ✅ | | ✅ Required |

### 🔲 Phase 3 — Pramaana Financial Reports
Trial Balance, Ledger Statement, Day Book, P&L, Balance Sheet

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
|-------|----------|----------|-------|
| Vilpower templates pending re-approval | SMS | Medium | Settlement-Link + Payment-Confirmed rejected (wrong category). Resubmit under Banking/Financial Services. |
| Entity typeahead in Pramaana searches ALL entities | `VoucherEntry.tsx` | Low | Should filter to Staff+Management for suspense. Acceptable for now. |
| Dashboard is placeholder | Both apps | Medium | No live KPI cards yet |
| CalciWorks sync button | Suite | Low | Query proven, no plant data yet |
| `fp_forms` table empty | ClamFlow | — | Plant not processing batches yet. Sync will work when data exists. |
| WhatsApp API not configured | Both | Medium | Interakt/Wati evaluation pending |
| `/vouchers/:id/edit` route | Pramaana | Medium | **FIXED** — VoucherEdit.tsx built, route added to App.tsx (draft status only) |

---

## 17. Non-Negotiable Rules (Never Break These)

### Both Apps
1. Every `.from(` must have `.schema('registry')`, `.schema('suite')`, or `.schema('pramaana')` — never use `public` schema
2. Approvals database (`ewbguvwrejdvlhzcqlbp`) is READ ONLY — zero INSERT/UPDATE/DELETE
3. ClamFlow database (`idwgenbkguejgwtzbicu`) is READ ONLY — zero INSERT/UPDATE/DELETE
4. CalciWorks is NOT a company — never show it in company selectors
5. Cross-schema FK joins do not work in Supabase JS — always fetch separately and merge in JS

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
```

### Pramaana (Vercel)
```
VITE_SUPABASE_URL=https://mmkbknnzgpvsqgnynrbe.supabase.co
VITE_SUPABASE_ANON_KEY=<same anon key as Suite>
TWOFACTOR_API_KEY=<2Factor API key>
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

---

## 20. Contacts & External Services

| Service | Purpose | Account |
|---------|---------|---------|
| Supabase | Primary database | relishclam organisation |
| Vercel | Hosting both apps | relishclam organisation |
| GitHub | Code repos | relishclam/relish-suite + relishclam/pramaana |
| 2Factor.in | SMS OTP | Relish Hao Hao Chi Foods |
| Vilpower (Vi Business) | DLT SMS registration | Motty Philip — motty.philip@gmail.com |
| AWS Rekognition | Face recognition (ClamFlow) | ap-south-1 region |

---

*"An accountant should not need to think. A business owner should not need an accountant."*  
*— Pramaana design principle*

*"Every number, accounted for."*  
*— Pramaana tagline*
