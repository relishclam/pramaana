# LESSONS FOR PRAMAANA

*Generated from Relish Approvals hardening sprint, 7–10 August 2026.*
*Every rule here was proven in production — not speculated.*

---

## THE FOUNDATIONAL AXIOM

**These two statements are treated as absolute truths for all reconciliation logic:**

1. **Every payment voucher has a transaction receipt attached.**
2. **Every payment has a bank statement entry.**

Therefore: **Bank statement reconciliation MUST match 100%.**

Not 76.6%. Not "substantially complete." 100%.

Any unmatched voucher or unmatched statement line is not a permanent gap —
it is an incomplete workflow. The question is never "can this be matched?"
but always "what is missing that prevents the match?"

The four possible reasons for a temporary mismatch:

- The receipt has not been uploaded yet → **collection task for Accounts**
- The bank statement for that period has not been uploaded yet → **upload task**
- The UTR has not been synced from Approvals to Pramaana yet → **run the sync bridge**
- The wrong extraction label was used → **update the prompt and retry**

None of these is a dead end. All are resolved by completing the workflow.

---

## 1. Receipt Extraction Pipeline

### The Core Principle (Motty's Rule)

Every completed bank transaction has a machine-readable reference on its receipt.
The reference exists — you just need to know the right label to ask for per bank.
Never classify a receipt as "unresolvable" without visual inspection of the file.

### Prompt — ask for ALL known labels

```
"Extract the payment reference number. Look for it under ANY of these labels:
UTR, UPI Transaction ID, Transaction ID, RRN Number, Reference Number,
IMPS Ref No, NEFT Reference, Transaction Reference, Ref No, Transaction No,
Google Pay Transaction ID, Google transaction ID, UPI Ref No,
or a standalone 12-digit number appearing prominently without a label,
or embedded in statement text as 'Re NNNNNNNNN'.
Return the first valid reference found (9–22 alphanumeric chars).
Return null if not found."
```

### Bank label map (confirmed in production)

| Bank | Receipt field label | Format |
|---|---|---|
| Federal Bank UPI | "Transaction ID" | 12-digit numeric |
| Federal Bank SMS/statement paste | "Re NNNNNNNNNN" embedded in text | 12-digit numeric |
| Canara Bank IMPS | "RRN Number" | 12-digit numeric |
| Canara Bank within-bank | "Reference Number" | Alphanumeric (e.g. H49023IDHR) |
| HDFC Bank UPI | "UPI Transaction ID" | 12-digit numeric |
| HDFC Bank IMPS/NEFT | "HDFC Transaction ID" | `HDFC[A-Z]\d{16}` (e.g. HDFCA6D3B0954844) |
| HDFC Bank RTGS | "Transaction ID" | HDFCR + date + seq (e.g. HDFCR52026070177940911) |
| ICICI Bank | "Transaction ID" or "UPI Transaction ID" | 12-digit numeric |
| Google Pay (newer Federal) | "Google transaction ID" or bare 12-digit | 12-digit numeric |

### Format validation — accepted patterns

| Pattern | Example | Accept? |
|---|---|---|
| 9–12 digit numeric | 175381258, 622226546628 | ✓ |
| 12–16 alphanumeric | HDFCH01127205671, ME0Z2C0K78 | ✓ |
| `HDFC[A-Z]\d{16}` | HDFCA6D3B0954844 | ✓ |
| HDFCR + longer | HDFCR52026070177940911 | ✓ (extend to 22) |
| < 9 chars | WSSTUPI, S8914800 | ✗ reject |
| > 22 chars | HDFCR5202607177940911X | ✗ reject |
| Razorpay order IDs | order_TDHjn4FXKLgr3k | ✗ reject |

**Store everything as strings — never cast to integer. Leading zeros matter.**
`000184966670` ≠ `184966670`

### Federal Bank pre-acceptance PDFs — the one genuine exception

Federal Bank's "Transaction Summary" PDF is a **pre-acceptance** document.
It prints: "Transaction is accepted and will get processed soon."
The UTR does not exist yet when this file is generated.
**Do not retry OCR on these. Resolve from the bank statement side.**
Distinguishable by: ~105KB file size, identical size across a batch, same payees.
The post-settlement receipt (which DOES have a Transaction ID) is a separate document
that arrives later — collect and upload that one instead.

### Image-based PDFs

Many bank receipts are image-rendered (minimal text layer). Always rasterize
page 1 to PNG before sending to the OCR model. pdfjs-dist handles this locally.
The pdf-parse library is banned on Vercel (DOMMatrix error on serverless).

### Rules

- **Amount guard on every write:** receipt amount must equal voucher amount (±₹1).
  Mismatch → hold for review, never auto-write. Two misfiling incidents caught this way.
- **Never overwrite existing payment_reference.** Log conflicts for review.
- **Batch receipts:** one receipt can cover N vouchers. Accept 1:many UTR→voucher.
  Sum of voucher amounts must equal receipt amount (proven: batches of 2, 3, 4, 9).
- **Every path that attaches a receipt must attempt UTR extraction.**
  Paths: share-flow, queue-assign, backfill, desktop upload.
  Manual mark-paid is the only exception (typed input is intentional).

---

## 2. Share Flow Design

### SW stash-before-redirect (critical ordering)

