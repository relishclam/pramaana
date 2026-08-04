# PRAMAANA — Autonomous Bank Reconciliation Module
## Complete Implementation Review — 2026-08-04

---

## Status: **Backend Layer Complete · Zero TypeScript Errors · Pending: UI Integration & Testing**

---

## 1. What Was Built

### 1.1 Database Migration
**File:** `supabase/migrations/072_recon_tables.sql` *(363 lines)*

Six new tables, all idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`):

| Table | Purpose | Key Constraints |
|---|---|---|
| `recon_bank_accounts` | Bank account registry, auto-provisioned on first upload | `UNIQUE(company_id, bank_code, account_number)` |
| `recon_format_profiles` | Learned format cache (eliminates repeat AI calls) | `UNIQUE(bank_code, format_signature)` |
| `recon_statements` | One row per uploaded file | `pending_overlap` status, `file_hash` index, `no_inverted_period` CHECK |
| `recon_transactions` | Canonical parsed transactions | `exactly_one_side` CHECK (debit XOR credit), `balance NOT NULL` |
| `recon_matches` | Bank txn ↔ voucher links | `UNIQUE(bank_txn_id)` — one txn → at most one voucher |
| `recon_queries` | Orphans, disputes, mismatches | 5 `query_type` values, 5 `status` values |

**Other schema work:**
- `recon_transactions.match_status` CHECK constraint includes `'pending_review'` from the initial CREATE (not a later ALTER) — full set: `unmatched`, `pending_review`, `auto_matched`, `manual_matched`, `disputed`, `written_off`
- `pramaana.recon_set_updated_at()` trigger function + `BEFORE UPDATE` triggers on `recon_bank_accounts`, `recon_statements`, `recon_queries`
- `bank-recon-raw` Supabase Storage bucket (20 MB limit, service_role only — raw files are internal artifacts, not user-facing)
- RLS on every table, company-scoped via `registry.company_users`
- `recon_format_profiles` is shared/global: authenticated users can read, service_role writes (format profile upserts use service_role client in upload API)

---

### 1.2 Library Layer — `src/lib/bank-recon/`
**16 files, zero TypeScript errors**

#### Core Pipeline

| File | Responsibility |
|---|---|
| `types.ts` | All TypeScript interfaces. `ParsedNarration` fields are required-nullable (not optional). `MatchResult` has `matched_by?`. `UploadResponse.match_result` includes `queries_created`. |
| `constants.ts` | `BANK_SIGNATURES` for HDFC, Canara, Federal, SIB, ICICI. `GLOBAL_SKIP_PATTERNS` (regex array). |
| `pre-converter.ts` | 10-stage pure pipeline. Zero DB calls. Returns `PreConvertResult`. Caller handles overlap check and DB writes. Sanitises Excel scientific notation on account numbers (`1.01502E+13 → 10150200014513`). |
| `bank-detect.ts` | 4-pass heuristic: metadata patterns → header fuzzy-match → narration markers → filename. Exports `findHeaderRow` (statically imported — no dynamic import). Handles scientific notation at source. |
| `format-detect.ts` | Maps raw columns to canonical `ColumnMapping`. Skips empty-header columns (Federal Bank fix — empty col between Particulars and Value Date shifts indices). |
| `balance-validator.ts` | `deriveOpeningBalance`, `validateBalanceContinuity` (advisory, not blocking), `detectSortOrder` (ISO YYYY-MM-DD lexicographic comparison, mid-row fallback for same-day statements). |

#### Parsers

| File | Responsibility |
|---|---|
| `csv-parser.ts` | Multi-line delimiter detection (10-line sample, majority vote — prevents false-positive from single-comma metadata header). No phantom trailing cell. `looksLikeCSV` has 4-byte length guard. BOM stripped in `decodeText`; `parseCSV` strips only as safety net. |
| `xlsx-parser.ts` | SheetJS. `raw: false` for string output. 50,000-row safety limit. Comment documenting Excel serial-number date edge case. |
| `date-utils.ts` | `normaliseDate` handles 7 Indian bank date formats. Always DD/MM, never MM/DD. Two-digit year: 00–49 → 2000–2049, 50–99 → 1950–1999. |
| `number-utils.ts` | `parseAmount` handles Indian format (`1,42,729.92`), Excel-quoted values (`="853.00"`), currency symbols (`₹`, `INR`), trailing spaces. `roundMoney` for float safety. |
| `narration-parser.ts` | 20+ heuristic patterns covering HDFC UPI (backtracking-safe), Federal FN/FT IMPS, Canara IMPS/RTGS/ATM, POS, CHARGE, INTEREST, CHEQUE, SALARY, SWEEP, FD. `is_reversal` uses word-boundary regex (`\b(reversal|reversed|RETURN(?:ED)?)\b`). `OTHER` fallback return is fully populated (all nullable fields set to `null`). |

#### AI Layer *(server-side only — never imported in client components)*

| File | Responsibility |
|---|---|
| `ai-format-detect.ts` | Claude Sonnet 4.6 fallback when heuristic confidence < 70%. Returns `null` on API failure (graceful degradation). Successful detections are written back to `recon_format_profiles` by the caller. |
| `ai-narration-parse.ts` | Batches of 50 narrations. Called only for `txn_type = 'OTHER'` narrations. `is_charge`/`is_reversal` described as conditional in prompt (not hardcoded `false`). |
| `ai-match-suggest.ts` | Tier 3 matching. Returns `[]` on failure. Sends `party_name` (from entity join) to Claude for counterparty matching. |

**`getClient()` pattern across all 3 AI files:**
```typescript
const proc = (globalThis as Record<string, unknown>)['process'] as
  { env?: Record<string, string | undefined> } | undefined
