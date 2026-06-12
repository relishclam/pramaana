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
| Personnel | ClamFlow `person_records` (READ-ONLY) | Plant workers at Panavally. NOT in `registry.entities`. Cannot be Pramaana payees until Phase 2.5 is built |

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
| `voucher-attachments` | Private — signed URLs | Bills, receipts, invoices & transaction records attached to vouchers |

### 8.8 Messaging Integration

#### SMS via 2Factor (OTP only)

| Template | 2Factor | Vilpower/DLT | Variables |
|----------|:-------:|:------------:|-----------|
| `Pramaana-Payment-Approval` | ✅ | ✅ | XXXX = OTP |

> **Decision:** SMS is used exclusively for Payment Approval OTP. This is the only template that needs to remain active on 2Factor + Vilpower/DLT.

Edge Function: `api/send-sms.ts` (Vercel)  
Env var: `TWOFACTOR_API_KEY` (set in Vercel dashboard)

#### WhatsApp API (Settlement Links & Payment Confirmations) — ⏳ TBD

| Message Type | Variables | Notes |
|-------------|-----------|-------|
| Settlement Link | name, amount, url | Link sent as a WhatsApp button; payee can also install the Settlement Page as a PWA from the chat |
| Payment Confirmed | amount, voucher_no | Rich confirmation message with voucher reference |

> **Rationale:** WhatsApp enables rich message formatting — interactive buttons for the settlement link, PWA install prompt for the Settlement Page on the payee's device, and better delivery rates than plain SMS for non-OTP flows.

**Provider evaluation pending:** Interakt, Wati, or similar BSP. Once decided, implement in a new `api/send-whatsapp.ts` Vercel function and add `WHATSAPP_API_KEY` / `WHATSAPP_PHONE_ID` env vars.

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
| `legacy_clamflow_person_id` | Links to ClamFlow `person_records.id` — prevents re-creating existing plant workers during migration |
| `legacy_clamflow_supplier_id` | Links to ClamFlow `suppliers.id` |
| `legacy_approvals_payee_id` | Links to Approvals payee — used in 022_seed_entities_from_approvals.sql (June 2026) |

#### Three-Phase ClamFlow Migration

**Phase 1 — Immediate Workaround (now):**
- Personnel tab in Suite shows ClamFlow workers (read-only view already built)
- Add a "Register in Suite" button (first task of Phase 2.5) that pre-fills entity form from the ClamFlow record
- Sets `legacy_clamflow_person_id` on the new `registry.entities` row
- Worker immediately becomes a valid Pramaana payee

**Phase 2 — Plant Worker Onboarding in Suite (Phase 2.5):**
- Dedicated onboarding form for Staff / Fisher / Supplier roles
- RFID tag assignment (requires migration 023 — see Known Issues)
- Face photo capture → AWS Rekognition enrollment → `registry.biometrics`
- Aadhaar last-4 capture (NEVER the full 12-digit number)
- `suspense_eligible = TRUE` toggle for daily wage advance payments
- `authorized_locations` multi-select (e.g. panavally_plant)
- `legacy_clamflow_person_id` auto-populated when registering existing ClamFlow workers
- Accessible to `hr` and `operations` roles
- **Mobile-first PWA** — designed for use on a phone at the plant floor, not a desktop

**Phase 3 — ClamFlow Reads from Registry (future):**
- ClamFlow face scanner queries `registry.biometrics` instead of its own `person_photos` table
- ClamFlow attendance events write to `registry.attendance` (soft ref to `shift_assignment_id`)
- ClamFlow supplier lookup reads `registry.entities WHERE role='Supplier'`
- ClamFlow `person_records`, `person_photos`, `attendance_logs` become read-only archives
- ClamFlow becomes a pure UI terminal — owns zero master data

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

### 🔲 Phase 2.5 — Plant Worker Onboarding (Suite)

Dedicated onboarding flow inside Suite for plant employees, daily wage workers, fishers and raw material suppliers. This is the entry point for all RHHF Panavally personnel into the Suite Registry.

