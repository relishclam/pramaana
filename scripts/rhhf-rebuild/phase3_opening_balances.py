"""
Phase 3 — Load Opening Balances (RHHF)
Pramaana RHHF Wipe & Rebuild, 15-Aug-2026

Opening date: 1-Aug-2026 (TB CLOSING column = 31-Jul-2026 period-end)
Source:       TrialBal_20260815_Final.xlsx  (Final TB, audited)

Explicitly stated amounts are hardcoded below per the Work Order.
The TB Excel is also read to pick up any expense/income heads not
individually listed — all must be taken verbatim from CLOSING column.

Balance check is MANDATORY before any DB write.  If Dr ≠ Cr, the
script stops and reports the difference.  Do NOT add a plug entry.

Run from project root:
    python scripts/rhhf-rebuild/phase3_opening_balances.py

Requires: PM_SUPABASE_URL, PM_SERVICE_ROLE_KEY in .env
"""
from __future__ import annotations

import os
import sys
import warnings
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Optional

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

warnings.filterwarnings("ignore")
load_dotenv()

HERE   = Path(__file__).parent
TB_PATH = HERE / "source-data" / "TrialBal_20260815_Final.xlsx"

RHHF_ID = "b8beb440-df7f-48e8-a012-ac5750502eca"

pm = create_client(os.environ["PM_SUPABASE_URL"], os.environ["PM_SERVICE_ROLE_KEY"])


def pramaana(table: str):
    return pm.schema("pramaana").table(table)


def d(v) -> Decimal:
    """Parse a cell value to Decimal, stripping commas. Returns 0 for blank."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return Decimal("0")
    s = str(v).replace(",", "").strip()
    if not s or s in ("-", "nil", "NIL", "—"):
        return Decimal("0")
    try:
        return Decimal(s)
    except Exception:
        return Decimal("0")


def parse_closing_cell(v) -> Optional[tuple[Decimal, str]]:
    """Parse a TB closing-balance cell like '6363932.92 Dr' or '3000000.00 Cr'."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).replace(",", "").strip()
    if not s or s.lower() in ("nan", ""):
        return None
    parts = s.split()
    if len(parts) == 2 and parts[1] in ("Dr", "Cr"):
        try:
            amt = Decimal(parts[0])
            return (amt, parts[1]) if amt > 0 else None
        except Exception:
            return None
    # plain number with no Dr/Cr suffix
    try:
        amt = Decimal(parts[0])
        return (amt, "Dr") if amt > 0 else None
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# EXPLICIT OPENING BALANCES FROM WORK ORDER (TB CLOSING column, 31-Jul-2026)
# These are verbatim and authoritative.  Do not alter amounts here.
# Format: (Pramaana ledger name, amount as Decimal, 'Dr' | 'Cr')
# ─────────────────────────────────────────────────────────────────────────────

