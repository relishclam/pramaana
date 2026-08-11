# Bank Reconciliation — Codebase Assessment

---

## 1. Bank Statement Data Extraction

**Entry point:** `api/lib/bank-recon/pre-converter.ts` — a pure pipeline (zero DB calls inside transform functions).

The pipeline runs in 9 stages:

### Stage 1–2: File Type Detection & Raw Extraction
- Detects CSV vs XLSX by inspecting raw bytes (`looksLikeCSV()`).
- CSV is decoded with charset detection; XLSX is parsed via `xlsx-parser.ts`.
- Completely blank trailing rows are stripped.

### Stage 3–4: Header Row & Bank Detection (`bank-detect.ts`)
Runs 4 passes in priority order:

| Pass | Method | Confidence |
|---|---|---|
| 1 | Metadata scan — rows 0–20 for bank name, account number, IFSC (regex) | 95 |
| 2 | Header row fuzzy scoring against known `BANK_SIGNATURES` | up to 100 |
| 3 | Narration marker scan — first 50 data rows for bank-specific prefixes (e.g. `UPIOUT/`, `FT IMPS/`) | 80 |
| 4 | Filename check — bank name or code in filename | 50 |

**Supported banks:**

| Bank | Company | Special Handling |
|---|---|---|
| HDFC | RHHF | XLSX, `DD/MM/YY`, 15+ decorative letterhead rows before headers |
| Federal | RFPL | Reverse-sorted CSV, `Sl. No.` col, empty column shift between Particulars and Value Date |
| Canara | RFPL | Excel-quoted values (`="value"`), Indian number format (`1,42,729.92`) |
| SIB | RHHF | Standard |
| Airwallex / HSBC | RFPL | TBD |

### Stage 5: Column Mapping (`format-detect.ts` + profile cache)
- First checks `recon_format_profiles` cache by key `(bank_code : header_hash)`.
- Cache miss + bank confidence ≥ 70 → heuristic `detectColumns()`.
- Confidence < 70 or heuristics fail → AI fallback via `aiDetectFormat()` (Claude Sonnet 4.6).
- Result is a `ColumnMapping` containing: indices for `date_col`, `narration_col`, `debit_col`, `credit_col`, `balance_col`, `amount_col`, `dr_cr_col`, `reference_col`, `value_date_col`, plus `date_format`, `number_format`, `excel_quoted`.
- Every successful parse writes back to `recon_format_profiles` — AI is never called again for an already-seen format.

### Stage 6: Data Clean & Canonical Extraction
- Strips Excel quoting, parses Indian number format, normalises dates to `YYYY-MM-DD`.
- Banks with a single Amount + Dr/Cr indicator column split into `debit` / `credit` (never both — enforced by the DB `CONSTRAINT exactly_one_side`).
- Output: `CanonicalTransaction[]` — `{ txn_date, narration, reference, debit|null, credit|null, balance }`.

### Stage 7: Sort Order Detection & Fix
- `detectSortOrder()` checks ascending vs descending by date.
- Reverse-sorted statements (Federal Bank) are reversed in-place and row numbers rewritten.

### Stage 8: Balance Derivation & Validation
- `deriveOpeningBalance()` infers opening balance from the first row's balance and amount.
- `validateBalanceContinuity()` walks every row — any discontinuity is reported as **advisory only, never blocking**.

### Stage 9: Duplicate Detection
- Groups transactions by `(txn_date + amount + narration)` key.
- Duplicates are flagged in the result but not removed; the upload API caller handles overlap resolution via a two-round-trip flow (skip / replace / merge).

---

## 2. Voucher Data Extraction

**Entry point:** `api/lib/bank-recon/match-engine.ts` — fetches from the DB at match time.

Two distinct fetch pools are built before matching begins:

### Pool A — Date-Windowed Candidates
```sql
SELECT ve.*, v.*
FROM voucher_entries ve
INNER JOIN vouchers v ON v.id = ve.voucher_id
WHERE ve.ledger_id = ?
  AND v.status = 'posted'
  AND v.company_id = ?
  AND v.voucher_date BETWEEN (min_txn_date - 7 days) AND (max_txn_date + 7 days)
```
Fields fetched per entry: `id`, `voucher_id`, `entry_type` (`'Dr'` or `'Cr'`), `amount`, `narration`, `voucher_number`, `voucher_date`, `voucher_narration`, `entity_id`.