- "Register in Suite" button on Personnel tab — pre-fills form from ClamFlow `person_records`
- RFID tag assignment field
- Face photo capture → AWS Rekognition enrollment → `registry.biometrics`
- Aadhaar last-4 capture
- `suspense_eligible = TRUE` toggle for advance-eligible workers
- `authorized_locations` multi-select per worker
- `legacy_clamflow_person_id` set automatically when registering existing ClamFlow workers
- Accessible to `hr` and `operations` roles

**Prerequisite:** Migration 023 — `ALTER TABLE registry.biometrics ADD COLUMN rfid_tag TEXT UNIQUE; ADD COLUMN rfid_issued_at TIMESTAMPTZ; ADD COLUMN rfid_issued_by UUID REFERENCES auth.users(id);`

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
| Entity payee search is intentionally GLOBAL | `VoucherEntry.tsx`, `SimplifiedPaymentEntry.tsx` | Resolved June 12 2026 | Removed company_id filter — entities from either company visible as payees in any voucher. Voucher itself remains company-scoped. |
| `rfid_tag` column missing from `registry.biometrics` | DB Schema | Medium | Required before Phase 2.5. Pending migration 023: ADD COLUMN rfid_tag TEXT UNIQUE + rfid_issued_at + rfid_issued_by |
| Plant workers (ClamFlow) not in `registry.entities` | ClamFlow migration | High | Cannot be Pramaana payees until Phase 2.5 built. Workaround: manually add via Entities tab with `legacy_clamflow_person_id` set |
| Dashboard is placeholder | Both apps | Medium | No live KPI cards yet |
| CalciWorks sync button | Suite | Low | Query proven, no plant data yet |
| `fp_forms` table empty | ClamFlow | — | Plant not processing batches yet. Sync will work when data exists. |
| WhatsApp API not configured | Pramaana | High | Needed for Settlement Links + Payment Confirmations. Evaluate Interakt/Wati. Implement `api/send-whatsapp.ts` once provider chosen. |
| `/vouchers/:id/edit` route | Pramaana | Medium | **FIXED** — VoucherEdit.tsx built, route added to App.tsx (draft status only) |
| Voucher Edit form not tested end-to-end | Pramaana | Medium | VoucherEdit.tsx built but no confirmation it saves correctly — test with a real draft voucher |

---

## 17. Non-Negotiable Rules (Never Break These)

### Both Apps
1. Every `.from(` must have `.schema('registry')`, `.schema('suite')`, or `.schema('pramaana')` — never use `public` schema
2. Approvals database (`ewbguvwrejdvlhzcqlbp`) is READ ONLY — zero INSERT/UPDATE/DELETE
3. ClamFlow database (`idwgenbkguejgwtzbicu`) is READ ONLY — zero INSERT/UPDATE/DELETE
4. CalciWorks is NOT a company — never show it in company selectors
5. Cross-schema FK joins do not work in Supabase JS — always fetch separately and merge in JS
6. **Every app in the Relish ecosystem is a PWA — there are no native apps, no separate tablet apps, no Electron apps.** Mobile-first always. Some features are desktop-optimised (reports, tally export, admin) but the app itself must be installable and usable on a phone.

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
| 2026-06-12 | relish-suite | — | seed: 022_seed_entities_from_approvals.sql — 109 entities (Vendors, Staff, Management, Government) for RFPL + RHHF from Approvals payee list; all Indian mobiles normalised to +91XXXXXXXXXX |
| 2026-06-12 | pramaana | — | fix: entity payee search made global — removed company_id filter from entity_roles query in SimplifiedPaymentEntry.tsx and VoucherEntry.tsx |
| 2026-06-12 | relish-suite | — | chore: RELISH_PLATFORM_MASTER.md updated — entity/personnel/vendor distinction, Registry Migration Plan, ClamFlow three-phase integration, Phase 2.5 roadmap |
| 2026-06-12 | pramaana | — | chore: RELISH_PLATFORM_MASTER.md synced with Suite copy |

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

## 21. Legacy App Integration Harvest

This section is the **working checklist** for what must be understood and extracted from each legacy app before we can replace or integrate it. Updated each time a folder is opened for editing.

