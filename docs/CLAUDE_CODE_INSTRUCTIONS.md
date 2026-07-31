# Claude Code Task — Wire the Settlement Sheet into PRAMAANA

## Context

**Pramaana** is the Relish Group's accounting app (companies: RFPL and
RHHF). It is a separate application from **Relish Suite**, the Master App
that owns master data — do not touch Relish Suite's codebase for this task.
The two apps share one Supabase project (named `relish_suite`): Relish
Suite uses the `public` schema, Pramaana uses the **`pramaana`** schema.

The new feature — the **Settlement Sheet** — settles invoices/bills against
multi-date bank lines plus TDS and advance-recovery deductions. The
**backend is already live in Supabase** (schema `pramaana`, migrations
050–055): tables `party_config`,
`settlement_bank_lines`, `invoice_settlements`, and RPCs
`get_outstanding_invoices`, `post_settlement_receipt`,
`get_outstanding_bills`, `post_settlement_payment`. Do NOT create or modify
any database objects except where Step 5 says so.

Two component files are provided alongside this document:

- `SettlementSheet.tsx` — two-mode component (`mode="receipt" | "payment"`)
- `SettlementPage.tsx` — page wrapper with a Receipts-in / Payments-out toggle

## Step 1 — Place the files and create the route

1. Put `SettlementSheet.tsx` and `SettlementPage.tsx` into the codebase
   following the project's existing component conventions.
2. Create a new route at `/settlement` (or the app's equivalent pattern —
   e.g. `/vouchers/settlement` if voucher screens are grouped) that renders
   `SettlementPage`. Match however Pramaana registers routes
   (App Router page.tsx or Pages Router — follow what exists).
3. Add a sidebar/nav entry labelled **"Settlement"** in Pramaana's
   navigation, placed near the existing voucher/receipt screens, in the
   same style as the current nav items.

## Step 2 — Fix the Supabase client (CRITICAL)

Both components import `supabase` from `@/lib/supabase` and assume it is
scoped to the **`pramaana`** schema. Inspect Pramaana's existing client
first — since this app already reads/writes pramaana vouchers, it may
already be scoped correctly, in which case just fix the import path to
match and move on. If the client is scoped to `public` (or unscoped):

1. Do NOT repoint the global client if other code depends on it.
2. Create a second export, e.g. `supabasePramaana`, using the same URL/key
   but with `{ db: { schema: 'pramaana' } }`, OR use the
   `.schema('pramaana')` method per call if the installed supabase-js
   version supports it.
3. Update the imports in `SettlementSheet.tsx` and `SettlementPage.tsx` to
   use the pramaana-scoped client for: `party_config`, `ledgers`,
   `ledger_groups`, and all four `.rpc()` calls.

## Step 3 — Server-side calls, not anon client (CRITICAL)

The `pramaana` RPCs are granted to `service_role` only, and `party_config`
RLS has only a `service_role_all_access` policy. Browser-side anon calls
WILL fail with permission errors. Handle it the way this app already
handles privileged calls — inspect the codebase first:

- If the app already routes Supabase writes through API routes / server
  actions with the service-role key, follow that exact pattern: create
  server endpoints for the four RPCs + the `party_config`/`ledgers` reads,
  and have the components call those endpoints instead of supabase directly.
- If the app calls Supabase directly from the client with the anon key for
  everything else, then instead print out (do not run) the SQL needed to
  grant access — `GRANT EXECUTE ... TO authenticated;` for the four
  functions plus an authenticated RLS policy on `party_config`,
  `settlement_bank_lines`, `invoice_settlements` — and tell me to run it in
  the Supabase SQL editor. Then keep the client-side calls.

Also flag if Supabase "Exposed schemas" might not include `pramaana`
(Settings → API). If RPC calls 404/406 at runtime, that is the cause — tell
me to add `pramaana` to exposed schemas rather than working around it.

## Step 4 — Adapt the ledger queries to the real chart of accounts

`SettlementPage.tsx` contains placeholder group filters. Verify against the
actual data before trusting them:

1. Query `pramaana.ledger_groups` for both companies and list the actual
   group names.
2. Bank ledgers: filter must catch RFPL's **Canara** and **Federal** bank
   ledgers, and RHHF's **HDFC** ledgers.
3. Receipt-mode parties: Sundry Debtors group (must include ledger
   "Peninsular Fisheries", id `74ecf056-0658-4193-8ec5-6b4802e016e0`).
4. Payment-mode parties: Sundry Creditors group PLUS wherever staff
   ledgers live (check for groups like "Loans & Advances (Asset)", "Staff",
   or similar — inspect and include them). Report what you found.
5. Company constants: RFPL = `bc455c94-0bcd-4d66-a040-d29ed880d22f`,
   RHHF = `b8beb440-df7f-48e8-a012-ac5750502eca`. The page currently
   hardcodes RFPL; if the app has an existing company switcher (it does —
   the header company dropdown), wire `companyId` to it instead of the
   constant.

## Step 5 — TDS control ledgers

The page looks up ledgers named like "TDS Receivable" / "TDS Payable".
Check whether they exist per company:

```sql
SELECT company_id, id, name FROM pramaana.ledgers WHERE name ILIKE '%tds%';
```

If missing, output (do not execute) INSERT statements for me to run,
following the existing ledgers table shape — required fields include
company_id and the ledger_group_id of an appropriate group
("Current Assets" nature ASSET for TDS Receivable; "Duties & Taxes"
nature LIABILITY for TDS Payable — check actual group names/ids first).
Then the page lookup should find them.

## Step 6 — Advance ledger resolver

`SettlementPage.tsx` hardcodes: Peninsular Fisheries →
"Rent Deposit Recived" ledger `1b955279-512f-46a2-ad4a-8632a8f332b9`.
Keep that. The fallback name-convention query is best-effort — leave it,
but add a TODO comment noting the long-term fix is a
`default_advance_ledger_id` column on `pramaana.party_config`.

## Step 7 — Build, lint, verify

1. `npm run build` (or the project's build command) must pass clean.
2. Fix any TypeScript issues from integrating with the project's tsconfig
   (the components use strict-friendly types but adapt as needed).
3. Do not restyle the components beyond making them consistent with the
   app's existing layout shell (page padding, header placement).
4. Start the dev server and confirm `/pramaana/settlement` renders, the
   party dropdown populates, and selecting "Peninsular Fisheries" in
   receipt mode loads its open invoices and shows the config banner
   (TDS 194I @ 10% · Advance outstanding ₹49,50,000 · recovery ₹50,000/mo).

## Acceptance test (do not post real data yourself)

Stop after verifying the page loads and dropdowns populate. The first real
posting (INV 033: bank ₹1,39,000 + ₹37,800, TDS ₹21,000, advance ₹0 →
must show "Fully settled" at exactly ₹0 remaining) will be done manually
by me. Report anything that errored and every decision you made in
Steps 2–5.
