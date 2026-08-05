# PRAMAANA — Autonomous Bank Reconciliation Module

## Claude Code Implementation Instructions

**Repository:** `relishclam/pramaana`
**Deployment:** Vercel (`pramaana-tau.vercel.app`)
**Database:** Supabase project `mmkbknnzgpvsqgnynrbe` (`https://mmkbknnzgpvsqgnynrbe.supabase.co`), schema `pramaana`
**Stack:** Next.js 14+ / TypeScript / Tailwind / Supabase (Postgres + Auth + Storage)

This module **replaces** the existing Bank Reconciliation module in Pramaana. The existing code under `/app/bank-recon/`, `/api/bank-upload`, `/api/bank-match`, and all related database objects (`bank_statements`, `bank_transactions`, `bank_format_config`, `bank_matches`) will be retired and replaced by the architecture described here.

**Design Principle:** "Deterministic where possible, AI where necessary, never manual."

---

## 0. CONTEXT YOU MUST KNOW

### 0.1 Companies

| Entity | company_id | Banks |
|--------|-----------|-------|
| RFPL (Relish Foods Pvt Ltd) | `bc455c94-0bcd-4d66-a040-d29ed880d22f` | Canara, Federal (`10150200014513`), Airwallex |
| RHHF (Relish Hao Hao Chi Foods) | `b8beb440-df7f-48e8-a012-ac5750502eca` | HDFC Current (`99999446012324`), HDFC No Lien (`50200115901702`), South Indian Bank |

### 0.2 Existing Schema Objects to Replace

These exist in the database now. **Do not drop them until the new module is verified end-to-end.** Instead, create the new tables alongside, migrate data if feasible, then drop the old ones in a final cleanup migration.

- `pramaana.bank_statements` — old statement uploads
- `pramaana.bank_transactions` — old parsed transactions
- `pramaana.bank_format_config` — old rigid per-bank column configs
- `pramaana.bank_matches` — old match results

### 0.3 Existing Bugs in the Old Module (for reference — do not carry forward)

1. **`min(uuid)` — Postgres error 42883.** The old match engine calls `MIN()` on a UUID column. Postgres has no `min` aggregate for `uuid`. The new module must never aggregate on UUID columns.
2. **No opening balance derivation.** If the CSV/XLSX doesn't have an explicit opening balance row, the old parser sets it to 0, causing balance validation to fail.
3. **No sort-order detection.** Federal Bank CSVs are reverse-chronological (newest first). The old parser assumes ascending order, causing fencepost errors in balance validation.
4. **Rigid format config.** One row per bank in `bank_format_config` with fixed column indices. Any format variation (different CSV export, new bank) requires a manual DB insert. The new module eliminates this entirely.
5. **No overlap resolution.** Uploading a statement whose period overlaps an existing one returns a 409 with no option to merge or replace.

### 0.4 Integration Points

- **Vouchers:** `pramaana.vouchers` (status = `'posted'`; always filter on this). Voucher entries in `pramaana.voucher_entries` with `ledger_id` FK.
- **Ledgers:** `pramaana.ledgers` — bank accounts have `is_bank_account = true`. The `name` column (not `ledger_name`) is the display name.
- **Entities:** Master data lives in `registry.entities` / `registry.entity_roles` (in the Relish Suite schema, same Supabase project). Party names use `display_name`, `legal_name`, `alias`.
- **Auth:** Supabase Auth. RLS is active. All tables need company-scoped RLS policies.
- **UI Theme:** Pramaana uses a dark theme. Match the existing design language in `/app` — dark backgrounds, teal/cyan accents, red for errors, green for success.

---

## 1. DATABASE SCHEMA

All tables in the `pramaana` schema. Every table must have RLS enabled with policies scoped to `company_id` via the user's `company_users` membership.

### 1.1 `recon_bank_accounts`

Master list of bank accounts known to the system. One row per physical bank account per company.

```sql
CREATE TABLE pramaana.recon_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES pramaana.companies(id),
  bank_code text NOT NULL,              -- 'HDFC', 'CANARA', 'FEDERAL', 'SIB', 'ICICI', 'AIRWALLEX'
  bank_name text NOT NULL,              -- 'HDFC Bank', 'Canara Bank', etc.
  account_number text NOT NULL,         -- masked or full
  ifsc text,                            -- IFSC code if Indian bank
  branch text,
  account_type text,                    -- 'current', 'savings', 'cc', 'od'
  ledger_id uuid REFERENCES pramaana.ledgers(id),  -- link to the bank ledger in books
  currency text DEFAULT 'INR',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE (company_id, bank_code, account_number)
);
```

### 1.2 `recon_format_profiles`

Learned format signatures. The system auto-creates a profile the first time it successfully parses a new format. Future uploads matching the same signature skip AI detection entirely.

```sql
CREATE TABLE pramaana.recon_format_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_code text NOT NULL,
  format_signature text NOT NULL,       -- hash of normalised header row
  column_mapping jsonb NOT NULL,        -- ColumnMapping object (see §3.3)
  sample_headers text[],                -- raw header values for display
  detection_method text NOT NULL DEFAULT 'heuristic',  -- 'heuristic' | 'ai'
  times_used integer DEFAULT 1,
  last_used_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),

  UNIQUE (bank_code, format_signature)
);
```

### 1.3 `recon_statements`

One row per uploaded statement. A statement is a contiguous date range of transactions for one bank account.

```sql
CREATE TABLE pramaana.recon_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES pramaana.companies(id),
  bank_account_id uuid NOT NULL REFERENCES pramaana.recon_bank_accounts(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  opening_balance numeric(15,2) NOT NULL,
  closing_balance numeric(15,2) NOT NULL,
  total_debits numeric(15,2) NOT NULL DEFAULT 0,
  total_credits numeric(15,2) NOT NULL DEFAULT 0,
  txn_count integer NOT NULL DEFAULT 0,
  debit_count integer NOT NULL DEFAULT 0,
  credit_count integer NOT NULL DEFAULT 0,
  sort_order text NOT NULL DEFAULT 'asc',  -- 'asc' | 'desc' (as detected)
  format_profile_id uuid REFERENCES pramaana.recon_format_profiles(id),
  file_name text,
  file_hash text,                       -- SHA-256 of raw file for dedup
  upload_status text NOT NULL DEFAULT 'processing',
    -- 'processing' | 'parsed' | 'matched' | 'error'
  error_message text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT no_inverted_period CHECK (period_from <= period_to)
);

-- Allow overlapping periods for the same bank account but warn the user.
-- Do NOT reject with a 409. Instead, detect overlap and offer: skip duplicates / replace / merge.
CREATE INDEX idx_recon_statements_bank_period
  ON pramaana.recon_statements (bank_account_id, period_from, period_to);
```

### 1.4 `recon_transactions`

Parsed and normalised bank transactions. Every row is in canonical form regardless of source bank or format.