Status key: 🔲 Not started · 🔍 Folder open / in progress · ✅ Done · ⚠️ Blocked

---

### 21.1 ClamFlow — `idwgenbkguejgwtzbicu` (READ ONLY)

ClamFlow is the plant-floor operations app at RHHF Panavally. It manages worker registration, face recognition, RFID attendance, shift assignments, raw material (clam/shell) receipts from fishers, and daily production records.

**Folder status:** 🔲 Not yet opened

#### What We Need to Understand

**A. Person / Worker Onboarding Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| A1 | What is the full schema of `person_records`? (all columns, types, nullability) | 🔲 | |
| A2 | What is the onboarding UI flow — which form fields does the supervisor fill in for a new worker? | 🔲 | |
| A3 | How is the face photo captured — webcam component, mobile upload, or dedicated scanner? | 🔲 | |
| A4 | How is the face photo sent to AWS Rekognition — direct from browser, or via a Supabase Edge Function? | 🔲 | |
| A5 | What does ClamFlow store back from Rekognition — just `rekognition_face_id`? Full response? | 🔲 | |
| A6 | Where is the face photo stored — Supabase Storage bucket name and path pattern? | 🔲 | |
| A7 | Is there an Aadhaar field? What is stored — last-4 only, or more? | 🔲 | |
| A8 | Is there a mobile number field on `person_records`? | 🔲 | |
| A9 | What worker categories / roles exist in ClamFlow (equivalent of our entity `role` enum)? | 🔲 | |
| A10 | What is `person_records.department` — is it a free-text field or a fixed enum? | 🔲 | |

**B. RFID / Attendance Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| B1 | What is the schema of the RFID / attendance events table (name, all columns)? | 🔲 | |
| B2 | How is an RFID tag assigned to a worker — admin screen, or during onboarding? | 🔲 | |
| B3 | What does an RFID scan event look like — is it clock-in only, or clock-in + clock-out? | 🔲 | |
| B4 | How are shifts defined — is there a `shifts` table? What is its schema? | 🔲 | |
| B5 | How is daily attendance calculated from scan events (late, present, absent logic)? | 🔲 | |
| B6 | Does the RFID reader talk directly to Supabase or through a middleware service? | 🔲 | |

**C. Face Recognition Attendance Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| C1 | How does the face scanner identify a worker — which Rekognition API call? | 🔲 | |
| C2 | What happens after a face match — which table is written, what columns? | 🔲 | |
| C3 | Is face attendance separate from RFID attendance, or do both write the same table? | 🔲 | |
| C4 | Is there a confidence threshold below which a scan is rejected or flagged? | 🔲 | |

**D. Suppliers / Raw Material Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| D1 | Full schema of `suppliers` table | 🔲 | |
| D2 | Are fishers in `person_records` or `suppliers`, or both? | 🔲 | |
| D3 | What is the raw material receipt flow — form fields, table written, approval step? | 🔲 | |
| D4 | How is a supplier payment triggered from ClamFlow — does it create anything in Approvals? | 🔲 | |