The SW share-target handler must `await cache.put('/_share_pending', payload)`
**before** returning the redirect response. The stash completes, then the redirect
fires. This prevents the app-side fetch racing the stash.

### Three outcome paths (exhaustive)

Every receipt share must resolve to exactly one of:

1. **auto-complete** — matched a voucher/batch by reference or amount; UTR written,
   receipt attached, voucher marked paid.
2. **backfill** — matched a paid-with-null-UTR voucher; UTR written, receipt attached,
   status untouched.
3. **queue-deposit** — no match found; receipt saved to unassigned_receipts with OCR
   data, user notified to assign manually.

No receipt is ever silently dropped. `_depositAndFallback` is the invariant —
called on any error in paths 1–2, ensuring path 3 always runs as the safety net.
The deposit-unassigned path must call OCR **before** queuing (UTR is the dedup key).

### Honest toast rule

Success card must reflect what actually persisted:

- UTR written + receipt attached → "Receipt Attached & UTR Recorded" (green)
- UTR written only → "UTR Recorded" + amber warning (receipt upload failed)
- Receipt attached only → "Receipt Attached" (no UTR found in receipt)
- Nothing written → red error with reason

Never fire success before awaiting and verifying both writes.

### Auto-switch company on share landing

The OCR'd `initiator_account_number` maps to paying bank → company.
Map: HDFC No-Lien → RHHF; Canara/Federal → RFPL.
After processing, switch the active company before presenting the result card.
No navigation required from the user.

### Cold-start and warmup (critical for payment-critical routes)

Problem: monolithic server file loads all dependencies on cold start (~2–4s overhead).
The voucher-poll route stays warm but auto-complete does not — causing 6s+ delays
on the first share after a quiet period, sometimes triggering the wrong outcome.

Fix pattern:

1. Route functions to the nearest region (Mumbai/`bom1` for India)
2. Add a trivial `GET /api/_warm` endpoint returning `{ok:true,t:Date.now()}`
3. Cron: ping `/_warm` every 4 minutes (Vercel Pro supports minute-granularity crons)
4. Client polling loop: fire-and-forget warmup ping alongside regular poll

Expected result: consistent 2–3s auto-complete instead of intermittent 6s+ cold starts.

---

## 3. Batch Payment Patterns

### 1:many UTR → voucher (proven in production)

A single bank transaction UTR can legitimately settle multiple vouchers.
Proven batch sizes: 2, 3, 4, 9. Never assume 1:1.

### Amount-sum guard (required)

On a UTR hit with multiple vouchers: sum of all matched voucher amounts must equal
the transaction amount (±₹1). Fail → log to review list, no write.

### Batch references (CPAY)

App-generated batch references (CPAY-YYYY-YY-NNNNN) are per-company sequential.
CPAY-2026-27-00007 in RHHF ≠ CPAY-2026-27-00007 in RFPL. Always scope by company.

### Auto-complete for batches

Matcher must check receipt amount against open batch totals (same payee), not just
individual vouchers. On match: write UTR to ALL member vouchers atomically.
Fallback: subset-sum across same-payee awaiting_payment vouchers — propose-only,
never auto-write.

### Audit trail on every member voucher

Every voucher settled as part of a batch must print:

```
UTR / Ref:   <utr>
Settled via: CPAY-YYYY-YY-NNNNN (₹total total)
Members:     VCH-XXXXX ₹amount · VCH-YYYYY ₹amount
```

Without this, an auditor sees a ₹673 voucher with a ₹1,292 receipt and cannot reconcile.

---

## 4. Receipt Storage Conventions

### Two distinct fields — never conflate

| Field | Contents | Purpose |
|---|---|---|
| `payment_receipt_url` | Payment confirmation receipt | Bank evidence for reconciliation |
| `voucher_attachments` | Vendor bills, invoices, site photos | Supporting documentation |

These are separate concepts. Payment receipts uploaded via the bill attachment path
are misfiled — they appear in `voucher_attachments` but are not flagged for UTR
extraction. Pramaana must maintain this distinction from day one.

### Storage path convention

`payment-receipts/<voucher-uuid>/VCH-NNNNN-PMT-DD-Mon-YYYY.ext`

The folder UUID is the voucher's UUID — the authoritative ownership key.
Filename determinism only applies from ~mid-June 2026. Earlier files use
`receipt_<timestamp>` naming. Always resolve ownership via the folder UUID,
not the filename.

### Ghost row trap (voucher_attachments)

A settlement workflow bug caused `copyTransferReceiptsToVoucher` to copy all
existing transfer_receipt rows (including prior copies) into each new settlement
voucher, doubling the pool each time. VCH-00657 accumulated 1,001 rows from 1 file.

Root cause: the SELECT lacked `.is('voucher_id', null)` — it picked up copies,
not just originals. Fix: always filter to source records only before copying.
The ghost rows pointed to non-existent storage objects (404). Cleanup: keep one
row per voucher (earliest by `uploaded_at`), delete the rest.

---

## 5. Cross-Company Rules

### Voucher numbers are NOT unique across companies

RFPL and RHHF both use the VCH-YYYY-YY-NNNNN series. VCH-2026-27-00539 exists
in both companies as different vouchers with different payees and amounts.

**Always key on (company_id + voucher_number) or UUID — never voucher_number alone.**

### Pramaana uses different voucher numbers than Approvals (for RHHF)