```sql
CREATE TABLE pramaana.recon_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES pramaana.recon_statements(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES pramaana.recon_bank_accounts(id),
  row_number integer NOT NULL,          -- 1-indexed, in chronological order
  txn_date date NOT NULL,
  value_date date,
  narration text NOT NULL,
  reference text,                       -- cheque no / UTR / IMPS ref (cleaned)
  debit numeric(15,2),                  -- withdrawal (NULL if credit)
  credit numeric(15,2),                 -- deposit (NULL if debit)
  balance numeric(15,2),                -- running balance after this txn
  -- Parsed narration fields (populated by AI or heuristic)
  txn_type text,                        -- 'UPI', 'NEFT', 'RTGS', 'IMPS', 'ATM', 'POS', 'CHEQUE', 'FD', 'SWEEP', 'CHARGE', 'INTEREST', 'GST', 'OTHER'
  counterparty text,                    -- extracted counterparty name
  counterparty_account text,            -- extracted account/UPI ID if available
  parsed_reference text,                -- cleaned UTR/ref extracted from narration
  parsed_purpose text,                  -- extracted purpose/note
  is_charge boolean DEFAULT false,      -- bank charges, SMS charges, GST on charges
  is_reversal boolean DEFAULT false,
  -- Match state
  match_status text NOT NULL DEFAULT 'unmatched',
    -- 'unmatched' | 'auto_matched' | 'manual_matched' | 'disputed' | 'written_off'
  created_at timestamptz DEFAULT now(),

  CONSTRAINT exactly_one_side CHECK (
    (debit IS NOT NULL AND credit IS NULL) OR
    (debit IS NULL AND credit IS NOT NULL)
  )
);

CREATE INDEX idx_recon_txn_match ON pramaana.recon_transactions (bank_account_id, match_status);
CREATE INDEX idx_recon_txn_date ON pramaana.recon_transactions (bank_account_id, txn_date);
CREATE INDEX idx_recon_txn_amount ON pramaana.recon_transactions (bank_account_id, debit, credit);
```

### 1.5 `recon_matches`

Links between bank transactions and book vouchers/entries.

```sql
CREATE TABLE pramaana.recon_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_txn_id uuid NOT NULL REFERENCES pramaana.recon_transactions(id) ON DELETE CASCADE,
  voucher_id uuid REFERENCES pramaana.vouchers(id),         -- matched voucher (if any)
  voucher_entry_id uuid REFERENCES pramaana.voucher_entries(id), -- specific entry line
  match_method text NOT NULL,           -- 'exact', 'fuzzy', 'ai', 'manual'
  match_confidence numeric(5,2),        -- 0.00–100.00
  match_reason text,                    -- human-readable explanation
  matched_by uuid REFERENCES auth.users(id),  -- NULL for auto matches
  matched_at timestamptz DEFAULT now(),
  is_confirmed boolean DEFAULT false,   -- user has reviewed and accepted
  created_at timestamptz DEFAULT now(),

  UNIQUE (bank_txn_id)  -- one bank txn matches at most one voucher (for now)
);

CREATE INDEX idx_recon_matches_voucher ON pramaana.recon_matches (voucher_id);
```

### 1.6 `recon_queries`

Unresolved items in the reconciliation workbench.

```sql
CREATE TABLE pramaana.recon_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_txn_id uuid REFERENCES pramaana.recon_transactions(id),  -- NULL if book-side orphan
  voucher_id uuid REFERENCES pramaana.vouchers(id),              -- NULL if bank-side orphan
  query_type text NOT NULL,
    -- 'bank_orphan'       — in bank, not in books
    -- 'book_orphan'       — in books, not in bank
    -- 'amount_mismatch'   — same txn, different amount
    -- 'date_mismatch'     — same txn, different date
    -- 'duplicate_suspect' — possible duplicate
  status text NOT NULL DEFAULT 'open',
    -- 'open' | 'investigating' | 'resolved' | 'written_off' | 'adjusted'
  resolution_note text,
  resolution_voucher_id uuid REFERENCES pramaana.vouchers(id),  -- JV created to resolve
  assigned_to uuid REFERENCES auth.users(id),
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

### 1.7 RLS Policies

Apply to every table above. Pattern:

```sql
ALTER TABLE pramaana.recon_<table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_access" ON pramaana.recon_<table>
  FOR ALL
  USING (
    company_id IN (
      SELECT cu.company_id FROM pramaana.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cu.company_id FROM pramaana.company_users cu
      WHERE cu.user_id = auth.uid()
    )
  );
```

---

## 2. FILE STRUCTURE

```
/app/bank-recon/
  page.tsx                    -- main page with tab navigation
  layout.tsx
  /components/
    upload-panel.tsx           -- file upload + paste CSV + drag-drop
    upload-progress.tsx        -- step-by-step progress indicator
    statement-list.tsx         -- previously uploaded statements
    match-workbench.tsx        -- review matches, confirm/reject
    query-panel.tsx            -- unresolved items
    brs-report.tsx             -- Bank Reconciliation Statement
    bank-account-picker.tsx    -- auto-detected, with manual override

/lib/bank-recon/
  types.ts                     -- all TypeScript interfaces
  pre-converter.ts             -- the core normalisation pipeline
  bank-detect.ts               -- heuristic bank detection
  format-detect.ts             -- heuristic format/column detection
  balance-validator.ts         -- continuity checks
  match-engine.ts              -- three-tier matching logic
  narration-parser.ts          -- heuristic narration parsing
  ai-format-detect.ts          -- Claude API: format detection
  ai-narration-parse.ts        -- Claude API: narration intelligence
  ai-match-suggest.ts          -- Claude API: match suggestions
  csv-parser.ts                -- CSV/TSV parsing with edge cases
  xlsx-parser.ts               -- XLSX parsing (header detection, data extraction)
  number-utils.ts              -- Indian number format handling
  date-utils.ts                -- multi-format date parsing
  constants.ts                 -- bank signatures, known patterns

/api/bank-recon/
  upload/route.ts              -- POST: accept file, run full pipeline
  match/route.ts               -- POST: run match engine on a statement
  confirm-match/route.ts       -- POST: user confirms/rejects a match
  query/route.ts               -- GET/PATCH: manage recon queries
  brs/route.ts                 -- GET: generate BRS report
  bank-accounts/route.ts       -- GET/POST: manage bank accounts
  statements/[id]/route.ts     -- GET/DELETE: statement detail/removal
```

---

## 3. THE PRE-CONVERTER PIPELINE

This is the heart of the module. Every uploaded file passes through this pipeline before any data reaches the database.

### 3.1 Pipeline Stages

```
RAW INPUT
  │
  ▼