EXPLICIT_BALANCES: list[tuple[str, Decimal, str]] = [
    # ── Capital (Cr) ─────────────────────────────────────────────────────────
    ("Motty Philip — Capital",               Decimal("3000000.00"), "Cr"),
    ("Motty Philip — Current",               Decimal( "778672.37"), "Cr"),
    ("Tarun Philip — Capital",               Decimal("3000000.00"), "Cr"),

    # ── Secured Loans (Cr) ───────────────────────────────────────────────────
    ("KSIDC Term Loan",                      Decimal("13000000.00"), "Cr"),

    # ── Sweep FD interest (Cr) — load as-is; reclass is a post-load CA journal
    ("HDFC Sweep FD",                        Decimal(  "8975.43"), "Cr"),

    # ── Fixed Assets (Dr) ────────────────────────────────────────────────────
    ("Building Construction",               Decimal("6363932.92"), "Dr"),
    ("Software",                             Decimal("1223323.45"), "Dr"),
    ("Diesel Generator",                     Decimal( "470627.12"), "Dr"),
    ("Electrical Fittings",                  Decimal( "226180.00"), "Dr"),
    ("Land Development (Compound Wall)",     Decimal( "148080.00"), "Dr"),
    ("Scooter",                              Decimal( "120000.00"), "Dr"),
    ("Computer",                             Decimal(  "52800.00"), "Dr"),   # Final TB: ₹52,800 (accepted)
    ("Air Conditioner",                      Decimal(  "37500.00"), "Dr"),

    # ── Current Assets (Dr) ──────────────────────────────────────────────────
    ("Advance to Mitra Constructions",       Decimal("3447000.00"), "Dr"),
    ("Advance to Drishya Engineering",       Decimal("2200000.00"), "Dr"),
    ("Advance — Building Materials",         Decimal(  "96478.44"), "Dr"),  # residual; CA to confirm split
    ("HDFC No-Lien A/c 1702",               Decimal("2204349.32"), "Dr"),
    ("HDFC Current A/c 2324",               Decimal( "187146.18"), "Dr"),  # ₹1 known variance vs statement
    ("GST Input Tax Credit — CGST",         Decimal(  "41186.44"), "Dr"),
    ("GST Input Tax Credit — SGST",         Decimal(  "41186.44"), "Dr"),
    ("Cash in Hand",                         Decimal(  "30683.00"), "Dr"),
    ("Rent Advance",                         Decimal(  "25000.00"), "Dr"),
    # Suspense — Sangeetha: ₹40,000 PCB cash with Sangeetha + ₹498 office exp
    ("Suspense — Sangeetha (SUS-2026-27-00002)", Decimal("40498.00"), "Dr"),

    # ── P&L carry-forward (Dr) ───────────────────────────────────────────────
    ("Profit & Loss A/c",                    Decimal( "816603.36"), "Dr"),

    # ── Opening Adjustment (Dr) — carry visible per Motty; CA clears later ───
    ("Opening Adjustment (to clear)",        Decimal(  "20500.00"), "Dr"),

    # ── Expenses explicitly named in Work Order ───────────────────────────────
    # "etc." items come from TB Excel (see read_tb_expenses() below)
    ("Salaries & Allowances",               Decimal( "217296.00"), "Dr"),
    ("Balachandran - Staff",                 Decimal(  "51500.00"), "Dr"),
    ("Interest on Loan",                     Decimal( "428255.00"), "Dr"),
    ("Travelling Expense",                   Decimal( "332905.55"), "Dr"),
    ("Subscription Software",                Decimal( "243185.39"), "Dr"),
]

# Tally name → Pramaana name mapping for TB expense rows not explicitly listed.
# Keys are ILIKE patterns (lower-cased). First match wins.
TB_EXPENSE_NAME_MAP: list[tuple[str, str]] = [
    # items already in EXPLICIT_BALANCES — skip if matched in TB
    ("interest on loan",     "Interest on Loan"),
    ("travelling",           "Travelling Expense"),
    ("subscription",         "Subscription Software"),
    # common RHHF expense heads from Phase 3 HOA map
    ("building construction","Building Construction"),
    ("software",             "Software"),
    ("diesel generator",     "Diesel Generator"),
    ("electrical fitting",   "Electrical Fittings"),
    ("land development",     "Land Development (Compound Wall)"),
    ("compound wall",        "Land Development (Compound Wall)"),
    ("scooter",              "Scooter"),
    ("computer",             "Computer"),
    ("air conditioner",      "Air Conditioner"),
    ("motty philip.*capital","Motty Philip — Capital"),
    ("motty philip.*current","Motty Philip — Current"),
    ("tarun philip",         "Tarun Philip — Capital"),
    ("hdfc.*bank.*abm",      "HDFC No-Lien A/c 1702"),
    ("hdfc.*bank",           "HDFC Current A/c 2324"),
    ("hdfc.*sweep",          "HDFC Sweep FD"),
    ("sweep out fd",         "HDFC Sweep FD"),
    ("ksidc",                "KSIDC Term Loan"),
    ("cash",                 "Cash in Hand"),
    ("advance.*mitra",       "Advance to Mitra Constructions"),
    ("advance.*drishya",     "Advance to Drishya Engineering"),
    ("sundry creditor",      "Advance — Building Materials"),
    ("cgst",                 "GST Input Tax Credit — CGST"),
    ("sgst",                 "GST Input Tax Credit — SGST"),
    ("duties.*tax",          "GST Input Tax Credit — CGST"),  # reassign if combined
    ("rent.*advance",        "Rent Advance"),
    ("suspense",             "Suspense — Sangeetha (SUS-2026-27-00002)"),
    ("opening.*adj",         "Opening Adjustment (to clear)"),
    ("profit.*loss",         "Profit & Loss A/c"),
]


