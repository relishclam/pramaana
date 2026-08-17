# Pramaana — Compliance Module
## System Definition, Workflows & Ledger Structure
**Version:** Aug-2026 | Companies: Relish Foods Pvt Ltd (RFPL) · Relish Hao Hao Chi Foods (RHHF)

---

## 1. System Definition

### 1.1 Purpose
The Compliance Module is Pramaana's statutory obligation management layer. It tracks every recurring filing deadline across GST, TDS, Income Tax, and ROC/Company Law, links filings to the underlying accounting records, and surfaces a live calendar showing what is overdue, imminent, or upcoming.

### 1.2 Architecture — Four Phases

| Phase | Label | What it builds |
|---|---|---|
| C1 | Foundations | Statutory identifiers per company (`company_statutory`), TDS rate table (`tds_rules`), challan registry (`statutory_challans`), party-level statutory attributes on ledgers (PAN, GSTIN, constitution, TDS defaults), compliance ledger scaffolding |
| C2 | TDS Engine | Per-transaction TDS deduction records (`voucher_tds_deductions`), challan linkage, Form 26Q data assembly |
| C3 | GST Engine | GSTR-1 outward supplies register, GSTR-3B summary, Input Tax Credit reconciliation, e-invoice flag |
| C4 | Calendar | `compliance_obligations` table with FY-wise deadlines seeded per company; mark-as-filed workflow; overdue/imminent/upcoming dashboard |

### 1.3 Key Database Tables

| Table | Schema | Purpose |
|---|---|---|
| `company_statutory` | `registry` | PAN, TAN, GSTIN, CIN, GST frequency (monthly/QRMP), e-invoice flag, LUT |
| `tds_rules` | `pramaana` | Section-wise threshold, standard rate, and surcharge — never hardcoded in UI |
| `statutory_challans` | `pramaana` | CBDT & GSTN challan records: BSR code, date, serial, amount, linked TDS/GST voucher |
| `compliance_obligations` | `pramaana` | One row per obligation per period per company. Tracks status, filed reference (ARN/CIN/SRN), amounts payable/paid, challan FK, and notes |
| `voucher_tds_deductions` | `pramaana` | One row per payment where TDS was withheld — carries PAN, section, gross amount, TDS amount, challan details |

### 1.4 Obligation Types Tracked

| Category | Obligations |
|---|---|
| **GST** | GSTR-1, GSTR-3B, GSTR-9, GSTR-9C, LUT, QRMP-PMT-06 |
| **TDS** | TDS-deposit (monthly), 26Q (quarterly), 24Q (quarterly) |
| **Income Tax** | ITR, 44AB (Tax Audit) |
| **ROC / Company Law** | AOC-4 (Financial Statements), MGT-7 (Annual Return), DIR-3-KYC, ADT-1, AGM |
| **Other** | IEC-renewal, MSME-return |

### 1.5 Obligation Statuses

| Status | Meaning |
|---|---|
| `upcoming` | Due date is in the future; no action yet |
| `in_progress` | Work started (return prepared, challan paid, etc.) |
| `filed` | Acknowledged/submitted; ARN or reference captured |
| `overdue` | Past due date, not filed (derived client-side from date; also stored at seed time) |
| `na` | Not applicable for this company/period |
| `waived` | Waived or exempt |

### 1.6 Pages & API

| Surface | Path | Role |
|---|---|---|
| Compliance Calendar | `/compliance` | All authenticated members |
| GST Reports | `/reports/gst` | Members with `canViewReports` |
| TDS Reports | `/reports/tds` | Members with `canViewReports` |
| Schedule III | `/reports/schedule-iii` | Members with `canViewReports` |
| API — obligations | `GET/POST/PATCH /api/compliance-obligations` | Server-side, auth-gated |
| API — profile | `GET/POST /api/compliance-profile` | Server-side; POST = super_admin only |

---

## 2. Workflows by Role

### 2.1 Accountant

The accountant is the primary day-to-day operator. Their compliance workflow is triggered by the calendar.