`entity_id` is resolved in a second query to `registry.entities` to populate `party_name` — used only in Tier 3 AI context.

> **Critical constraint: `status = 'posted'`** — draft vouchers are never considered under any circumstances.

### Pool B — Unrestricted Reference Pool
```sql
SELECT ve.*, v.*
FROM voucher_entries ve
INNER JOIN vouchers v ON v.id = ve.voucher_id
WHERE ve.ledger_id = ?
  AND v.status = 'posted'
  AND v.company_id = ?
  -- no date filter
```
Also includes `utr_number` from vouchers. Used for Tier 1.2 narration-reference matching and Tier 0 UTR matching — because payee-typed voucher numbers in narrations may refer to vouchers far outside the date window.

### UTR Index (Tier 0)
A separate company-scoped query (not ledger-scoped) fetches all posted vouchers where `utr_number IS NOT NULL`. These are indexed as `utr_string → [VoucherEntry]`. The company-scope is intentional: Tally-migrated data may have the bank-side entry on a different ledger than the one registered in `recon_bank_accounts`.

---

## 3. How Bank Transactions & Vouchers Are Matched

The match engine is **strictly sequential** — each tier updates `match_status` in the DB and removes matched IDs from the candidate pool **before** the next tier runs. This prevents `UNIQUE(bank_txn_id)` constraint violations on `recon_matches`.

The side-polarity rule applies at every tier:
- **Bank debit (money out)** → must match a **`Cr`** voucher entry on the bank ledger
- **Bank credit (money in)** → must match a **`Dr`** voucher entry on the bank ledger

### Tier 0 — UTR Match
| Property | Value |
|---|---|
| Confidence | 100 |
| Status set | `auto_matched` |
| Requires user review | No |

- Extracts UTR candidates from `txn.parsed_reference`, `txn.reference`, and tokenises `txn.narration` (9–16 char alphanumeric tokens matching `[A-Z0-9]+`).
- Looks up each token in the UTR index.
- Matches when: token found AND `sum(ve.amount)` is within ₹1 of the bank transaction amount AND entry side is correct.
- Supports **batch matching** — one bank transaction can match multiple voucher entries sharing the same UTR (e.g. split payments).
- If UTR token is found but amounts don't match, logs a `UTR-REVIEW` warning — never silently skips.

### Tier 1 — Exact Match
| Property | Value |
|---|---|
| Confidence | 95 (no ref) or 100 (ref agrees) |
| Status set | `auto_matched` |
| Requires user review | No |

- `amount` exact to the paisa + `txn_date == voucher_date` + correct `entry_type`.
- Among multiple candidates, prefers the one whose narration also contains the voucher number or a reference match.

### Tier 1.2 — Narration Voucher-Reference Match
| Property | Value |
|---|---|
| Confidence | 97 (amounts agree) or 75 (split-ledger mismatch) |
| Status set | `auto_matched` (97) or `pending_review` (75) |
| Requires user review | Only at confidence 75 |

- Runs only on transactions not yet matched.
- Extracts voucher reference patterns from narration (e.g. `VCH-2025-26-00123`).
- Looks up by `voucher_number` suffix in the **unrestricted pool** — no date filter.
- If amounts agree: confidence 97, auto-confirmed.
- If single reference found but amounts differ (likely bank charge or split-ledger): confidence 75, flagged `pending_review`.

### Tier 2 — Fuzzy Date Match
| Property | Value |
|---|---|
| Confidence | 70–94 |
| Status set | `pending_review` |
| Requires user review | Yes |

- `amount` exact + date within **±3 days** + correct entry side.

### Tier 3 — AI Match (Claude Sonnet 4.6)
| Property | Value |
|---|---|
| Confidence | 50–69 |
| Status set | `pending_review` |
| Requires user review | Yes |

- Amount within **±10%** + date within **±7 days**.
- Sends unmatched transactions + their candidates to Claude with narration, date, amount, party name.
- Claude returns `[{ bank_txn_id, voucher_id, confidence, reason }]`.
- **Graceful degradation**: if `ANTHROPIC_API_KEY` is absent or the API is down, Tier 3 is silently skipped entirely. All earlier tiers continue unaffected — Tier 3 has zero dependency on AI for pipeline integrity.