┌─────────────────────┐
│ 1. FILE TYPE DETECT  │  Determine: CSV, XLSX, JSON, TSV, PDF
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 2. RAW EXTRACT       │  Read into rows of strings
│    - XLSX: openpyxl   │  (server-side: use SheetJS/xlsx npm)
│    - CSV: handle      │
│      encoding,        │
│      delimiters,      │
│      quoting          │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 3. HEADER DETECT     │  Find the row with column headers
│    - Skip decorative  │  (bank name, address, account info
│      rows at top      │   are metadata, not headers)
│    - Skip separator   │  ('********' rows)
│      rows             │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 4. BANK DETECT       │  Identify the bank from:
│    - Header patterns  │  header column names, metadata rows,
│    - Metadata rows    │  narration patterns, file name
│    - Narration scan   │
│    - AI fallback      │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 5. COLUMN MAP        │  Map columns to canonical schema:
│    - Heuristic first  │  date, value_date, narration,
│    - AI fallback      │  reference, debit, credit, balance
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 6. DATA CLEAN        │  Per-cell transforms:
│    - Strip Excel      │  ="value" → value
│      quoting          │
│    - Normalise dates  │  DD/MM/YY → YYYY-MM-DD
│    - Normalise nums   │  1,42,729.92 → 142729.92
│    - Strip whitespace │
│    - Skip footer/     │
│      summary rows     │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 7. SORT ORDER        │  Compare first and last txn dates.
│    DETECT & FIX       │  If descending → reverse rows.
│                       │  If same-day only → check balance
│                       │  direction.
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 8. BALANCE           │  Derive opening balance:
│    DERIVATION         │  opening = row[0].balance
│                       │    - row[0].credit
│                       │    + row[0].debit
│                       │  Verify: opening + Σcredits
│                       │    - Σdebits = closing
│                       │  Verify: row-by-row continuity
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 9. DEDUP             │  Detect exact duplicate rows
│                       │  (same date + amount + narration
│                       │   + reference). Flag, don't remove.
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 10. OVERLAP CHECK    │  Check against existing statements
│                       │  for this bank account. If overlap:
│                       │  → return overlap info to UI
│                       │  → let user choose: skip/replace/merge
│                       │  Do NOT auto-reject with 409.
└──────────┬──────────┘
           ▼
CANONICAL TRANSACTIONS (ready for DB insert + matching)
```

### 3.2 Bank Detection — Heuristic Signatures

```typescript
// /lib/bank-recon/constants.ts

export const BANK_SIGNATURES: Record<string, BankSignature> = {
  HDFC: {
    code: 'HDFC',
    name: 'HDFC Bank',
    header_patterns: [
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ],
    metadata_patterns: [
      /HDFC\s*BANK/i,
      /IFSC\s*:?\s*HDFC\d/i,
    ],
    narration_markers: ['UPI-', 'NEFT CR-', 'NEFT DR-', 'POS 514834', 'RTGS CR-', 'RTGS DR-'],
    date_formats: ['DD/MM/YY', 'DD/MM/YYYY'],
    number_format: 'international',   // 142,729.92
  },

  CANARA: {
    code: 'CANARA',
    name: 'Canara Bank',
    header_patterns: [
      ['Txn Date', 'Value Date', 'Cheque No.', 'Description', 'Branch Code', 'Debit', 'Credit', 'Balance'],
    ],
    metadata_patterns: [
      /CANARA\s*BANK/i,
    ],
    narration_markers: ['IB-IMPS-DR//', 'ATM Cash-', 'MOB-IMPS-CR/', 'IB ITG'],
    date_formats: ['DD-MM-YYYY HH:mm:ss', 'DD Mon YYYY'],
    number_format: 'indian',           // 1,42,729.92
    excel_quoted: true,                // values wrapped in ="..."
  },

  FEDERAL: {
    code: 'FEDERAL',
    name: 'Federal Bank',
    header_patterns: [
      ['Sl. No.', 'Tran Date', 'Particulars', 'Value Date', 'Tran Type', 'Cheque Details', 'Withdrawal', 'Deposit', 'Balance Amount'],
      // Allow partial match with empty column between Particulars and Value Date
    ],
    metadata_patterns: [
      /FEDERAL\s*BANK/i,
      /Account\s*Category:\s*FREEDOM/i,
    ],
    narration_markers: ['FN IMPS/IFO/', 'UPIOUT/', 'UPIIN/', 'FT IMPS/IFI/'],
    date_formats: ['DD-MM-YYYY'],
    number_format: 'international',
    typical_sort: 'desc',              // Federal typically exports newest-first
  },

  SIB: {
    code: 'SIB',
    name: 'South Indian Bank',
    header_patterns: [
      ['Transaction Date', 'Value Date', 'Description', 'Cheque No', 'Debit', 'Credit', 'Balance'],
    ],
    metadata_patterns: [
      /SOUTH\s*INDIAN\s*BANK/i,
    ],
    narration_markers: [],
    date_formats: ['DD-MM-YYYY', 'DD/MM/YYYY'],
    number_format: 'international',
  },

  ICICI: {
    code: 'ICICI',
    name: 'ICICI Bank',
    header_patterns: [
      ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )'],
    ],
    metadata_patterns: [
      /ICICI\s*BANK/i,
    ],
    narration_markers: ['UPI/', 'NEFT-', 'RTGS-'],
    date_formats: ['DD/MM/YYYY'],
    number_format: 'international',
  },
};
```

**Detection algorithm (in `/lib/bank-recon/bank-detect.ts`):**

1. Scan rows 0–20 for metadata patterns (bank name, IFSC). If a metadata pattern matches → confidence 95%.
2. Find the header row. Compare header values against each bank's `header_patterns` using normalised fuzzy matching (lowercase, strip spaces, ignore punctuation). Score = matched columns / total columns. If best score ≥ 0.7 → confidence = score × 100.
3. If no header match, scan first 50 narration values against `narration_markers`. If ≥ 3 markers from one bank match → confidence 80%.
4. Check file name for bank name strings.
5. If best confidence < 70% → call AI format detection (§3.5).
6. Return: `{ bank_code, bank_name, confidence, method: 'heuristic' | 'ai' }`.

### 3.3 Column Mapping Interface

```typescript
// /lib/bank-recon/types.ts

export interface ColumnMapping {
  date_col: number;              // transaction date column index (0-based)
  value_date_col: number | null; // value/clearing date (null if absent)
  narration_col: number;         // description / particulars
  reference_col: number | null;  // cheque no / UTR / ref
  debit_col: number;             // withdrawal amount
  credit_col: number;            // deposit amount
  balance_col: number;           // running balance
  // For banks that use a single amount column + D/C indicator:
  amount_col: number | null;     // single amount column
  dr_cr_col: number | null;      // 'D'/'C' or 'Dr'/'Cr' indicator
  // Format details:
  date_format: string;           // 'DD/MM/YY' | 'DD-MM-YYYY' | 'DD/MM/YYYY' | etc.
  number_format: 'indian' | 'international';
  header_row: number;            // 0-indexed row containing column headers
  data_start_row: number;        // 0-indexed first data row (after header + separators)
  skip_patterns: string[];       // row values to skip: '********', footer text, etc.
  excel_quoted: boolean;         // values wrapped in ="..."
}