- Approvals: `VCH-2026-27-NNNNN`
- Pramaana RHHF: `RHHF/PYMT/2627/NNNN`

The crosswalk: Pramaana's `ref_document_number` = `'RA-' + RA serial_number`.
This is a deliberate structured key from the migration script. Use it.

### Amount guard catches misfiling

Two misfiling incidents caught in production by amount guard:

- VCH-00535 (RFPL ₹3,600) had RHHF's VCH-00539 (₹4,800) receipt filed against it
- VCH-00633 (RHHF ₹65) had VCH-00632's ₹40 receipt in its folder

The amount guard is the primary defence against cross-company and intra-company
misfiling. It is not optional.

---

## 6. Bank-Specific UTR Resolution

### Reference-rich banks (resolve from receipt)

Canara Bank, HDFC Bank, ICICI Bank, KVB, Bandhan: receipts carry clear references.
OCR pipeline resolves these at payment time with the correct prompt labels.

### Federal Bank — two document types

**Post-settlement (resolve from receipt):**

- UPI: "Transaction ID" (12-digit, now extractable with updated prompt)
- Newer Google Pay format: bare 12-digit, or "Google transaction ID" label
- Rasterize before OCR (image-based PDFs)

**Pre-acceptance (resolve from statement only):**

- "Transaction Summary" ~105KB PDFs: no UTR printed
- Collected in bulk (batches of daily payments, identical file sizes)
- Do not retry OCR — UTR doesn't exist in the document

### Federal Bank narration bonus

Federal Bank's payment "Remark" field carries the voucher number (e.g. "457").
This remark appears in the Canara statement narration for inbound IMPS credits.
The reference tier should extract bare voucher-number fragments from narrations.

### Canara statement narration structure (confirmed)

Outgoing IMPS debits: `IB-IMPS-DR//<bank>/**<acct>//<date>/<UTR>`
The UTR is the last token after the final `/`. Primary extraction pattern for Canara.

### HDFC RTGS Transaction IDs

Format: `HDFCR` + 8-digit date + sequence = up to 22 chars.
Extend format validator to accept `^HDFC[A-Z]\d{14,16}$` alongside 9–16 char rule.
Example: `HDFCR52026070177940911` (22 chars, valid).

---

## 7. Reconciliation Engine (Pramaana)

### Motty's framing (the correct approach)

1. Extract ALL transaction references from vouchers (Approvals `payment_reference`)
2. Extract ALL narrations + reference fields from bank statements
3. THEN match — reference in narration/reference field = confidence 100

Don't reverse-engineer narrations when the reference is already in a structured field.

### UTR index must be company-scoped, not bank-ledger-scoped

79/81 RFPL UTR vouchers had their Cr entries on the Federal bank ledger (from Tally
migration), not the Canara recon ledger. Scoping by bank ledger produces an empty
index. Scope by `company_id` (entity) + look up `voucher.utr_number` directly.

### Feed parsed_reference and reference as direct candidates

The bank statement importer already populates `reference` and `parsed_reference`
for many rows. Feed these directly into Tier 0 before tokenizing the narration —
they're already clean, no extraction needed.

### Tier 0 UTR matching spec

1. Tokenize narration: extract 9–22 char alphanumeric tokens (preserve leading zeros)
2. Also feed `txn.reference` and `txn.parsed_reference` as direct candidates
3. Match candidate against `vouchers.utr_number` scoped to statement's entity
4. On hit: gather ALL vouchers sharing that UTR (batch case)
5. Amount guard: sum of matched voucher amounts = transaction amount (±₹1)
6. Pass → create match rows, method `'utr'`, confidence 100
7. Fail → log to [UTR-REVIEW] list, never silently skip

### Sync bridge

- Source: Approvals `payment_reference` field
- Target: Pramaana `utr_number` field (deliberate naming difference — comment in code)
- Key: `company_id` + `voucher_number` (or `ref_document_number` crosswalk for RHHF)
- Guard: write only where `utr_number` is null or identical; conflict → report, no overwrite
- Idempotent: safe to re-run after every new batch of payments
- Trigger: Pramaana's `trg_prevent_posted_edit` blocks `utr_number` updates — migration
  required to carve `utr_number` out of the immutability rule (accounting fields stay locked)

---

## 8. Failed Payment Flow

A UPI payment can fail after OTP verification. Funds return to source account.

### Required capability

`POST /api/vouchers/:id/mark-payment-failed` (Approver/SuperAdmin only):

- Reverts `status` → `awaiting_payment`
- Clears `payment_reference`, `payment_receipt_url`, `paid_by`, `paid_at`
- Prepends timestamped audit note to `payment_notes` — survives permanently
- Re-enables the Pay Now QR

The original failed receipt file in storage: retain as evidence of the attempt.

### Cash payments

Some vouchers are paid in cash (maids, small vendors). No bank transaction, no UTR.
The system must accept `payment_mode = 'Cash'` with no UTR required.
Cash vouchers must be excluded from ALL receipt matching and bank reconciliation.
They will never appear in any bank statement.

---

## 9. Review Queue Hygiene

### Dedupe by UTR + company

Before inserting into `unassigned_receipts`, check for an existing row with the
same extracted UTR and same company. Refresh/update that row instead of inserting.
Run OCR **before** queuing — the UTR is the dedup key. The safety-net deposit path
must call OCR first, not insert blindly.

### Auto-resolve siblings