---

## 4. What Happens When There Are No Matches

When a bank transaction survives all four tiers without a match, it becomes an **orphan**.

### Scenario A — No Voucher Candidates At All (empty pool)
When the `voucherEntries` pool is empty (no posted vouchers in the ledger at all):
- All unmatched transactions are immediately written to `recon_queries` with:
  - `query_type = 'bank_orphan'`
  - `status = 'open'`
- The statement is marked `upload_status = 'matched'` — the pipeline completes; the queries are what need resolution.

### Scenario B — Candidates Exist But No Tier Matched
After all tiers run:
```ts
const stillUnmatched = txns.filter(t => !matchedTxnIds.has(t.id))
```
- Existing open/investigating queries for these transactions are fetched first to avoid duplicates on re-runs.
- A `bank_orphan` row is inserted in `recon_queries` for each genuinely new unmatched transaction.
- These surface in the **Queries tab** of the Match Workbench for CA/accountant resolution.
- The engine is **additive-only** — it never clears or overwrites existing matches; 409 duplicate conflicts are silently ignored on re-run.

### Final Match Engine Result
```ts
{
  exact_matches:   number,  // Tier 1
  fuzzy_matches:   number,  // Tier 2
  ai_matches:      number,  // Tier 3
  utr_matches:     number,  // Tier 0
  unmatched:       number,  // orphans → recon_queries
  queries_created: number,
}
```

---

## 5. The Importance of Precise Data in Both Sources

The match engine's design makes field precision non-negotiable. Imprecise data does not produce wrong matches — it produces `bank_orphan` queries that the CA must resolve manually.

| Field | Bank Statement Side | Voucher Side | Why Precision Matters |
|---|---|---|---|
| **Amount** | `numeric(15,2)`, `Math.round(x*100)/100` in code | `numeric(15,2)` in DB | Tier 1 rejects at ≥ ₹0.01 difference. Indian number format (`1,42,729.92`) and Excel quoting (`="value"`) must be stripped correctly or every match fails |
| **Date** | Normalised from DD/MM/YY source to `YYYY-MM-DD` | `YYYY-MM-DD` | Tier 1 requires exact date equality. DD/MM vs MM/DD confusion silently produces wrong dates — `date_format` in `ColumnMapping` must be detected correctly |
| **Entry Side** | `debit` XOR `credit` — DB constraint, never both | `entry_type = 'Dr'` or `'Cr'` | Every tier enforces side polarity. A bank debit matched against a Dr voucher entry is always rejected, even if amount and date are perfect |
| **UTR / Reference** | Extracted from narration by bank-specific regex patterns | `voucher.utr_number`, `voucher_entries.narration` | Tier 0 is 100% confidence but fires only if the UTR string is captured precisely in both places. A truncated or mistyped UTR produces a `bank_orphan` instead of an auto-match |
| **Voucher Status** | N/A | Must be `'posted'` | Draft vouchers are invisible to the engine. A payment not yet posted will always generate an orphan query, regardless of how well all other fields agree |
| **Narration** | Raw bank narration parsed by `narration-parser.ts` into type + counterparty + reference | Voucher narration + party name from `registry.entities` | Tier 3 AI quality degrades significantly with empty or generic narrations — Claude cannot distinguish between two `"NEFT payment"` entries without counterparty or purpose text |
| **Sort Order** | Detected and corrected before any matching | N/A | A reverse-sorted statement (Federal Bank) that is not corrected produces wrong opening balance derivation, which cascades into wrong balance continuity validation |
| **Number Format** | `indian` (`1,42,729.92`) vs `international` (`142,729.92`) | N/A | Misdetected number format produces amount values that are off by orders of magnitude — every single match for that statement will fail |

### The Fundamental Principle

> A bank transaction is **ground truth from the bank** — it records what actually moved in the account.  
> A voucher is the **accountant's recorded intent** — it records what was supposed to move.  
> The reconciliation engine's sole job is to prove these two records describe the same financial event.

Any field that differs — even by one paisa, one day, or one character in a reference number — means the engine treats them as **different events**. The system is deliberately strict: it is always safer to produce a query that a CA reviews manually than to silently match the wrong voucher to a bank transaction.