export interface PreConvertResult {
  bank: { code: string; name: string; confidence: number; method: string };
  account: { number: string | null; ifsc: string | null; branch: string | null };
  format: { mapping: ColumnMapping; profile_id: string | null; confidence: number };
  transactions: CanonicalTransaction[];
  opening_balance: number;
  closing_balance: number;
  period_from: string;           // YYYY-MM-DD
  period_to: string;             // YYYY-MM-DD
  sort_detected: 'asc' | 'desc';
  validation: ValidationResult;
  duplicates: DuplicateGroup[];
  overlap: OverlapInfo | null;
}

export interface CanonicalTransaction {
  row_number: number;            // 1-indexed, chronological
  txn_date: string;              // YYYY-MM-DD (ISO)
  value_date: string | null;
  narration: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number;
}

export interface ValidationResult {
  is_valid: boolean;
  opening_balance: number;
  closing_balance: number;
  computed_closing: number;      // opening + credits - debits
  total_debits: number;
  total_credits: number;
  balance_continuous: boolean;   // every row's balance = prev ± txn
  discontinuities: { row: number; expected: number; actual: number }[];
  errors: string[];
}
```

### 3.4 Critical Transform Functions

Each of these must be a pure function with unit tests.

**3.4.1 Excel Quoting Removal**

```typescript
// Canara Bank wraps values like: ="03-10-2024 17:36:32"
// Also handles: ="427717093839", ="853.00"
export function stripExcelQuoting(value: string): string {
  if (typeof value !== 'string') return value;
  const match = value.match(/^="?(.*?)"?$/);
  return match ? match[1] : value;
}
```

**3.4.2 Indian Number Format**

```typescript
// Indian: 1,42,729.92 (lakhs/crores grouping: 1,00,000)
// International: 142,729.92
// Must handle: "1,42,729.92" and "142729.92" and "853.00" and "" and null
export function parseIndianNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  // Strip all commas, then parse
  const cleaned = value.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
```

**3.4.3 Date Normalisation**

```typescript
// Must handle all Indian bank date formats:
//   DD/MM/YY     → 01/04/26
//   DD/MM/YYYY   → 01/04/2026
//   DD-MM-YYYY   → 01-04-2026
//   DD-Mon-YYYY  → 01-Apr-2026
//   DD Mon YYYY  → 01 Apr 2026
//   DD-MM-YYYY HH:mm:ss → 03-10-2024 17:36:32
//   YYYY-MM-DD   → 2026-04-01 (already ISO)
//
// CRITICAL: DD/MM, not MM/DD. All Indian bank statements use DD/MM.
// Two-digit years: 00–49 → 2000–2049, 50–99 → 1950–1999.
// Return: YYYY-MM-DD string.

export function normaliseDate(value: string, format?: string): string | null {
  // Implementation must try formats in order of specificity.
  // Never guess MM/DD — Indian banks always use DD/MM.
}
```

**3.4.4 Sort Order Detection**

```typescript
export function detectSortOrder(transactions: CanonicalTransaction[]): 'asc' | 'desc' {
  if (transactions.length < 2) return 'asc';

  const firstDate = new Date(transactions[0].txn_date);
  const lastDate = new Date(transactions[transactions.length - 1].txn_date);

  if (firstDate < lastDate) return 'asc';
  if (firstDate > lastDate) return 'desc';

  // Same date on first and last — check balance direction.
  // If balance decreases from first to last AND there are net debits → likely desc.
  // Fallback: check a middle row.
  const midIdx = Math.floor(transactions.length / 2);
  const midDate = new Date(transactions[midIdx].txn_date);
  if (firstDate > midDate) return 'desc';

  return 'asc'; // default
}
```

**3.4.5 Opening Balance Derivation**

```typescript
// After sorting transactions chronologically:
// opening = first_row.balance - first_row.credit + first_row.debit
export function deriveOpeningBalance(firstTxn: CanonicalTransaction): number {
  const credit = firstTxn.credit ?? 0;
  const debit = firstTxn.debit ?? 0;
  return firstTxn.balance - credit + debit;
}
```

**3.4.6 Balance Continuity Validation**

```typescript
export function validateBalanceContinuity(
  transactions: CanonicalTransaction[],
  openingBalance: number
): ValidationResult {
  const discontinuities: { row: number; expected: number; actual: number }[] = [];
  let runningBalance = openingBalance;
  let totalDebits = 0;
  let totalCredits = 0;

  for (const txn of transactions) {
    const credit = txn.credit ?? 0;
    const debit = txn.debit ?? 0;
    totalDebits += debit;
    totalCredits += credit;

    const expected = runningBalance + credit - debit;
    // Use epsilon comparison for floating point: |expected - actual| < 0.01
    if (Math.abs(expected - txn.balance) >= 0.01) {
      discontinuities.push({
        row: txn.row_number,
        expected: Math.round(expected * 100) / 100,
        actual: txn.balance,
      });
    }
    runningBalance = txn.balance;  // Use actual balance to continue (don't accumulate errors)
  }

  const closingBalance = transactions[transactions.length - 1]?.balance ?? openingBalance;
  const computedClosing = Math.round((openingBalance + totalCredits - totalDebits) * 100) / 100;

  return {
    is_valid: discontinuities.length === 0 && Math.abs(computedClosing - closingBalance) < 0.01,
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    computed_closing: computedClosing,
    total_debits: Math.round(totalDebits * 100) / 100,
    total_credits: Math.round(totalCredits * 100) / 100,
    balance_continuous: discontinuities.length === 0,
    discontinuities,
    errors: [],
  };
}
```

### 3.5 AI Format Detection (Claude Sonnet 4.6)

ANTROPIC_API_KEY must be set in the server environment. KEY is added in .env of the PRAMAANA Project Folder.

Use only when heuristic detection confidence < 70%. Called via the Anthropic API from a Next.js API route (server-side only — never expose the API key to the client).

```typescript
// /lib/bank-recon/ai-format-detect.ts

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();  // ANTHROPIC_API_KEY from env