When a UTR is written to any voucher (assign, backfill, or auto-complete), find all
`unassigned_receipts` rows for the same company carrying that UTR and set them to
`assigned` with reason and voucher reference.

### Two bugs to avoid (both hit in production)

1. **Use-before-define:** if `utrWritten` is referenced before its `const` declaration,
   it evaluates to `undefined` and auto-resolve never fires.
2. **Race condition:** run the explicit row update (current row → assigned) BEFORE
   the sibling sweep, so the current row is excluded from the sweep.

---

## 10. Build and Deployment Rules

### esbuild (Approvals stack)

Transform-only — no `--bundle` flag. App uses global React from CDN script tags.

```
esbuild app.js --loader:.js=jsx --target=es2018 --minify --sourcemap \
  --outfile=public/app.bundle.js
```

Remove Babel-standalone. On a 500KB+ file it adds 1–3s main-thread transpilation
on every cold start. Use `@vercel/static-build` with `distDir: "public"` so the bundle
is generated at deploy time and never committed to the repo.

### Version bump rule

Every commit touching `index.html`, the bundle, or `service-worker.js` must bump
BOTH the `?v=NN` query string AND `CACHE_NAME`. A mismatch causes silent offline
cache failures that are very hard to diagnose.

### SW precache must include navigation entries

Precache both `'/'` and `'/index.html'`. Navigation fallback:

```js
caches.match('/index.html').then(r => r || fetch('/index.html'))
```

Never return `undefined` from a fetch handler — `respondWith(undefined)` throws TypeError.

### isNavigation vs isAppCode fallback branching

- `isNavigation` → `caches.match('/index.html')` (query-string URLs like
  `/?incoming-share=1` never match cached keys)
- `isAppCode` → `caches.match(event.request)` (exact precached URL)

Never serve HTML as JavaScript.

### Vercel region and warmup

- Set `"regions": ["bom1"]` for Indian users — saves ~150ms per request
- Add `GET /api/_warm` trivial endpoint
- Cron `*/4 * * * *` to ping `/_warm` (requires Vercel Pro)
- Client polling loop: fire-and-forget warmup ping alongside regular poll
- `maxDuration: 120` for OCR-heavy routes (default 60s is insufficient for large images)

---

## 11. Auditor Trail Standards

Every payment document must be self-contained — an auditor must be able to verify
the payment without needing any other document.

### Single voucher

```
UTR / Ref:      622226546628
Payment mode:   UPI
Paid from:      HDFC No-Lien A/c
Receipt:        [thumbnail or link]
```

### Batch payment (every member voucher)

```
UTR / Ref:      621997876714
Settled via:    CPAY-2026-27-00007 (₹1,292.00 total)
Members:        VCH-2026-27-00695 ₹673.00 · VCH-2026-27-00696 ₹619.00
```

### CPAY document

Must list all member vouchers with amounts summing to the paid total.
A ₹1,292 batch receipt attached to a ₹673 voucher with no explanation
is an audit finding. The arithmetic must close on the face of every document.

---

## 12. Bank Statement Data Extraction

### The two-sided contract

Every payment has two records:

1. **The voucher** — what Relish intended to pay, to whom, from which account
2. **The bank statement line** — what the bank actually debited/credited, with narration

Reconciliation is proving these two records describe the same event.
Both sides must be extracted correctly before matching is attempted.

### Statement import pipeline

The statement importer must populate these fields for every transaction row:

| Field | Content | Notes |
|---|---|---|
| `date` | Transaction date | Parse DD/MM/YYYY, DD-Mon-YYYY, YYYY-MM-DD |
| `amount` | Debit or credit amount | Store as positive decimal; use separate `dr_cr` flag |
| `narration` | Full narration text | Preserve exactly — tokenizer reads this |
| `reference` | Bank's own reference field | Populated by bank CSV/PDF directly |
| `parsed_reference` | Extracted reference from narration | Importer extracts during parse |
| `balance` | Running balance after transaction | For BRS verification |
| `transaction_type` | IMPS/NEFT/RTGS/UPI/CHQ/CHRG/INT | Critical for excluding non-payment rows |

### Narration structure by bank (confirmed in production)

**Canara Bank:**

- Outgoing IMPS: `IB-IMPS-DR//<bank-code>/**<acct>//<date>/<UTR>`
  → UTR is the last token after final `/`
- Incoming IMPS: `MOB-IMPS-CR/<name>/<bank>/<acct>/<desc>/`
  → `parsed_reference` contains the inbound UTR
- GST payments: `GSTN<number>-<ref>` → no UTR, fuzzy match only
- Bank charges: `CHRG/IMPS/<amount>/<date>` → exclude from reconciliation
- Utilities: `IB ITG <desc>` → no UTR, amount+reference tier

**Federal Bank:**

- Outgoing (customer receipts into Federal): `FT IMPS/IFI/<UTR>/RELISHFOODSPVTLTD/IMPS`
  → UTR is the third `/`-separated token
- Incoming credits: same pattern, UTR in position 3
- Bank charges: `CHRG/IMPS/<amount>/<date>` → exclude
- Bonus: Federal payment "Remark" field (set at payment time) carries the voucher
  number (e.g. "457" for VCH-457) → this appears in the narration and enables
  reference-tier matching even without a UTR

**HDFC Bank:**