**Monthly routine (GST — RFPL):**
1. On the 1st of each month, open **Compliance → Calendar**
2. Filter by **GST** — identify the GSTR-1 (due 11th) and GSTR-3B (due 20th) for the prior month
3. Run **Compliance → GST Reports** — set dates to prior month — Run Report
4. Cross-check GSTR-1 invoice list against sales vouchers in the Voucher Register
5. File GSTR-1 on the GST portal; capture the ARN
6. Back in Pramaana, click **Update** on the GSTR-1 row → set status to **Filed ✓** → enter ARN and filed date → Save
7. Compute tax payable from GSTR-3B summary (output tax − ITC)
8. If tax is payable: create a **Payment voucher** in Pramaana — debit GSTN Payment, credit bank — record challan CIN in notes
9. File GSTR-3B on portal; capture ARN → mark obligation as **Filed ✓** in calendar

**Monthly routine (TDS):**
1. Identify TDS-deposit row for the month (due 7th of following month)
2. Verify `voucher_tds_deductions` entries for all payments made in the month (or check TDS Payable ledger balances)
3. Pay TDS via bank — create **Payment voucher**: debit TDS Payable → credit bank
4. Obtain CBDT challan (BSR code, date, serial, amount)
5. Record challan in Pramaana's challan registry (future: via UI; current: Supabase)
6. Mark TDS-deposit obligation as **Filed ✓** with challan CIN

**Quarterly (26Q):**
1. Compile deductee-wise TDS data from TDS Reports page
2. File Form 26Q on TRACES/TIN; obtain acknowledgment number
3. Mark 26Q obligation as **Filed ✓** with acknowledgment number

**Annual (GST):**
1. Prepare GSTR-9 annual return (exports from GST Reports)
2. If audit applicable: coordinate GSTR-9C with CA
3. Mark both obligations filed post acknowledgment

---

### 2.2 Admin (Super Admin)

The admin configures the compliance module, seeds obligations, and manages company statutory data. They do not file — they enable the accountant to do so correctly.

**Setup (one-time per company):**
1. Go to **Admin → Compliance Profile** (or via API `/api/compliance-profile`)
2. Enter PAN, TAN, GSTIN, CIN, GST frequency (monthly/QRMP), e-invoice flag, LUT number & validity
3. Ensure the correct GST ledgers are tagged:
   - **Ledgers** → edit each Output GST ledger (Cgst, Sgst, Igst) → enable **GST / Tax Ledger** → set tax type
   - Verify Input ITC ledgers are similarly tagged
4. Run the `tally_ledger_name` bulk-fill SQL if any ledger warnings appear (⚠️)

**FY rollover:**
1. Seed new FY obligations by running migration (or SQL insert block) for the new financial year
2. Review seeded obligations — mark any that are `na` or `waived` for this company
3. Set `amount_payable` on TDS-deposit rows once estimates are available

**Access control:**
- Only super_admin can `POST /api/compliance-profile`
- Company members can read their own obligations; admin can update any

---

### 2.3 Auditor (External CA / Abdul Rahim & Co)

The auditor's role is read-only verification + sign-off coordination. They do not enter data in Pramaana; they consume reports and confirm filings.

**Audit workflow:**
1. Request read access to the Pramaana company (admin grants member role)
2. Go to **Compliance → Calendar** — use **Filed** filter to see all filings for the FY
3. For each filed obligation, verify:
   - ARN / CIN / acknowledgment matches the portal acknowledgment copy
   - Filed date is on or before due date (no late fee due)
   - Amount paid matches ledger (statutory challan BSR, serial, amount)
4. **GST Audit:**
   - Run **GST Reports → GSTR-1** for the full FY — export CSV
   - Reconcile invoice-wise data against GST portal GSTR-1 (downloaded from GST portal)
   - Run **GSTR-3B** summary — verify output tax, ITC, and net liability match portal
5. **TDS Audit:**
   - Run **TDS Reports** — verify PAN-wise deduction, challan details, and 26Q match TRACES
6. **Income Tax:**
   - Export Trial Balance and Schedule III from Pramaana Reports
   - Use for P&L and Balance Sheet construction for ITR/44AB
7. Raise queries via **notes** field on specific obligations (currently narrative; future: comment thread)
8. Once satisfied, confirm to admin — admin marks obligation `filed` if still open