def map_tally_name(tally_name: str) -> str:
    """Map a Tally ledger name to its Pramaana equivalent."""
    import re
    t = tally_name.strip().lower()
    for pattern, pramaana_name in TB_EXPENSE_NAME_MAP:
        if re.search(pattern, t):
            return pramaana_name
    # No match → use Tally name verbatim (will create ledger if needed)
    return tally_name.strip()


def read_tb_expenses(known_ledger_names: set[str]) -> list[tuple[str, Decimal, str]]:
    """
    Read TrialBal_20260815_Final.xlsx and extract Closing column balances.
    Returns rows NOT already covered by EXPLICIT_BALANCES, filtered to
    ledgers that already exist in Pramaana (group totals are skipped).

    TB structure (confirmed from diagnostic):
      Rows 0-8  : title / merged-header rows — skip
      Row 9+    : data rows
      Col 0     : Particulars (Tally ledger name)
      Col 1     : Opening Balance
      Col 2     : Transaction Debit
      Col 3     : Transaction Credit
      Col 4     : Closing Balance  ← the column we want
    """
    if not TB_PATH.exists():
        print(f"  WARNING: TB file not found at {TB_PATH}")
        print("  Expense lines from 'etc.' will be missing.")
        print("  Place TrialBal_20260815_Final.xlsx in scripts/rhhf-rebuild/source-data/")
        return []

    print(f"  Reading TB: {TB_PATH.name} …")
    # Skip the 9 title/header rows; use fixed column positions
    df = pd.read_excel(TB_PATH, header=None, dtype=str, skiprows=9)

    explicit_names_lower = {row[0].lower() for row in EXPLICIT_BALANCES}
    known_lower = {n.lower() for n in known_ledger_names}
    results: list[tuple[str, Decimal, str]] = []
    skipped_unknown = []

    for _, row in df.iterrows():
        tally_name = str(row.iloc[0]).strip() if pd.notna(row.iloc[0]) else ""
        if not tally_name or tally_name.lower() in ("nan", "grand total", "total", ""):
            continue

        # Column 4 is the Closing Balance — formatted as "1234.56 Dr" / "1234.56 Cr"
        parsed = parse_closing_cell(row.iloc[4]) if len(row) > 4 else None
        if parsed is None:
            continue
        closing, direction = parsed

        pramaana_name = map_tally_name(tally_name)

        # Skip items already covered by explicit balances
        if pramaana_name.lower() in explicit_names_lower:
            continue

        # Skip group-total rows (no matching ledger in Pramaana)
        if pramaana_name.lower() not in known_lower:
            skipped_unknown.append(tally_name)
            continue

        results.append((pramaana_name, closing, direction))

    if skipped_unknown:
        print(f"  Skipped {len(skipped_unknown)} unmatched TB rows (group totals / unmapped):")
        for s in skipped_unknown:
            print(f"    - {s!r}")
    print(f"  TB read: {len(results)} additional lines (not in explicit list)")
    return results


def fetch_ledger_id(name: str, company_id: str) -> Optional[str]:
    """Fetch ledger ID by exact name or ILIKE."""
    r = pramaana("ledgers").select("id,name").eq("company_id", company_id).eq("name", name).execute()
    if r.data:
        return r.data[0]["id"]
    # fuzzy fallback — avoid false matches on short names
    if len(name) > 10:
        r2 = pramaana("ledgers").select("id,name").eq("company_id", company_id)\
            .ilike("name", f"%{name}%").execute()
        if len(r2.data) == 1:
            return r2.data[0]["id"]
    return None


def ensure_ledger(name: str, company_id: str, group_hint: str) -> str:
    """Return existing ledger ID or create with a best-effort group lookup."""
    lid = fetch_ledger_id(name, company_id)
    if lid:
        return lid

    # Resolve a group
    grp_r = pm.schema("pramaana").table("ledger_groups")\
        .select("id")\
        .ilike("name", f"%{group_hint}%")\
        .execute()
    grp_id = grp_r.data[0]["id"] if grp_r.data else None

    if grp_id is None:
        raise RuntimeError(f"Cannot find ledger group matching '{group_hint}' — create '{name}' manually")

    ins = pramaana("ledgers").insert({
        "company_id":       company_id,
        "group_id":         grp_id,
        "name":             name,
        "tally_ledger_name": name,
        "is_bank_account":  False,
        "opening_balance":  0,
        "opening_dr_cr":    "Dr",
        "is_system":        False,
        "is_active":        True,
    }).execute()
    new_id = ins.data[0]["id"]
    print(f"    Created ledger: {name!r}")
    return new_id