**E. What We Must Copy Into Suite Registry**
| # | What to copy | Target in Suite | Status |
|---|-------------|-----------------|--------|
| E1 | Face photo capture + Rekognition enrollment | `registry.biometrics` + Storage bucket | 🔲 |
| E2 | RFID tag assignment UI | `registry.biometrics.rfid_tag` (migration 023) | 🔲 |
| E3 | Worker onboarding form (name, DOB, Aadhaar-4, mobile, department, role) | `registry.entities` + `entity_roles` | 🔲 |
| E4 | Shift definition schema | `registry.shifts` (new table — design after reading ClamFlow) | 🔲 |
| E5 | Attendance event schema | `registry.attendance` (DDL needs to match ClamFlow's structure) | 🔲 |
| E6 | Supplier onboarding form | `registry.entities` WHERE role=Supplier | 🔲 |

**F. Security / Visitor Detection Flow**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| F1 | Is there a visitors / gate log table? What is its full schema? | 🔲 | |
| F2 | How does visitor check-in work — face scan, manual entry, or QR/badge? | 🔲 | |
| F3 | What happens when an unknown face is detected — alert, photo stored, manual override? | 🔲 | |
| F4 | Is visitor identity linked to `person_records` (pre-registered) or a separate visitors table? | 🔲 | |
| F5 | Are gate access logs separate from plant-floor attendance logs? | 🔲 | |
| F6 | Is there a blacklist / watchlist mechanism? | 🔲 | |
| F7 | What does the security guard UI look like — live camera feed, notification popup, or manual log? | 🔲 | |

**G. `ClamFlow_Onboard/` — Dedicated Onboarding Module**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| G1 | Is `ClamFlow_Onboard/` a separate standalone PWA or a route/module within `clamflow_frontend/`? | 🔲 | |
| G2 | What tech stack is it built on (React, Vue, plain HTML)? | 🔲 | |
| G3 | Is it optimised for phone use at the plant gate or desktop use in an HR office? | 🔲 | |
| G4 | Does it handle both new worker registration AND visitor pre-registration? | 🔲 | |
| G5 | What Supabase tables does it write to? | 🔲 | |
| G6 | Is there a multi-step wizard (personal details → face photo → RFID → confirm)? | 🔲 | |
| G7 | How does it handle duplicate detection before creating a new record? | 🔲 | |

**H. Production / Costing (`ClamFlow_Costing/`)**
| # | Question | Status | Answer |
|---|----------|--------|--------|
| H1 | What production data is recorded — batch weight, shell yield, waste, processing time? | 🔲 | |
| H2 | Is production linked to supplier receipts (raw material in → processed batch out)? | 🔲 | |
| H3 | Are production batches linked to specific workers (who processed which batch)? | 🔲 | |
| H4 | Does costing data flow into Pramaana as accounting entries, or is it standalone? | 🔲 | |
| H5 | Is `ClamFlow_Costing/` a separate app, or a module in the main ClamFlow frontend? | 🔲 | |

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
| A3 | Are mobile numbers stored with `+91` prefix, without prefix, or mixed? | 🔲 | |
| A4 | Is there a GSTIN / PAN field on payees? | 🔲 | |
| A5 | Are there duplicate payees across RHHF and RFPL, or is each payee scoped to one company? | 🔲 | Partially known — Motty Philip, Anil Kumar etc. appear in both |
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
| C3 | Payee list (all 109 entities) | `registry.entities` seed (022_seed_entities_from_approvals.sql) | ✅ Seed written, not yet run |
| C4 | Multi-level approval hierarchy (if any) | `pramaana.approvals` — design TBD | 🔲 |
| C5 | Receipt / proof upload flow | Pramaana settlement capture page | 🔲 |
| C6 | Historical payment records (for opening balances) | `pramaana.vouchers` opening balance import | 🔲 |

---

### 21.3 Pramaana (Self-Reference — Features Still Needed)

Pramaana is active and in use. This sub-section tracks features that exist in the Approvals app or are user-requested that Pramaana still needs to build.

**Folder status:** ✅ Open — primary development app

| # | Feature | Source Inspiration | Priority | Status |
|---|---------|-------------------|----------|--------|
| P1 | WhatsApp share button for settlement links | User request (June 2026) | High | ✅ Done June 12 2026 |
| P2 | Payment Confirmed action in Voucher Register | User request (June 2026) | High | ✅ Done June 12 2026 |
| P3 | Trial Balance report | Accounting standard | High | 🔲 |
| P4 | Ledger Statement (date-range, per ledger) | Accounting standard | High | 🔲 |
| P5 | Day Book (all vouchers in date order) | Accounting standard | Medium | 🔲 |
| P6 | Profit & Loss Statement | Accounting standard | Medium | 🔲 |
| P7 | Balance Sheet | Accounting standard | Medium | 🔲 |
| P8 | Multi-level payment approval hierarchy | Approvals app | Medium | 🔲 |
| P9 | Receipt / proof upload by payee at settlement | Approvals app | Medium | 🔲 |
| P10 | Period lock (prevent editing posted vouchers before lock date) | Accounting standard | Low | 🔲 |

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