---

### 2.4 Consultant / Tax Advisor

The consultant advises on compliance strategy and prepares specific returns (GSTR-9C, 44AB, ITR). They work from Pramaana data but file independently.

**Engagement workflow:**
1. Admin grants read access for the engagement period
2. **GST Consultant:**
   - Export GSTR-1 and GSTR-3B CSV for the FY from GST Reports
   - Obtain ITC register from GSTR-2B (portal) — reconcile against Pramaana purchase register
   - Prepare GSTR-9 annual return; GSTR-9C if aggregate turnover > ₹5 Cr
   - Share reconciliation workings with accountant; accountant marks obligations filed
3. **Income Tax / 44AB Consultant:**
   - Download Schedule III from Pramaana (P&L + Balance Sheet)
   - Download TDS Reports for TDS credit verification (Form 26AS reconciliation)
   - Prepare ITR-6 (RFPL) — verify advance tax payments vs actuals
   - After filing, share ITR-V acknowledgment with accountant → mark ITR obligation filed
4. **ROC Consultant:**
   - Request Trial Balance, audited financials (from auditor), board resolution from admin
   - File AOC-4, MGT-7 on MCA portal — provide SRN to accountant
   - Accountant marks ROC obligations filed in Pramaana calendar

---

## 3. Ledger Structure — Compliance-Relevant Accounts

### 3.1 Ledger Groups (system-seeded, shared across companies)

| Group Code | Group Name | Nature | Parent |
|---|---|---|---|
| `ASSETS` | Assets | ASSET | — |
| `LIABILITIES` | Liabilities | LIABILITY | — |
| `INCOME` | Income | INCOME | — |
| `EXPENDITURE` | Expenditure | EXPENSE | — |
| `CURR_ASSETS` | Current Assets | ASSET | Assets |
| `CURR_LIAB` | Current Liabilities | LIABILITY | Liabilities |
| `DUTIES_TAXES` | Duties & Taxes | LIABILITY | Current Liabilities |
| `PROVISIONS` | Provisions | LIABILITY | Current Liabilities |
| `INDIRECT_EXP` | Indirect Expenses | EXPENSE | Expenditure |

---

### 3.2 Heads of Account — GST

| Ledger Name | Group | Nature | `is_tax_ledger` | `tax_type` | Notes |
|---|---|---|---|---|---|
| Output CGST | Duties & Taxes | LIABILITY | ✅ true | CGST | GST on intra-state sales — credit when invoicing |
| Output SGST | Duties & Taxes | LIABILITY | ✅ true | SGST | GST on intra-state sales |
| Output IGST | Duties & Taxes | LIABILITY | ✅ true | IGST | GST on inter-state sales |
| GST Input Tax Credit — CGST | Current Assets | ASSET | ✅ true | CGST | ITC available on purchases |
| GST Input Tax Credit — SGST | Current Assets | ASSET | ✅ true | SGST | ITC available on purchases |
| GST Input Tax Credit — IGST | Current Assets | ASSET | ✅ true | IGST | ITC available on purchases |
| GST Cash Ledger (Electronic) | Current Assets | ASSET | false | — | Mirror of GST portal electronic cash ledger |
| GSTN Payment | Current Liabilities | LIABILITY | false | — | Transit ledger used when remitting GST to portal |
| Gst Paid *(RFPL existing)* | Duties & Taxes | LIABILITY | false | — | Legacy ledger — net GST payment tracker |

> **Rule:** Only ledgers with `is_tax_ledger = true` contribute to the CGST/SGST/IGST breakup in GSTR-1 and GSTR-3B. All output GST ledgers must be tagged before voucher entry begins.

---

### 3.3 Heads of Account — TDS