const key = proc?.env?.['ANTHROPIC_API_KEY'] ?? ''
```
Avoids TS7053 without requiring `@types/node` in the Vite browser tsconfig.

#### Match Engine
**File:** `src/lib/bank-recon/match-engine.ts` *(407 lines)*

Three-tier cascade using raw PostgREST REST calls (Edge/Node-compatible, no Supabase SDK required):

```
Tier 1 — Exact:  same date + exact amount            → confidence 95–100 → auto_matched
Tier 2 — Fuzzy:  exact amount + ±3 days              → confidence 70–94  → pending_review
Tier 3 — AI:     amount ±10% + ±7 days → Claude      → confidence 50–69  → pending_review
```

**Key correctness guarantees:**
- Each tier commits `match_status` update **before** the next tier runs — prevents `UNIQUE(bank_txn_id)` violations on `recon_matches`
- Immutable set-based filtering (`matchedTxnIds: Set<string>`) — no `Array.splice()`, no O(n²) mutation
- PostgREST join flattened explicitly — `ve.vouchers.voucher_date` mapped to flat `VoucherEntry`; zero `(ve as unknown as {...})` casts in final code
- `party_name` populated via `entities:entity_id(display_name)` join in the voucher query
- `existingMatches` query scoped to candidate VE IDs only (not a full-company table scan)
- Tier 3 wrapped in `try/catch` — if Anthropic is down, upload/parse/Tier 1/Tier 2 all still work
- AI hallucinated UUIDs rejected by `voucherEntries.find(v => v.voucher_id === sug.voucher_id)` guard
- `refMatch` requires minimum 6 chars to prevent false positives on short numeric fragments

---

### 1.3 API Routes — `api/`
Seven Vercel serverless functions:

| File | Method | Purpose |
|---|---|---|
| `bank-recon-upload.ts` | POST | Main entry point. Two-round-trip overlap flow: first POST stores raw file to Supabase Storage + returns `{status: 'overlap_detected'}`; second POST re-parses from stored file and commits. |
| `bank-recon-match.ts` | POST | Re-run match engine on existing statement (after new vouchers are posted) |
| `bank-recon-confirm.ts` | POST | Confirm (`manual_matched`) or reject a suggested match |
| `bank-recon-brs.ts` | GET | Generate Bank Reconciliation Statement as at a given date |
| `bank-recon-accounts.ts` | GET/POST | List and create `recon_bank_accounts` |
| `bank-recon-statements.ts` | GET/DELETE | Statement detail and deletion (CASCADE removes txns, matches, queries) |
| `bank-recon-queries.ts` | GET/PATCH | List and resolve recon queries |

---

### 1.4 UI
**Files:** `src/pages/BankReconPage.tsx`, `src/pages/BankRecon.module.css`

Five-tab layout matching the spec:

| Tab | Description |
|---|---|
| **Upload** | Drag-drop zone + paste CSV. Bank auto-detect display ("Detected: Federal Bank 95%") with "Change" override. Progress steps (Uploading → Detecting → Parsing → Validating → Matching → Done). Validation warning + "Proceed anyway". Overlap options (skip duplicates / replace / merge). **Note: merge option is wired in the API (`overlap_resolution: 'merge'`) but the UI currently renders skip/replace/cancel — exposing the merge option is in §4.** |
| **Statements** | List of uploaded statements with status badges (`processing`, `pending_overlap`, `parsed`, `matched`, `error`) |
| **Match Workbench** | Left/right split panel. Green (confirmed), amber (pending_review), red (unmatched). Bulk confirm for auto-matched. Individual confirm/reject for Tier 2/3. |
| **Queries** | Unresolved orphans and disputes with resolution workflow |
| **BRS Report** | Standard BRS format. As-at date picker. Bank account selector. Export to PDF/Excel buttons present in UI. **Library not yet wired — see §4.** |

---

### 1.5 Collateral Fix — `src/lib/pay-now.ts`

Fixed during review session (not part of the recon module but will integrate with it):

- `markVoucherPaid` — `{ count: 'exact' }` guard; throws `'Voucher is not in a payable state'` on zero rows updated. Added `// TODO: auto-populate from recon_matches` comment — the integration point where a confirmed Tier 1 match auto-fills `paid_at` (from `txn_date`), `utr_number` (from `parsed_reference`), and `paid_from_account` (from `recon_bank_accounts`).
- `queueForPayment` and `dequeuePayment` — same row-count guard pattern
- `updateVoucherPaymentMode` — added `.in('status', ['completed', 'awaiting_payment'])` to prevent updating posted vouchers
- `deleteCompanyPaymentAccount` — soft-delete (`is_active = false`) instead of hard delete; preserves referential integrity with historical vouchers
- `RawRow.queued_at` — typed properly; removed `(r as unknown as {...})` cast