- Outgoing UPI: narration carries UPI Transaction ID in structured format
- Outgoing RTGS: narration + reference field both carry HDFC Transaction ID
- Statement CSV has a dedicated reference column — use it directly

### Transactions to EXCLUDE from reconciliation matching

These will never match a payment voucher:

| Type | Pattern | Reason |
|---|---|---|
| Bank charges | `CHRG/IMPS/`, `ATM INSUFFICIENT FUND CHARGES` | Not a payment |
| GST/tax payments | `GSTN<number>` | Separate ledger entry |
| Interest credit | `INT CREDIT`, `INTEREST` | Income, not payment |
| Internal transfers | `IB ITG` to own accounts | Inter-account, not vendor payment |
| DD/cheque returns | `CHQ RETURN`, `ECS RETURN` | Failed instrument |

Mark these as `excluded` in `recon_transactions.transaction_type` and remove from
the matching pool. Including them inflates the unmatched count and creates false
positives in amount-based tiers.

### Pre-loading reference fields at import time

The importer should extract references during parsing, not at match time:

1. Parse narration with bank-specific regex to extract UTR/reference
2. Populate `parsed_reference` immediately
3. Populate `reference` from the bank's own reference column if available
4. These fields feed Tier 0 directly without re-parsing at match time

---

## 13. Voucher Reconciliation Methods (Tier Architecture)

### The matching hierarchy — always run in order, stop at first hit

```
Tier 0  — UTR exact match         (confidence 100, proof-level)
Tier 1  — Reference match         (confidence 90, strong evidence)
Tier 2  — Exact amount + date     (confidence 70, probable)
Tier 3  — Fuzzy/AI               (confidence <60, requires review)
```

Each tier processes only what the previous tiers left unmatched.
A matched transaction exits the pool — it cannot be matched again.

### Tier 0 — UTR Exact Match

**Input:** statement transaction with narration/reference fields  
**Method:**

1. Extract UTR candidates from `txn.reference`, `txn.parsed_reference` (direct — no parsing)
2. Tokenize `txn.narration` for 9–22 char alphanumeric tokens (preserve leading zeros)
3. For each candidate: look up `vouchers.utr_number` scoped to the statement's entity
4. On hit: gather ALL vouchers sharing that UTR (batch case — proven up to 9 vouchers)
5. **Amount guard:** sum of matched voucher amounts = transaction amount (±₹1)

- Pass → match confirmed, confidence 100
- Fail → log to [UTR-REVIEW], do not match, do not skip silently

**Why this tier is definitive:** the UTR is assigned by the banking network and is
globally unique per transaction. An exact UTR match is bank-certified proof.

**When it misses:**

- UTR not yet synced from Approvals (run the sync bridge)
- Federal pre-acceptance receipts (no UTR on the document — statement-side only)
- Cash payments (excluded by design)

### Tier 1 — Reference Match

**Input:** unmatched transactions after Tier 0  
**Method:**

1. Extract structured references from narration: VCH numbers, invoice numbers,
   payment batch refs (CPAY-YYYY-YY-NNNNN), cheque numbers
2. Federal Bank bonus: "Remark" field carries voucher number → match directly
3. Match against `vouchers.voucher_number`, `vouchers.ref_document_number`,
   `vouchers.invoice_reference`
4. Amount guard applies (±₹1)

**The ₹12,004 Federal batch-of-9:**
Statement narration: `FN IMPS/IFO/618515742123/UBIN0533688/VCH 476 477 4`
Reference tier extracts "VCH 476", "VCH 477" → matches 9 vouchers summing to ₹12,004.
This batch has no UTR in the voucher records (pre-acceptance PDF) but the narration
carries voucher numbers → reference tier resolves it.

### Tier 2 — Exact Amount + Date Window

**Input:** unmatched transactions after Tier 1  
**Method:**

1. Match transaction amount against awaiting-payment vouchers (±₹1)
2. Date window: transaction date within ±3 days of voucher `paid_at`
3. Additional signals: payee name fragments in narration, paying account match
4. If unique match → confidence 70 (probable), flag for review
5. If multiple matches → do NOT auto-match; queue for manual review

**Warning — amount recurrence:** ₹2,600 appears 67+ times in RFPL statements.
₹1,300 is equally common. Amount-only matching on these will produce false positives.
Always combine with date window AND at least one additional signal.
Never auto-close a Tier 2 match without human confirmation.

### Tier 3 — AI/Fuzzy

**Input:** unmatched transactions after Tier 2  
**Method:** semantic similarity between narration and voucher narration/payee  
**Confidence:** always below 60 — always requires human review before closing  
**Exclude:** bank charges, GST payments, internal transfers (marked in `transaction_type`)

### Bank Reconciliation Statement (BRS)

After matching, the BRS is:

```
Bank Statement Closing Balance
+ Outstanding cheques/payments (vouchers paid but not yet on statement)
- Outstanding deposits (credits on statement not yet in books)
= Books Balance
```

Every unmatched statement debit is an outstanding payment.
Every unmatched statement credit is an unrecorded receipt.
The BRS must net to zero (or explain the difference) before the period is closed.

---

## 14. Reconciliation Completeness Rules

### The completeness contract

- **Every voucher** (Apr 1 2026 onward) has a transaction receipt
- **Every transaction receipt** has a machine-readable reference
- **Every reference** appears in a bank statement narration or reference field
- Therefore: **every voucher can be reconciled** — the question is only which tier