| Ledger Name | Group | Nature | `tds_section_code` | Notes |
|---|---|---|---|---|
| TDS Payable — 192 (Salaries) | Current Liabilities | LIABILITY | `192` | TDS on salary payments |
| TDS Payable — 194C (Contractors) | Current Liabilities | LIABILITY | `194C` | TDS on contractor/sub-contractor payments |
| TDS Payable — 194I (Rent) | Current Liabilities | LIABILITY | `194I` | TDS on rent |
| TDS Payable — 194J (Professional) | Current Liabilities | LIABILITY | `194J` | TDS on professional / technical services |
| TDS Payable — 194A (Interest) | Current Liabilities | LIABILITY | `194A` | TDS on interest (excl. bank) |
| CBDT Payment — TDS | Current Liabilities | LIABILITY | — | Transit ledger for TDS remittance to CBDT |
| Interest on TDS (u/s 201/234E) | Indirect Expenses | EXPENSE | — | Late deposit interest — non-deductible |

> **Rule:** Party ledgers (vendors / employees) must have `pan`, `constitution`, and `tds_section_default` populated for TDS to auto-apply in Voucher Entry. `tds_exempt = true` for government bodies (e.g. KSIDC).

---

### 3.4 Heads of Account — Income Tax & ROC

| Ledger Name | Group | Nature | Notes |
|---|---|---|---|
| Advance Tax | Current Assets | ASSET | Advance tax paid u/s 207 — Dr when paid, reconciled at year end |
| TDS Receivable | Current Assets | ASSET | TDS deducted by customers on amounts received |
| Audit Fee Payable | Provisions | LIABILITY | CA audit fee accrual |
| Accrued Expenses | Provisions / Current Liabilities | LIABILITY | Year-end accruals for filing fees, MCA charges |

---

### 3.5 Sub-heads by Company

#### RFPL (Relish Foods Pvt Ltd) — GST-registered, Private Limited, TN state code 33

| Sub-head / Ledger | Head | Remarks |
|---|---|---|
| Cgst | Duties & Taxes | Output CGST — tagged `is_tax_ledger=true` |
| Sgst | Duties & Taxes | Output SGST — tagged `is_tax_ledger=true` |
| Igst | Duties & Taxes | Output IGST — tagged `is_tax_ledger=true` |
| IGST 5% | Duties & Taxes | Output IGST at reduced rate — tagged `is_tax_ledger=true` |
| Gst Paid | Duties & Taxes | Net payment ledger |
| All 5 TDS Payable ledgers | Current Liabilities | Auto-seeded via migration 084 |
| CBDT Payment — TDS | Current Liabilities | Auto-seeded |
| GSTN Payment | Current Liabilities | Auto-seeded |
| GST Cash Ledger (Electronic) | Current Assets | Auto-seeded |
| Interest on TDS (u/s 201/234E) | Indirect Expenses | Auto-seeded |

#### RHHF (Relish Hao Hao Chi Foods) — Partnership, Kerala state code 32, pre-production phase

| Sub-head / Ledger | Head | Remarks |
|---|---|---|
| Output CGST | Duties & Taxes | Created Aug-2026; tagged `is_tax_ledger=true` |
| Output SGST | Duties & Taxes | Created Aug-2026; tagged `is_tax_ledger=true` |
| Output IGST | Duties & Taxes | Created Aug-2026; tagged `is_tax_ledger=true` |
| GST Input Tax Credit — CGST | Current Assets | Tagged `is_tax_ledger=true`; ₹41,186.44 Dr opening |
| GST Input Tax Credit — SGST | Current Assets | Tagged `is_tax_ledger=true`; ₹41,186.44 Dr opening |
| GST Input Tax Credit — IGST | Current Assets | Created Aug-2026; tagged `is_tax_ledger=true` |
| GST Cash Ledger (Electronic) | Current Assets | Auto-seeded |
| GSTN Payment | Current Liabilities | Auto-seeded |
| All 5 TDS Payable ledgers | Current Liabilities | Auto-seeded via migration 084 |
| Interest on TDS (u/s 201/234E) | Indirect Expenses | Auto-seeded |

> **Note:** RHHF is in construction phase. No GSTR-1/GSTR-3B obligations are seeded (not yet GST-registered for output supplies). TDS-deposit and 26Q obligations are active. GST obligations will be added when production commences (~Oct 2026) by updating `company_statutory.gst_frequency` and inserting new obligation rows — no code change required.

---

*Last updated: 17 Aug 2026 — Pramaana compliance module v1 (migrations 084–086)*