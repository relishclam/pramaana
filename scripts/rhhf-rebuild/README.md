# RHHF Wipe & Rebuild — Execution Guide
**Date:** 15-Aug-2026  
**Entity:** Relish Hao Hao Chi Foods (RHHF)  
**company_id:** `b8beb440-df7f-48e8-a012-ac5750502eca`  
**DO NOT TOUCH:** RFPL (`bc455c94-0bcd-4d66-a040-d29ed880d22f`)

---

## Prerequisites

1. `.env` file present with `PM_SUPABASE_URL` and `PM_SERVICE_ROLE_KEY`
2. Python venv activated (`source .venv/Scripts/activate` on Windows)
3. Packages: `supabase`, `pandas`, `python-dotenv`, `openpyxl`
4. TB file at: `scripts/rhhf-rebuild/source-data/TrialBal_20260815_Final.xlsx`

---

## Execution Order

### Phase 0 — Pre-wipe Snapshot (READ-ONLY)
Run **in Supabase SQL Editor** before touching anything:
```
scripts/rhhf-rebuild/phase0_snapshot.sql
```
Record the RFPL counts. They must be identical after Phase 1.

### Phase 1 — Wipe RHHF Data (DESTRUCTIVE)
Run **in Supabase SQL Editor**:
```
scripts/rhhf-rebuild/phase1_wipe.sql
```
The script begins with a snapshot, wipes RHHF, then re-snapshots RFPL for comparison.
**Expected after wipe:** RHHF vouchers = 0, RHHF entries = 0, all RHHF opening_balance = 0.

### Phase 2 — Ledger Restructure
Run **in Supabase SQL Editor**:
```
scripts/rhhf-rebuild/phase2_ledger_restructure.sql
```
Renames, regroups, and creates RHHF ledgers per the Final TB mapping.
Safe to re-run (idempotent guards throughout).

### Phase 3 — Load Opening Balances
Place `TrialBal_20260815_Final.xlsx` in `scripts/rhhf-rebuild/source-data/`.
Run from the project root:
```bash
python scripts/rhhf-rebuild/phase3_opening_balances.py
```
The script reads the TB, maps Tally → Pramaana names, balance-checks, then writes.
It will **stop and report the difference** if Dr ≠ Cr — do not force-balance.

### Phase 4 — Verification Gates
Run **in Supabase SQL Editor**:
```
scripts/rhhf-rebuild/phase4_verify.sql
```
All 7 gates must pass before go-live.

---

## Flagged Items (open, 15-Aug-2026)

| # | Item | Status |
|---|------|--------|
| 1 | Advances party-wise split (Mitra/Drishya/Materials) — total ₹57,43,478.44 is final | Pending CA Antony Malayil |
| 2 | HDFC Current ₹1 variance (TB ₹1,87,146.18 vs stmt ₹1,87,145.18) | Log in recon; flag for CA |
| 3 | SUS-2026-27-00002 Sangeetha ₹40,498 — will migrate from Relish Approvals later | Post-go-live |

## Post-go-live Journals (CA to book in Pramaana)

1. Dr HDFC / Cr Suspense ₹40,000 — when Sangeetha returns funds
2. Dr Suspense ₹498 / Cr Office Expense ₹498 — clear residual
3. Dr Opening Adjustment / Cr [CA to specify] ₹20,500 — clear plug ledger
4. Optional: reclass Sweep FD interest Cr ₹8,975.43 → Interest Income ledger