Unmatched vouchers after all tiers are not unreconcilable — they are:

1. Receipts not yet uploaded (collection task for Accounts)
2. Bank statement not yet uploaded for that period (upload task)
3. Federal pre-acceptance PDFs where the post-settlement receipt exists in the bank
   app but wasn't uploaded (collection task)
4. Cash payments (no bank statement line by design — verify against cash book)

### Statement upload checklist (per period close)

Before declaring a period reconciled, confirm:

- [ ] Federal Bank statement uploaded for RFPL (full month)
- [ ] Canara Bank statement uploaded for RFPL (full month)
- [ ] HDFC No-Lien statement uploaded for RHHF (full month)
- [ ] All vouchers for the period have `payment_reference` set or are marked Cash
- [ ] BRS shows zero unexplained difference
- [ ] All Tier 3 matches reviewed and confirmed or rejected

### The ₹2,600 recurring amount problem

₹2,600 appears as a payment amount in 67+ Federal statement transactions.
This is a known pattern: weekly ₹2,600 payments to Sunny (fabricator) and similar
recurring weekly labour payments. Amount-based matching on these is dangerous.

Resolution path:

1. Tier 0 resolves those with UTRs (from HDFC/Canara receipts)
2. Tier 1 resolves those with VCH numbers in the Federal "Remark" field
3. Remaining unmatched ₹2,600 entries: review in date order against weekly
   payment patterns — do not auto-close

### Cross-company statement segregation

- Federal Bank (account ...4513): **RFPL only** — do not load into RHHF recon
- Canara Bank (account ...1375): **RFPL only**
- HDFC No-Lien (account ...1702): **RHHF only**

Never mix statement lines across companies. The entity scoping in `recon_statements`
and `recon_bank_accounts` enforces this — verify `company_id` before every import.

---

## 15. AI Matching Engine — Prompt Engineering for 100% Match

### The directive

The AI matching engine must be instructed to FIND a match, not to report
that one cannot be found. Every unmatched entry is a puzzle to solve,
not a case to close as "unresolvable."

### Master prompt for the AI reconciliation engine

```
You are a bank reconciliation specialist for Relish Group (RFPL and RHHF),
two Indian food processing companies. Your job is to match every bank
statement transaction to a payment voucher. Your target is 100% match rate.

ABSOLUTE RULES:
1. Every payment voucher has a transaction receipt. Every receipt has a
   reference number. Every reference appears in a bank statement.
2. If you cannot find a match, state EXACTLY what is missing and what
   additional information would resolve it. Never say "no match possible."
3. Never match a transaction to the wrong voucher to force a match.
   A wrong match is worse than an unmatched entry.

SEARCH STRATEGY — attempt ALL of the following before reporting unmatched:

STEP 1 — UTR/Reference exact match:
   Look for the transaction's reference number in:
   - The narration's last token after the final "/" (Canara IMPS pattern)
   - The bank's own reference column/field
   - Any 9–22 character alphanumeric sequence in the narration
   Match against voucher.utr_number, payment_reference, or any reference field.
   One UTR can match MULTIPLE vouchers (batch payments). Sum their amounts.

STEP 2 — Voucher number in narration:
   Look for VCH, voucher number fragments, or invoice references in narration.
   Federal Bank "Remark" field carries the voucher number — search for it.
   Patterns: "VCH 476", "VCH-2026-27-00476", "476 477 4", "vch535", "535"

STEP 3 — Payee name match:
   Extract payee name fragments from narration.
   Match against voucher payee names, aliases, UPI IDs, account numbers.
   Canara: payee name appears after MOB-IMPS-CR/ or IB-IMPS-DR/
   Federal: payee name in the RELISHFOODSPVTLTD segment identifies direction

STEP 4 — Amount + date window:
   Match transaction amount against voucher amounts (±₹1 tolerance).
   Date window: ±3 calendar days of voucher paid_at.
   If multiple vouchers match the amount, combine ALL additional signals
   (payee, account number, narration fragments) to narrow to one.
   WARNING: ₹2,600 and ₹1,300 are highly recurring amounts — never
   match on amount alone for these. Require at least one additional signal.

STEP 5 — Batch/combined payment detection:
   If the transaction amount does not match any single voucher, check whether
   it equals the sum of 2 or more vouchers to the same payee on the same date.
   Proven batch sizes: 2, 3, 4, 9 vouchers in one transaction.
   If a sum matches: propose the batch members explicitly with their amounts.

STEP 6 — Account number signals:
   The paying account number in the narration identifies the company:
   - HDFC ...1702 (No-Lien) → RHHF payments
   - Canara ...1375 → RFPL payments
   - Federal ...4513 → RFPL Federal payments
   Use this to scope the voucher search to the correct company.

STEP 7 — Reverse match:
   If no voucher matches the statement debit, check whether the statement
   entry is a credit (incoming payment from customer) rather than a debit.
   If it is an incoming credit, it is not a payment voucher — classify as
   "customer receipt" and note the customer name from the narration.

STEP 8 — Period boundary check:
   If the transaction date is near a period boundary (end/start of month),
   check vouchers from the adjacent period. A payment approved on the 31st
   may settle on the 1st of the next month.

FOR EACH UNMATCHED ENTRY, REPORT:
   - Which steps were attempted
   - What was found at each step
   - What specific information is missing (UTR not synced? Receipt not uploaded?
     Statement for adjacent period not uploaded? Voucher not yet created?)
   - Confidence level of any proposed match (0-100)
   - Whether human review is required before closing

TRANSACTIONS TO EXCLUDE (not payment vouchers):
   - Bank charges: CHRG/IMPS, ATM charges, service fees
   - GST/tax payments: GSTN prefix
   - Interest credits: INT CREDIT, INTEREST PAID
   - Internal transfers between own accounts: IB ITG to known own accounts
   - Bounced instruments: CHQ RETURN, ECS RETURN, NACH RETURN

CONFIDENCE LEVELS:
   100 — UTR exact match (bank-certified proof)
    90 — Reference/voucher number in narration (strong documentary evidence)
    70 — Unique amount + date + payee (probable, review recommended)
    50 — Amount + date only (possible, human review required)
     0 — No evidence found (report what is missing, do not guess)

OUTPUT FORMAT for each match:
{
  "transaction_id": "<statement row id>",
  "matched_vouchers": ["VCH-2026-27-00XXX"],
  "match_method": "utr|reference|amount_date|batch|manual",
  "confidence": 100,
  "evidence": "UTR 622226546628 found in narration suffix, matches VCH-00702",
  "amount_check": "₹1,300 = ₹1,300 ✓",
  "requires_review": false
}

OUTPUT FORMAT for unmatched:
{
  "transaction_id": "<statement row id>",
  "matched_vouchers": [],
  "confidence": 0,
  "steps_attempted": ["utr", "voucher_number", "payee", "amount_date", "batch"],
  "blocking_reason": "UTR 618515742123 not in voucher index — likely Federal pre-acceptance receipt; post-settlement receipt not yet uploaded",
  "resolution_path": "Upload post-settlement Federal receipt for the ₹12,004 payment dated 2026-07-04 to obtain Transaction ID",
  "requires_human": true
}
```