export async function aiDetectFormat(
  rawLines: string[],   // first 25 lines of the file
  fileType: string
): Promise<AIFormatResult> {
  const sample = rawLines.slice(0, 25).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: `You are a bank statement format detector for Indian banks. You will receive a sample of a bank statement file and must identify the bank, column layout, and format details. Respond with ONLY a JSON object, no markdown, no explanation.`,
    messages: [{
      role: 'user',
      content: `Analyse this ${fileType} bank statement sample and return the format as JSON.

SAMPLE:
${sample}

Return ONLY this JSON structure:
{
  "bank_code": "HDFC|CANARA|FEDERAL|SIB|ICICI|SBI|AXIS|KOTAK|BOB|PNB|IOB|INDIAN|AIRWALLEX|OTHER",
  "bank_name": "full bank name",
  "account_number": "if visible in metadata rows, else null",
  "ifsc": "if visible, else null",
  "header_row": 0-indexed row number with column headers,
  "data_start_row": 0-indexed first data row,
  "columns": {
    "date": column_index,
    "value_date": column_index_or_null,
    "narration": column_index,
    "reference": column_index_or_null,
    "debit": column_index,
    "credit": column_index,
    "balance": column_index,
    "amount": column_index_or_null,
    "dr_cr_indicator": column_index_or_null
  },
  "date_format": "DD/MM/YY|DD-MM-YYYY|DD/MM/YYYY|DD-Mon-YYYY",
  "sort_order": "asc|desc",
  "number_format": "indian|international",
  "excel_quoted": true_or_false,
  "skip_patterns": ["patterns for rows to ignore, e.g. '********'"]
}`
    }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  // Strip any accidental markdown fencing
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  return JSON.parse(cleaned);
}
```

**Important:** Store every successful AI detection as a new `recon_format_profiles` row so the same format is detected heuristically next time.

### 3.6 Narration Parsing

Two-stage: heuristic first, AI for what heuristic can't handle.

**Heuristic (handles 70%+ of Indian bank narrations):**

```typescript
// /lib/bank-recon/narration-parser.ts

const NARRATION_PATTERNS = [
  // UPI: UPI-<name>-<upi_id>-<ifsc>-<ref>-<purpose>
  {
    type: 'UPI',
    pattern: /^UPI[-/](.+?)[-/](\S+@\S+)[-/](\w+)[-/](\d+)[-/]?(.*)$/i,
    extract: (m: RegExpMatchArray) => ({
      counterparty: m[1].trim(),
      counterparty_account: m[2],
      parsed_reference: m[4],
      parsed_purpose: m[5] || null,
    }),
  },
  // UPIOUT (Federal): UPIOUT/<ref>/<upi_id>/Fed/<suffix>
  {
    type: 'UPI',
    pattern: /^UPIOUT\/(\d+)\/(\S+@\S+)\//i,
    extract: (m: RegExpMatchArray) => ({
      counterparty_account: m[2],
      parsed_reference: m[1],
    }),
  },
  // NEFT/RTGS: NEFT CR-<code>-<name> or IB-IMPS-DR//<bank>/**<ref>//<date>/<txn_id>
  {
    type: 'IMPS',
    pattern: /^IB-IMPS-DR\/\/(\w+)\/\*\*(\d+)\/\//i,
    extract: (m: RegExpMatchArray) => ({
      parsed_reference: m[2],
    }),
  },
  // FN IMPS (Federal): FN IMPS/IFO/<ref>/<ifsc>/<purpose>
  {
    type: 'IMPS',
    pattern: /^FN IMPS\/IF[OI]\/(\d+)\/(\w+)\/(.*)/i,
    extract: (m: RegExpMatchArray) => ({
      parsed_reference: m[1],
      counterparty_account: m[2],
      parsed_purpose: m[3],
    }),
  },
  // ATM Cash withdrawal
  {
    type: 'ATM',
    pattern: /^ATM Cash/i,
    extract: () => ({}),
  },
  // RTGS
  {
    type: 'RTGS',
    pattern: /^RTGS\s*(CR|DR)[-/]/i,
    extract: () => ({}),
  },
  // Bank charges
  {
    type: 'CHARGE',
    pattern: /^(ATM\s*\/\s*IMPS\s*Transaction\s*Charges|CHRG\/|SMS CHARGES|GST\s*ON|SERVICE\s*CHARGE|PROCESSING\s*FEE)/i,
    extract: () => ({ is_charge: true }),
  },
  // Interest
  {
    type: 'INTEREST',
    pattern: /^(CREDIT\s*INTEREST|INT\.\s*ON|INTEREST\s*PAID)/i,
    extract: () => ({}),
  },
];

export function parseNarration(narration: string): ParsedNarration {
  for (const pat of NARRATION_PATTERNS) {
    const match = narration.match(pat.pattern);
    if (match) {
      return {
        txn_type: pat.type,
        ...pat.extract(match),
        is_charge: pat.type === 'CHARGE',
        is_reversal: /reversal|reversed|return/i.test(narration),
      };
    }
  }
  return { txn_type: 'OTHER' };
}
```

**AI Narration Parsing (for the 30% heuristic can't handle):**

```typescript
// /lib/bank-recon/ai-narration-parse.ts

// Call ONLY for narrations where heuristic returned txn_type = 'OTHER'.
// Batch up to 50 narrations per call to minimise API calls.

export async function aiParseNarrations(
  narrations: { index: number; text: string }[]
): Promise<AIParsedNarration[]> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: `You parse Indian bank transaction narrations into structured data. Return ONLY a JSON array. No markdown, no explanation.`,
    messages: [{
      role: 'user',
      content: `Parse each narration. Return a JSON array of objects.

${narrations.map(n => `${n.index}: ${n.text}`).join('\n')}

Each object:
{
  "index": number,
  "txn_type": "UPI|NEFT|RTGS|IMPS|ATM|POS|CHEQUE|FD|SWEEP|CHARGE|INTEREST|GST|SALARY|OTHER",
  "counterparty": "extracted name or null",
  "counterparty_account": "UPI ID or account number or null",
  "parsed_reference": "UTR/ref number or null",
  "parsed_purpose": "purpose/note or null",
  "is_charge": boolean,
  "is_reversal": boolean
}`
    }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
  return JSON.parse(text.replace(/```json\s*|```\s*/g, '').trim());
}
```

---

## 4. MATCH ENGINE

### 4.1 Three-Tier Matching

Run in order. Each tier only processes transactions not yet matched by a prior tier.

**Tier 1 — Exact Match (confidence 95–100)**

```sql
-- For each unmatched bank debit, find a posted voucher entry
-- that credits the same bank ledger with the exact amount on the exact date.
SELECT
  bt.id AS bank_txn_id,
  ve.id AS voucher_entry_id,
  ve.voucher_id,
  100.00 AS confidence,
  'exact' AS method
FROM pramaana.recon_transactions bt
JOIN pramaana.recon_bank_accounts ba ON ba.id = bt.bank_account_id
JOIN pramaana.voucher_entries ve ON ve.ledger_id = ba.ledger_id
JOIN pramaana.vouchers v ON v.id = ve.voucher_id
WHERE bt.match_status = 'unmatched'
  AND bt.statement_id = $1
  AND v.status = 'posted'
  AND v.company_id = bt.company_id
  -- Amount match: bank debit = book credit (payment), bank credit = book debit (receipt)
  AND (
    (bt.debit IS NOT NULL AND ve.credit = bt.debit)
    OR
    (bt.credit IS NOT NULL AND ve.debit = bt.credit)
  )
  -- Exact date match
  AND v.voucher_date = bt.txn_date
  -- Not already matched
  AND NOT EXISTS (
    SELECT 1 FROM pramaana.recon_matches rm WHERE rm.voucher_entry_id = ve.id
  );
```

If both reference fields are populated and they match → confidence 100.
If references don't match or one is null → confidence 95.

**Tier 2 — Fuzzy Match (confidence 70–94)**

Same query but with relaxed conditions:

```sql
  -- Amount match: exact
  AND (
    (bt.debit IS NOT NULL AND ve.credit = bt.debit)
    OR
    (bt.credit IS NOT NULL AND ve.debit = bt.credit)
  )
  -- Date match: ±3 days
  AND ABS(v.voucher_date - bt.txn_date) <= 3
```

Confidence scoring:

- Same date: +10
- ±1 day: +7
- ±2 days: +4
- ±3 days: +0
- Reference partial match (substring): +10
- Counterparty name matches voucher party (fuzzy): +5

Base confidence: 70. Add bonuses. Cap at 94.

**Tier 3 — AI Match (confidence 50–69)**

For remaining unmatched transactions, send them to Claude with candidate vouchers (pre-filtered by amount ±10% and date ±7 days):

```typescript
// /lib/bank-recon/ai-match-suggest.ts

// Batch: send up to 10 unmatched bank txns with their top-5 candidate vouchers each.
export async function aiSuggestMatches(
  unmatchedTxns: UnmatchedBankTxn[],
  candidateVouchers: Map<string, CandidateVoucher[]>
): Promise<AIMatchSuggestion[]> {
  const prompt = unmatchedTxns.map(txn => {
    const candidates = candidateVouchers.get(txn.id) ?? [];
    return `BANK TXN [${txn.id}]:
  Date: ${txn.txn_date} | ${txn.debit ? 'DEBIT' : 'CREDIT'}: ₹${txn.debit ?? txn.credit}
  Narration: ${txn.narration}
  Ref: ${txn.reference ?? 'none'}

  CANDIDATES:
  ${candidates.length === 0 ? '(none)' : candidates.map(v =>
    `  [${v.voucher_id}] ${v.voucher_date} | ₹${v.amount} | ${v.party_name} | ${v.narration}`
  ).join('\n')}`;
  }).join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You match Indian bank transactions to accounting vouchers. Consider: amount similarity, date proximity, counterparty name matching, UPI/NEFT reference matching. Return ONLY a JSON array.`,
    messages: [{
      role: 'user',
      content: `Match each bank transaction to its best voucher candidate (or null if no good match).

${prompt}

Return JSON array:
[{ "bank_txn_id": "...", "voucher_id": "matched ID or null", "confidence": 50-69, "reason": "..." }]`
    }]
  });

  // Parse response...
}
```

### 4.2 Match Engine Orchestration

```typescript
// /lib/bank-recon/match-engine.ts

export async function runMatchEngine(
  statementId: string,
  companyId: string,
  supabase: SupabaseClient
): Promise<MatchEngineResult> {

  // 1. Load all unmatched transactions for this statement
  const { data: txns } = await supabase
    .from('recon_transactions')
    .select('*')
    .eq('statement_id', statementId)
    .eq('match_status', 'unmatched');

  if (!txns?.length) return { matched: 0, unmatched: 0, queries: 0 };

  // 2. Get the bank account's ledger_id
  const { data: stmt } = await supabase
    .from('recon_statements')
    .select('bank_account_id, recon_bank_accounts(ledger_id)')
    .eq('id', statementId)
    .single();

  const ledgerId = stmt?.recon_bank_accounts?.ledger_id;
  if (!ledgerId) throw new Error('Bank account not linked to a ledger');

  // 3. Tier 1: Exact match (SQL)
  const exactMatches = await runExactMatch(statementId, ledgerId, companyId, supabase);

  // 4. Tier 2: Fuzzy match (SQL + scoring)
  const fuzzyMatches = await runFuzzyMatch(statementId, ledgerId, companyId, supabase);

  // 5. Tier 3: AI match (only for remaining unmatched, if any)
  const remainingUnmatched = await supabase
    .from('recon_transactions')
    .select('*')
    .eq('statement_id', statementId)
    .eq('match_status', 'unmatched');

  let aiMatches: MatchResult[] = [];
  if (remainingUnmatched.data?.length) {
    aiMatches = await runAIMatch(remainingUnmatched.data, ledgerId, companyId, supabase);
  }

  // 6. Insert all matches
  const allMatches = [...exactMatches, ...fuzzyMatches, ...aiMatches];
  if (allMatches.length > 0) {
    await supabase.from('recon_matches').insert(allMatches);

    // Update transaction match_status
    const autoIds = allMatches.filter(m => m.match_confidence >= 95).map(m => m.bank_txn_id);
    if (autoIds.length) {
      await supabase.from('recon_transactions')
        .update({ match_status: 'auto_matched' })
        .in('id', autoIds);
    }
    // Fuzzy and AI matches stay 'unmatched' until user confirms
  }

  // 7. Create queries for truly unmatched items
  const stillUnmatched = await supabase
    .from('recon_transactions')
    .select('id')
    .eq('statement_id', statementId)
    .eq('match_status', 'unmatched');

  if (stillUnmatched.data?.length) {
    const queries = stillUnmatched.data.map(txn => ({
      company_id: companyId,
      bank_txn_id: txn.id,
      query_type: 'bank_orphan',
      status: 'open',
    }));
    await supabase.from('recon_queries').insert(queries);
  }

  // 8. Update statement status
  await supabase.from('recon_statements')
    .update({ upload_status: 'matched' })
    .eq('id', statementId);

  return {
    matched: allMatches.length,
    unmatched: stillUnmatched.data?.length ?? 0,
    queries: stillUnmatched.data?.length ?? 0,
  };
}
```

### 4.3 CRITICAL — No UUID Aggregation

**NEVER use `MIN(id)`, `MAX(id)`, or any aggregate function on a `uuid` column.** Postgres does not support `min`/`max` on `uuid` type. This was the root cause of the old module's crash (error 42883).

If you need "the first matching row," use:

```sql
SELECT id FROM table WHERE ... ORDER BY created_at LIMIT 1
```

---

## 5. API ROUTES

### 5.1 `POST /api/bank-recon/upload`

**The main entry point.** Accepts a file upload (multipart/form-data) or a JSON body with base64 file content.

Request body (JSON variant):

```typescript
{
  company_id: string;       // UUID
  file_base64: string;      // base64-encoded file content
  file_name: string;        // original file name
  file_type: string;        // MIME type or extension
  // Optional manual overrides (auto-detected if omitted):
  bank_code?: string;
  period_from?: string;     // YYYY-MM-DD
  period_to?: string;
}
```

**Processing sequence:**

1. Decode file.
2. Compute SHA-256 hash. Check for exact duplicate upload (same `file_hash` for this company). If duplicate → return error with the existing statement ID.
3. Run the full pre-converter pipeline (§3).
4. If bank not auto-detected → return `{ status: 'needs_bank_selection', candidates: [...] }`.
5. If overlap detected → return `{ status: 'overlap_detected', overlap: {...}, options: ['skip_duplicates', 'replace', 'merge'] }`.
6. If validation fails (balance discontinuity) → return `{ status: 'validation_warning', validation: {...} }` but **allow the user to proceed anyway** (some bank statements genuinely have rounding errors).
7. Look up or create `recon_bank_accounts` row for this bank + account number + company.
8. Insert `recon_statements` row.
9. Batch insert all `recon_transactions` rows.
10. If a `recon_format_profiles` row doesn't exist for this format signature → create one.
11. Run narration parsing (heuristic, then AI for unknowns).
12. Update `recon_transactions` with parsed narration fields.
13. Trigger match engine asynchronously (or synchronously if < 500 txns).
14. Return `{ status: 'success', statement_id, summary: { txn_count, debits, credits, opening, closing, matched, unmatched } }`.

Response:

```typescript
{
  status: 'success' | 'needs_bank_selection' | 'overlap_detected' | 'validation_warning' | 'error';
  statement_id?: string;
  summary?: {
    bank: { code: string; name: string; confidence: number };
    account_number: string | null;
    period_from: string;
    period_to: string;
    txn_count: number;
    debit_count: number;
    credit_count: number;
    total_debits: number;
    total_credits: number;
    opening_balance: number;
    closing_balance: number;
  };
  match_result?: {
    exact_matches: number;
    fuzzy_matches: number;
    ai_matches: number;
    unmatched: number;
  };
  validation?: ValidationResult;
  overlap?: OverlapInfo;
  error?: string;
}
```

### 5.2 `POST /api/bank-recon/match`

Re-run the match engine on an existing statement (after new vouchers have been posted).

```typescript
// Request
{ statement_id: string; company_id: string }

// Response
{ matched: number; unmatched: number; new_matches: number }
```

### 5.3 `POST /api/bank-recon/confirm-match`

User confirms or rejects a suggested match.

```typescript
// Request
{
  match_id: string;
  action: 'confirm' | 'reject';
  // If rejecting, optionally provide correct voucher:
  correct_voucher_id?: string;
}
```

On confirm → set `is_confirmed = true`, update transaction `match_status = 'manual_matched'`.
On reject → delete the match, reset transaction to `'unmatched'`. If `correct_voucher_id` provided → create a new confirmed match.

### 5.4 `GET /api/bank-recon/brs`

Generate a Bank Reconciliation Statement as at a given date.

```typescript
// Query params
?company_id=...&bank_account_id=...&as_at_date=YYYY-MM-DD

// Response: BRS computation
{
  as_at_date: string;
  balance_per_books: number;        // from ledger
  balance_per_bank: number;         // from statement
  // Reconciling items:
  cheques_issued_not_presented: ReconItem[];   // book debits not in bank
  cheques_deposited_not_cleared: ReconItem[];  // book credits not in bank
  bank_credits_not_in_books: ReconItem[];      // bank credits, no voucher
  bank_debits_not_in_books: ReconItem[];       // bank charges etc., no voucher
  adjusted_book_balance: number;
  adjusted_bank_balance: number;    // these two must match
  is_reconciled: boolean;
  difference: number;               // should be 0 if reconciled
}
```

### 5.5 `GET /api/bank-recon/statements/[id]`

Return statement detail with all transactions and their match status.

### 5.6 `DELETE /api/bank-recon/statements/[id]`

Delete a statement and all its transactions, matches, and queries (CASCADE). Require confirmation.

---

## 6. UI COMPONENTS

### 6.1 Tab Structure

Replace the existing tabs with:

| Tab | Purpose |
|-----|---------|
| **Upload** | File upload + auto-detect + progress + validation |
| **Statements** | List of uploaded statements with status badges |
| **Match Workbench** | Review suggested matches, confirm/reject, manual match |
| **Queries** | Unresolved reconciling items |
| **BRS Report** | Bank Reconciliation Statement generator |

### 6.2 Upload Panel (`upload-panel.tsx`)

- Drag-and-drop zone + "Upload file" button + "Paste CSV" toggle (existing pattern).
- **No bank dropdown.** Instead, after upload, show: "Detected: Federal Bank (95% confidence)" with a "Change" link that reveals a dropdown only if needed.
- **No period inputs.** Auto-detect from the data. Show detected period for confirmation.
- Progress indicator with steps: Uploading → Detecting bank → Parsing → Validating → Matching → Done.
- If validation warns (balance discontinuity) → show warning with "Proceed anyway" button.
- If overlap detected → show options: "Skip duplicate transactions" / "Replace existing statement" / "Cancel".
- After success → show summary card: bank, period, txn count, matched count, unmatched count.

### 6.3 Match Workbench (`match-workbench.tsx`)

- Left panel: list of bank transactions, filterable by match status.
- Right panel: matched voucher detail (or candidate suggestions for unmatched).
- For auto-matched (≥95%): show with green badge, allow bulk confirm.
- For fuzzy/AI matches (50–94%): show with amber badge, require individual confirm/reject.
- For unmatched: show "Suggest" button → calls AI match → shows candidates.
- Manual match: search vouchers by date range + amount range + party name.
- Colour coding:
  - Green: confirmed match
  - Amber: suggested match (awaiting review)
  - Red: unmatched
  - Grey: written off

### 6.4 BRS Report (`brs-report.tsx`)

- Date picker for "as at" date.
- Bank account selector (auto-populated from `recon_bank_accounts`).
- Renders the standard BRS format:

```
Balance as per Bank Statement                     ₹ XX,XX,XXX.XX

Add: Cheques deposited but not yet cleared
  [date] [narration] [amount]                     ₹ X,XX,XXX.XX
                                          Total   ₹ X,XX,XXX.XX

Less: Cheques issued but not yet presented
  [date] [narration] [amount]                     ₹ X,XX,XXX.XX
                                          Total   ₹ X,XX,XXX.XX

Add/Less: Other reconciling items
  [date] [narration] [amount]                     ₹ X,XX,XXX.XX

Adjusted Bank Balance                             ₹ XX,XX,XXX.XX
Balance as per Books                              ₹ XX,XX,XXX.XX
Difference                                        ₹         0.00
```

- Export to PDF button.
- Export to Excel button.

---

## 7. NARRATION INTELLIGENCE — BANK-SPECIFIC PATTERNS

This section documents the actual narration formats observed in Relish Group bank statements. Use these for the heuristic parser.

### 7.1 HDFC Bank

```
UPI-A1 TRAVELS AND SPEED-A1TSPS007@HDFCBANK-HDFC0MERUPI-120891112574-TRANSPORT CHARGES
UPI-SANGEETHA  STALIN-SANGEETHAVINO1@OKSBI-SBIN0003106-645703055675-VCH 207
NEFT CR-YESB00012345-COMPANY NAME-REF123456
POS 514834XXXXXX1234 AMAZON         POS DEBIT
RTGS CR-HDFC0001234-COMPANY-20260401REF
ATM-CASH WDL-BR 0682-01/04/2026
```

Pattern: `UPI-<counterparty>-<upi_id>-<ifsc>-<reference>-<purpose>`

### 7.2 Canara Bank

```
IB-IMPS-DR//ICIC/**6231//07/10/2024 09:47:00/428109802020
IB-IMPS-DR//IPOS/**8205//07/10/2024 17:57:52/428117955803
ATM Cash-VA099602-BROTHERSTOURISTHOMEALLEPPEYKEIN-03/10/24 22:20:27/3726
MOB-IMPS-CR/MOTTY PHIL/ICICI Bank/060601506230/Salary Pay/9446012324/20/03/2025
RTGS Cr-HDFCR52024100197875932-HDFC0000240-PENINSULAR FISHERIES PRIVATE LIMITE--//C90912011024130248
ATM / IMPS Transaction Charges
GST108031024228-209272804
```

Note: Excel-quoted (`="value"`), Indian number format (`1,42,729.92`).

### 7.3 Federal Bank

```
FN IMPS/IFO/621217694475/SBIN0008622/VCH-2026-27-0
FN IMPS/IFO/610816870577/SBIN0008622/QP/VCH 248
FT IMPS/IFI/610816327367/RELISHFOODSPVTLTD/IMPS
UPIOUT/620816019469/sangeethavino1@oksbi/Fed/0000
CHRG/IMPS/360/18-04-2026
```

Note: Reverse chronological order. `Sl. No.` column present. Empty column between Particulars and Value Date. `Tran Type` column (`IB`, `UPI`, `TFR`, `IMPS`).

---

## 8. TESTING REQUIREMENTS

### 8.1 Test Files Available

Use the actual bank statements from the Relish Group for integration testing:

1. **HDFC** — `Acct_Statement_XXXXXXXX1702_02082026.xlsx` (RHHF, Apr–Aug 2026, 766 txns)
2. **Federal** — `Fed_Statement_April_to_July.csv` (RFPL, Apr–Jul 2026, 282 txns, reverse-sorted)
3. **Canara** — pasted CSV format with Excel quoting (RFPL, various periods)

### 8.2 Unit Tests Required

Every function in `/lib/bank-recon/` must have unit tests. At minimum:

- `stripExcelQuoting`: test `="value"`, `="123"`, plain values, null, undefined
- `parseIndianNumber`: test `1,42,729.92`, `142729.92`, `853.00`, `""`, null, `"0"`
- `normaliseDate`: test all six formats listed in §3.4.3, with edge cases (year 2000, year 1999, Feb 29)
- `detectSortOrder`: test ascending, descending, single-day, two-row
- `deriveOpeningBalance`: test credit-first, debit-first, zero-balance start
- `validateBalanceContinuity`: test valid sequence, single discontinuity, floating-point edge cases
- `parseNarration`: test every pattern in §7 plus unknown narrations

### 8.3 Integration Tests

- Upload the HDFC XLSX → verify auto-detect → verify 766 transactions parsed → verify balance check passes.
- Upload the Federal CSV → verify auto-detect → verify reverse sort detected and corrected → verify opening balance derived as 0 → verify balance check passes.
- Upload a Canara pasted CSV → verify Excel quoting stripped → verify Indian numbers parsed → verify balance check.
- Upload the same file twice → verify duplicate detected by `file_hash`.
- Upload overlapping periods → verify overlap detected and options offered.

### 8.4 Edge Cases to Handle

- File with BOM (byte order mark) at start.
- CSV with mixed line endings (`\r\n`, `\n`, `\r`).
- XLSX where the first 15+ rows are bank letterhead/address before headers.
- Transactions on the same date with same amount but different narrations (not duplicates).
- Value date in a different month from transaction date.
- Negative balance (overdraft accounts).
- Zero-amount rows (some banks include opening balance as a zero-amount row).
- Narration containing commas (in CSV — must be properly quoted).
- Amount columns with trailing spaces or currency symbols (`₹`, `INR`).

---

## 9. ENVIRONMENT VARIABLES

Add to Vercel project settings:

```
ANTHROPIC_API_KEY=sk-ant-...     # For Claude Sonnet 4.6 API calls
```

The Supabase keys (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) are already configured.

---

## 10. MIGRATION SEQUENCE

1. Create all new `recon_*` tables (§1) via Supabase migration.
2. Build the pre-converter pipeline (§3) with all transform functions and tests.
3. Build the upload API route (§5.1) — this is the critical path.
4. Build the Upload UI tab (§6.2) — replace the existing upload panel.
5. Build the match engine (§4) — start with Tier 1 only.
6. Build the Match Workbench UI (§6.3).
7. Add Tier 2 fuzzy matching.
8. Add Tier 3 AI matching.
9. Build narration parsing (heuristic, then AI).
10. Build the BRS Report (§6.4).
11. Build the Queries tab (§6.5 — disputes/orphans).
12. Migrate any salvageable data from old `bank_*` tables to new `recon_*` tables.
13. Verify end-to-end with all three test files (HDFC, Federal, Canara).
14. Remove old `bank_*` tables and old `/api/bank-upload`, `/api/bank-match` routes.
15. Remove old UI components.

---

## 11. NON-NEGOTIABLE RULES

1. **Never aggregate on UUID columns.** No `MIN(id)`, `MAX(id)`, `COUNT(DISTINCT id)` without explicit cast. Use `ORDER BY ... LIMIT 1` instead.
2. **Always filter vouchers on `status = 'posted'`.** Never match against draft, approved, or cancelled vouchers.
3. **All amounts are `numeric(15,2)`.** Never use `float` or `double precision` for money. Use `Math.round(x * 100) / 100` in TypeScript before any comparison.
4. **Dates are DD/MM in India.** Never interpret a date as MM/DD. All Indian bank statements use DD/MM format.
5. **RLS on every table.** No exceptions. Company-scoped.
6. **Anthropic API calls are server-side only.** Never expose the API key or call Claude from client components.
7. **Never auto-reject on overlap.** Always offer the user a choice: skip duplicates, replace, or merge.
8. **Balance validation warnings are advisory, not blocking.** Some bank statements have legitimate rounding discrepancies of ₹0.01–₹1.00. Allow the user to proceed with a warning.
9. **The pre-converter must be pure and testable.** No database calls inside transform functions. Database operations happen before (to load data) and after (to store results), never during the pipeline.
10. **Every AI call must have a deterministic fallback.** If the Anthropic API is down or returns garbage, the system must still work — it just won't have AI-enhanced narration parsing or Tier 3 matching. Upload and Tier 1/2 matching must work without any AI.

---

## 12. SUCCESS CRITERIA

The module is complete when:

1. A user can upload any CSV or XLSX from HDFC, Canara, Federal, or South Indian Bank **without selecting the bank or entering the period** — the system detects both automatically.
2. The Federal Bank reverse-sorted CSV parses correctly with the right opening balance.
3. The Canara Bank Excel-quoted, Indian-number-format CSV parses correctly.
4. The HDFC XLSX with 15+ header rows parses correctly.
5. Exact matches (same amount + same date) auto-reconcile without user intervention.
6. Fuzzy and AI matches appear in the workbench for review.
7. A BRS report can be generated as at any date and the adjusted balances agree.
8. Re-uploading the same file is rejected as a duplicate.
9. Overlapping periods offer merge/replace options instead of a 409 error.
10. The system works even if the Anthropic API is unavailable (graceful degradation).