def run_phase3():
    print("=" * 60)
    print("PHASE 3 — LOAD OPENING BALANCES (RHHF)")
    print("Opening date: 1-Aug-2026")
    print("=" * 60)

    # ── 1. Gather all balances ─────────────────────────────────────────────
    print()
    print("Step 1: Collecting opening balances…")

    # Fetch all active RHHF ledger names upfront to filter TB group-total rows
    ledger_rows = pramaana("ledgers").select("name").eq("company_id", RHHF_ID).execute()
    known_ledger_names = {r["name"] for r in ledger_rows.data}

    tb_extras = read_tb_expenses(known_ledger_names)

    all_balances = list(EXPLICIT_BALANCES) + tb_extras
    print(f"  Total lines: {len(all_balances)} "
          f"({len(EXPLICIT_BALANCES)} explicit + {len(tb_extras)} from TB)")

    # ── 2. Balance check (MANDATORY — do not skip) ─────────────────────────
    print()
    print("Step 2: Balance check (Dr = Cr)…")
    total_dr = sum(amt for _, amt, side in all_balances if side == "Dr")
    total_cr = sum(amt for _, amt, side in all_balances if side == "Cr")
    diff = total_dr - total_cr

    print(f"  Total Dr: ₹{total_dr:>15,.2f}")
    print(f"  Total Cr: ₹{total_cr:>15,.2f}")
    print(f"  Diff    : ₹{diff:>15,.2f}")

    if diff != 0:
        print()
        print("  ⚠ IMBALANCE DETECTED — NOT WRITING TO DB")
        print("  Dr ledgers:")
        for name, amt, side in all_balances:
            if side == "Dr":
                print(f"    {name:<55} Dr ₹{amt:>14,.2f}")
        print("  Cr ledgers:")
        for name, amt, side in all_balances:
            if side == "Cr":
                print(f"    {name:<55} Cr ₹{amt:>14,.2f}")
        print()
        print("  ACTION REQUIRED: Locate the missing lines in the Final TB")
        print("  and add them to EXPLICIT_BALANCES or the source-data/ TB file.")
        sys.exit(1)

    print("  ✓ BALANCED")

    # ── 3. Write opening balances to DB ───────────────────────────────────
    print()
    print("Step 3: Writing opening balances…")

    # Group hint map for auto-created ledgers
    GROUP_HINTS: dict[str, str] = {
        "Dr": "Indirect Expense",   # safe default for unknown Dr ledgers
        "Cr": "Capital",            # safe default for unknown Cr ledgers
    }

    written = 0
    errors: list[str] = []

    # Track which balances came from the TB (skip auto-create for those)
    tb_names_lower = {row[0].lower() for row in tb_extras}

    for ledger_name, amount, side in all_balances:
        try:
            lid = fetch_ledger_id(ledger_name, RHHF_ID)

            if lid is None:
                if ledger_name.lower() in tb_names_lower:
                    # TB-sourced line with no matching ledger — should not happen after
                    # the known_ledger_names filter, but guard anyway
                    print(f"    SKIP (TB, no ledger): {ledger_name!r}")
                    continue
                # EXPLICIT_BALANCES line — create with a safe default group
                print(f"    Ledger not found — creating: {ledger_name!r}")
                lid = ensure_ledger(ledger_name, RHHF_ID, GROUP_HINTS[side])

            pramaana("ledgers").update({
                "opening_balance": float(amount),
                "opening_dr_cr":   side,
            }).eq("id", lid).execute()

            written += 1
            print(f"    ✓ {side} ₹{amount:>14,.2f}  {ledger_name}")

        except Exception as ex:
            msg = f"FAILED: {ledger_name!r} — {ex}"
            errors.append(msg)
            print(f"    ✗ {msg}")

    print()
    print(f"  Written: {written}/{len(all_balances)}")
    if errors:
        print(f"  Errors ({len(errors)}):")
        for e in errors:
            print(f"    {e}")
        sys.exit(1)

    print()
    print("✓ Phase 3 complete — run phase4_verify.sql to confirm all gates pass.")


if __name__ == "__main__":
    run_phase3()