---

## 2. Bugs Fixed vs. Old Module

| Old Bug | Fix |
|---|---|
| `MIN(uuid)` → Postgres error 42883 | Never used anywhere — `ORDER BY created_at LIMIT 1` pattern throughout |
| Opening balance always 0 if no explicit opening row | `deriveOpeningBalance(firstTxn)` derives from `firstTxn.balance - credit + debit` |
| No sort-order detection (Federal reverse-chronological CSV) | `detectSortOrder()` + `[...rawTransactions].reverse()` (non-mutating) |
| Rigid per-bank column config requiring manual DB inserts | Heuristic detection → `recon_format_profiles` cache → AI fallback |
| 409 error on overlapping period upload | Two-round-trip flow with `skip_duplicates / replace / merge` user options |

---

## 3. Non-Negotiable Rules — Compliance

| Rule | Status |
|---|---|
| Never aggregate on UUID columns | ✅ Zero `MIN(id)` / `MAX(id)` calls |
| Always filter vouchers on `status = 'posted'` | ✅ All match queries use `v.status = 'posted'` |
| Amounts as `numeric(15,2)` / `Math.round(x*100)/100` | ✅ `roundMoney()` at every arithmetic boundary |
| Dates always DD/MM, never MM/DD | ✅ `normaliseDate()` hardcoded DD/MM for all 7 formats |
| RLS on every table | ✅ Company-scoped on 5 tables; global read on `recon_format_profiles` |
| Anthropic API server-side only | ✅ All 3 AI files have `// Server-side ONLY` comment; never imported in components |
| Never auto-reject on overlap | ✅ Returns `overlap_detected` status with options |
| Balance validation advisory, not blocking | ✅ `is_valid: false` never prevents commit; UI shows "Proceed anyway" |
| Pre-converter pure (zero DB calls) | ✅ All DB access is before (load profiles) and after (insert) the pipeline |
| Every AI call has deterministic fallback | ✅ All 3 AI functions return `null`/`[]` on failure; Tier 3 wrapped in try/catch |

---

## 4. What Remains

### Immediate (unblock everything else)
1. **Run migration** `072_recon_tables.sql` against `mmkbknnzgpvsqgnynrbe` Supabase project
2. **Link bank accounts to ledgers** — after auto-provisioning, `recon_bank_accounts.ledger_id` is `NULL`. The match engine throws `'Bank account not linked to a ledger'` if this is not set. Either auto-match against `pramaana.ledgers` where `is_bank_account = true` and name/account number align, or add a one-time manual linking step in the Bank Accounts UI tab. This must be done before any match engine run.