### Iterative reconciliation workflow

The AI engine should not run once and stop. It should:

1. **First pass** — run all tiers, report match rate and all unmatched entries
   with their blocking reasons
2. **Resolution pass** — for each blocking reason, trigger the appropriate action:
   - "UTR not synced" → run the Approvals sync bridge, then re-run
   - "Receipt not uploaded" → notify Accounts with specific voucher list
   - "Statement not uploaded" → request the missing statement period
   - "Wrong extraction label" → retry OCR with updated prompt
3. **Second pass** — after resolutions, re-run on previously unmatched entries only
4. **Repeat** until match rate = 100% or all remaining unmatched entries have
   documented human-review-required reasons

### What "match rate = 100%" actually means

100% does not mean every entry is auto-matched by the algorithm.
It means every entry is accounted for in one of these states:

- ✅ Matched to a voucher (any confidence level, verified)
- 🔵 Excluded (bank charge, GST, internal transfer — documented)
- 🟡 Pending (resolution path identified, action assigned to a person)
- ❌ Disputed (amount/payee mismatch — escalated for investigation)

No entry should ever be in an unclassified "unmatched" state at period close.

---

## 16. Codebase Reality — What Is Already Built

*This section documents the actual implementation as of August 2026.*
*Read this before building anything new — do not reinvent what exists.*

### Bank Statement Import Pipeline (pre-converter.ts)

The pipeline runs in 9 stages — zero DB calls inside transform functions:

**Stage 1–2:** File type detection (CSV vs XLSX by raw bytes) + extraction.

**Stage 3–4:** Bank detection via 4 passes:

1. Metadata scan (rows 0–20 for bank name, account number, IFSC) — confidence 95
2. Header row fuzzy scoring against known `BANK_SIGNATURES` — up to 100
3. Narration marker scan (first 50 rows for bank-specific prefixes) — confidence 80
4. Filename check — confidence 50

**Stage 5:** Column mapping via `recon_format_profiles` cache (keyed by `bank_code:header_hash`).
On cache miss: heuristic `detectColumns()`. If confidence < 70: AI fallback via
`aiDetectFormat()` using Claude Sonnet 4.6. Result cached — AI never called again
for an already-seen format.

**Stage 6:** Canonical extraction — strips Excel quoting (`="value"`), parses Indian
number format (`1,42,729.92`), normalises dates to `YYYY-MM-DD`.
Output: `CanonicalTransaction[]` — `{txn_date, narration, reference, debit|null, credit|null, balance}`

**Stage 7:** Sort order detection + fix (Federal Bank statements are reverse-sorted).

**Stage 8:** Opening balance derivation + balance continuity validation
(advisory only — never blocks the pipeline).

**Stage 9:** Duplicate detection by `(txn_date + amount + narration)` — flagged
but not removed; caller handles via skip/replace/merge.

**Banks currently supported:**

| Bank | Company | Special Handling |
|---|---|---|
| HDFC | RHHF | XLSX, DD/MM/YY, 15+ decorative letterhead rows before headers |
| Federal | RFPL | Reverse-sorted CSV, `Sl. No.` col, empty column shift |
| Canara | RFPL | Excel-quoted values, Indian number format |
| SIB | RHHF | Standard |
| Airwallex/HSBC | RFPL | TBD |

### Voucher Data Extraction (match-engine.ts)

Two fetch pools before matching begins:

**Pool A — Date-windowed candidates:**
Posted vouchers with `voucher_date BETWEEN (min_txn_date - 7) AND (max_txn_date + 7)`.
Used by Tiers 1, 2, 3.

**Pool B — Unrestricted reference pool:**
All posted vouchers for the company, no date filter.
Used by Tier 0 (UTR) and Tier 1.2 (narration voucher-reference match).
Required because payee-typed voucher numbers in narrations may refer to vouchers
far outside the current date window.

**CRITICAL: Only `status = 'posted'` vouchers are ever considered.**
Draft vouchers are completely invisible to the engine. A payment not yet posted
always generates an orphan query regardless of how well all other fields agree.

**UTR Index:** company-scoped (not ledger-scoped). Intentional — Tally-migrated
data may have the bank-side entry on a different ledger than registered in
`recon_bank_accounts`. All posted vouchers with `utr_number IS NOT NULL` are
indexed as `utr_string → [VoucherEntry]`.

### The Match Engine — Tier Architecture (actual implementation)

The engine is strictly sequential. Each tier sets `match_status` and removes
matched IDs from the pool before the next tier runs.

**Side polarity rule (enforced at every tier):**

- Bank debit (money out) → must match a `Cr` voucher entry on the bank ledger
- Bank credit (money in) → must match a `Dr` voucher entry on the bank ledger

| Tier | Method | Confidence | Status set | Review needed |
|---|---|---|---|---|
| Tier 0 | UTR exact match | 100 | `auto_matched` | No |
| Tier 1 | Amount exact + date exact | 95–100 | `auto_matched` | No |
| Tier 1.2 | Narration voucher-reference match | 75–97 | `auto_matched` / `pending_review` | Only at 75 |
| Tier 2 | Amount exact + date ±3 days | 70–94 | `pending_review` | Yes |
| Tier 3 | AI (Claude) — amount ±10%, date ±7 days | 50–69 | `pending_review` | Yes |

**Tier 0 detail:** extracts candidates from `txn.parsed_reference`, `txn.reference`,
and tokenises `txn.narration` (9–16 char alphanumeric `[A-Z0-9]+`). Supports batch
matching — one bank transaction → multiple voucher entries sharing the same UTR.
UTR found but amount mismatch → logs `UTR-REVIEW`, never silently skips.

**Tier 1.2 detail:** extracts `VCH-YYYY-YY-NNNNN` patterns from narration. Looks
up by `voucher_number` suffix in the unrestricted pool (no date filter). Amount
match → confidence 97, auto-confirmed. Amount mismatch → confidence 75,
`pending_review`.

**Tier 3 — graceful degradation:** if `ANTHROPIC_API_KEY` is absent or API is down,
Tier 3 is silently skipped entirely. Earlier tiers are unaffected. Tier 3 has
zero dependency on AI for pipeline integrity.

### Unmatched Transactions → recon_queries

After all tiers, surviving unmatched transactions become `bank_orphan` queries:

- Written to `recon_queries` with `query_type = 'bank_orphan'`, `status = 'open'`
- Surface in the **Queries tab** of the Match Workbench for CA/accountant resolution
- Engine is **additive-only** — never clears or overwrites existing matches
- Re-runs are safe: 409 duplicate conflicts on `recon_matches` are silently ignored

### Field Precision — Non-Negotiable

| Field | Why precision matters |
|---|---|
| Amount | Tier 1 rejects at ≥ ₹0.01 difference. Indian number format and Excel quoting must be stripped correctly or every match fails |
| Date | Tier 1 requires exact date equality. DD/MM vs MM/DD confusion silently produces wrong dates — `date_format` in `ColumnMapping` must be detected correctly |
| Entry side | Every tier enforces polarity. Bank debit vs Dr voucher entry is always rejected even with perfect amount and date |
| UTR/reference | Tier 0 fires only if the UTR is captured precisely in both places. Truncated or mistyped = orphan |
| Voucher status | Must be `posted`. Draft = invisible |
| Number format | Indian vs international misdetection produces amounts off by orders of magnitude — every match for that statement fails |

### The Fundamental Principle (from the codebase)

> A bank transaction is ground truth from the bank — it records what actually moved.
> A voucher is the accountant's recorded intent — it records what was supposed to move.
> The reconciliation engine's sole job is to prove these two records describe the same event.

Any field that differs — even by one paisa, one day, or one character — means the
engine treats them as different events. This is deliberately strict: it is always
safer to produce a query for CA review than to silently match the wrong voucher.

### Gaps to Address (bridge between current state and 100% target)

| Gap | Current state | Resolution path |
|---|---|---|
| Canara at 76.6% | 294/384 matched | HDFC RHHF statement upload (233 UTRs indexed, waiting for statement) |
| Federal at 43% | 121/282 | Tier 1.2 should catch VCH numbers in Federal "Remark" narrations; verify regex covers bare numbers ("457") not just full VCH format |
| Post-cutoff vouchers | 37 unsynced | Auto-resolves as Pramaana voucher migration catches up |
| Tier 0 token length | 9–16 chars | HDFC RTGS refs are 22 chars — extend to 22 (already done in match-engine.ts hardening) |
| Cash vouchers | No bank line | Exclude from recon pool entirely; verify against cash book separately |

---

*End of lessons register. Each rule here prevented or caught a real production problem.*
*When in doubt: if there's a receipt, there's a reference — find the right label.*