### Unit Tests (run before integration tests — pure functions are the foundation)
3. `stripExcelQuoting`, `parseIndianNumber`, `normaliseDate`, `detectSortOrder`
4. `deriveOpeningBalance`, `validateBalanceContinuity`
5. `parseNarration` (all 20+ patterns + unknown narrations)
6. `parseCSVLine` (trailing delimiter, empty line, quoted commas, BOM)
7. `looksLikeCSV` (XLSX magic bytes, XLS magic bytes, short content)

### Integration Tests (per spec §8)
8. Upload **HDFC XLSX** (`Acct_Statement_XXXXXXXX1702_02082026.xlsx`) — verify 766 txns, 15+ header rows skipped, balance check passes
9. Upload **Federal CSV** (`Fed_Statement_April_to_July.csv`) — verify 282 txns, reverse sort detected and corrected, opening balance derived correctly
10. Upload **Canara CSV** — verify Excel quoting stripped, Indian numbers parsed, balance check passes
11. Upload same file twice — verify `file_hash` duplicate rejection
12. Upload overlapping period — verify overlap options offered (not 409)

### Remaining Module Work
13. **BRS report export** — wire up PDF/Excel export. Pramaana already has `exportVoucherCsv.ts` and `tally-export.ts` patterns; check if `reportCsv.ts` can be reused for Excel. PDF likely needs `jsPDF` or a server-side render route.
14. **Overlap UI: expose merge option** — API accepts `overlap_resolution: 'merge'` but UI shows cancel instead of merge. Add the third button.
15. BRS report — verify adjusted balances agree to zero difference
16. Confirm match flow — end-to-end from Workbench UI to `is_confirmed = true` in DB
17. Queries tab — dispute and resolution workflow
18. Migrate salvageable data from old `bank_statements` / `bank_transactions` tables
19. Remove old `bank_*` tables and routes after verified end-to-end
20. Remove old UI components (old BankReconPage tabs)

### Future Enhancements
- **Auto-populate payment fields from confirmed matches** — when a Tier 1 match is confirmed on a payment voucher, call `markVoucherPaid` with `paid_at` from `txn_date`, `utr_number` from `parsed_reference`, and `paid_from_account` from `recon_bank_accounts`. The `// TODO: auto-populate from recon_matches` comment in `pay-now.ts` marks the integration point. This is the payoff of the narration parser — all extracted references become usable in the payment workflow.

---

## 5. File Inventory

### Database
```
supabase/migrations/072_recon_tables.sql          363 lines
```

### Library (`src/lib/bank-recon/`)
```
types.ts              — all interfaces and type definitions
constants.ts          — BANK_SIGNATURES, GLOBAL_SKIP_PATTERNS
pre-converter.ts      — 10-stage pipeline orchestrator      (319 lines)
bank-detect.ts        — heuristic bank identification
format-detect.ts      — column mapping + format signature
balance-validator.ts  — opening balance + continuity check
csv-parser.ts         — CSV/TSV parsing with edge cases
xlsx-parser.ts        — SheetJS XLSX extraction
date-utils.ts         — multi-format Indian date normalisation
number-utils.ts       — Indian number format + Excel quoting
narration-parser.ts   — 20+ heuristic narration patterns
match-engine.ts       — 3-tier match cascade               (407 lines)
ai-format-detect.ts   — Claude: bank/column detection fallback
ai-narration-parse.ts — Claude: narration enrichment (batches of 50)
ai-match-suggest.ts   — Claude: Tier 3 match suggestions
index.ts              — barrel exports
```

### API (`api/`)
```
bank-recon-upload.ts      — POST: full upload pipeline
bank-recon-match.ts       — POST: re-run match engine
bank-recon-confirm.ts     — POST: confirm/reject match
bank-recon-brs.ts         — GET: BRS report
bank-recon-accounts.ts    — GET/POST: bank accounts
bank-recon-statements.ts  — GET/DELETE: statement detail
bank-recon-queries.ts     — GET/PATCH: recon queries
```

### UI (`src/pages/`)
```
BankReconPage.tsx
BankRecon.module.css
```
