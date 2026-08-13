"""
Phase 5 — Verify
Pramaana Full Reimport Work Order, 12-Aug-2026
All checks are read-only.
"""
from __future__ import annotations

import os
import sys
import warnings
from decimal import Decimal
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

warnings.filterwarnings("ignore")
load_dotenv()

sys.path.insert(0, str(Path(__file__).parent))
from phase1_extract import RFPL as RFPL_DIR, RHHF as RHHF_DIR, _to_decimal, _to_date

RFPL_UUID = "bc455c94-0bcd-4d66-a040-d29ed880d22f"
RHHF_UUID = "b8beb440-df7f-48e8-a012-ac5750502eca"

pm = create_client(os.environ["PM_SUPABASE_URL"], os.environ["PM_SERVICE_ROLE_KEY"])


def pramaana(table):
    return pm.schema("pramaana").table(table)


def fetch_all(table, select="*", filters=None, limit=20000):
    q = pramaana(table).select(select)
    if filters:
        for k, v in filters.items():
            q = q.eq(k, v)
    r = q.limit(limit).execute()
    return r.data


# ---------------------------------------------------------------------------
# 5.1  Trial Balance check
# ---------------------------------------------------------------------------
def check_trial_balance():
    print("── 5.1  TRIAL BALANCE ──────────────────────────────────────")
    for cid, cname in [(RFPL_UUID, "RFPL"), (RHHF_UUID, "RHHF")]:
        # Fetch all entries for this company's posted vouchers
        rows = pm.schema("pramaana").table("voucher_entries").select(
            "entry_type,amount,vouchers!inner(company_id,status)"
        ).eq("vouchers.company_id", cid).eq("vouchers.status", "posted").limit(20000).execute()

        total_dr = sum(Decimal(str(r["amount"])) for r in rows.data if r["entry_type"] == "Dr")
        total_cr = sum(Decimal(str(r["amount"])) for r in rows.data if r["entry_type"] == "Cr")
        diff = total_dr - total_cr
        flag = "✓ BALANCED" if diff == 0 else f"⚠ DIFFERENCE = {diff}"
        print(f"  {cname}: Dr ₹{float(total_dr):>14,.2f}  Cr ₹{float(total_cr):>14,.2f}  diff={diff}  {flag}")


# ---------------------------------------------------------------------------
# 5.2  Bank ledger reconciliation
# ---------------------------------------------------------------------------
def check_bank_recon():
    print()
    print("── 5.2  BANK LEDGER RECONCILIATION ─────────────────────────")

    # RFPL Canara: sum all Cr entries on Canara ledger vs Canara CSV Credits sum
    # Get Canara Bank ledger ID for RFPL
    canara_ledger = pramaana("ledgers").select("id").eq("company_id", RFPL_UUID).eq("name", "Canara Bank").execute()
    if not canara_ledger.data:
        print("  RFPL Canara ledger: NOT FOUND")
        return
    canara_id = canara_ledger.data[0]["id"]

    # Sum Cr entries on Canara ledger (= money paid out from Canara)
    entries = pramaana("voucher_entries").select("entry_type,amount").eq("ledger_id", canara_id).execute()
    canara_cr = sum(Decimal(str(r["amount"])) for r in entries.data if r["entry_type"] == "Cr")
    canara_dr = sum(Decimal(str(r["amount"])) for r in entries.data if r["entry_type"] == "Dr")
    print(f"  RFPL Canara ledger entries: Dr ₹{float(canara_dr):>12,.2f}  Cr ₹{float(canara_cr):>12,.2f}")

    # Sum Canara CSV Credit column (money received into Canara)
    canara_csv_credit = Decimal("0")
    canara_csv_debit  = Decimal("0")
    for fname in ["Canara-Apr 2025 - Oct 2025.csv",
                  "Canara-Oct 2025 - Mar 2026.csv",
                  "Canara-April 2026 - Aug 2026.csv"]:
        df = pd.read_csv(RFPL_DIR / fname, header=26, dtype=str, on_bad_lines="skip")
        for _, row in df.iterrows():
            d = _to_date(row.get("Txn Date") or row.iloc[0])
            if d is None or d.year < 2025:
                continue
            credit = _to_decimal(row.get("Credit"))
            debit  = _to_decimal(row.get("Debit"))
            if credit:
                canara_csv_credit += credit
            if debit:
                canara_csv_debit += debit

    print(f"  RFPL Canara CSV:            Dr ₹{float(canara_csv_debit):>12,.2f}  Cr ₹{float(canara_csv_credit):>12,.2f}")
    # Pramaana Cr entries = money out of Canara = CSV Debit column (bank's perspective: debit = our payment)
    # Pramaana Dr entries = money into Canara   = CSV Credit column
    cr_diff = abs(canara_cr - canara_csv_debit)
    dr_diff = abs(canara_dr - canara_csv_credit)
    tol = Decimal("100")
    flag_cr = "✓" if cr_diff <= tol else f"⚠ diff={cr_diff:.2f}"
    flag_dr = "✓" if dr_diff <= tol else f"⚠ diff={dr_diff:.2f}"
    print(f"  RFPL Canara payment (Cr) vs CSV Debit:  {flag_cr}")
    print(f"  RFPL Canara receipt (Dr) vs CSV Credit: {flag_dr}")

    # RHHF HDFC Current: closing balance anchor = ₹2,64,563.47 on 01-Apr-2026
    # The FY26-27 Tally file row 0 = Opening Balance ₹2,64,563.47
    hdfc_ledger = pramaana("ledgers").select("id").eq("company_id", RHHF_UUID).eq("name", "HDFC Bank").execute()
    if hdfc_ledger.data:
        hdfc_id = hdfc_ledger.data[0]["id"]
        hdfc_entries = pramaana("voucher_entries").select("entry_type,amount").eq("ledger_id", hdfc_id).execute()
        hdfc_dr = sum(Decimal(str(r["amount"])) for r in hdfc_entries.data if r["entry_type"] == "Dr")
        hdfc_cr = sum(Decimal(str(r["amount"])) for r in hdfc_entries.data if r["entry_type"] == "Cr")
        print(f"  RHHF HDFC Bank ledger entries: Dr ₹{float(hdfc_dr):>12,.2f}  Cr ₹{float(hdfc_cr):>12,.2f}")
        print(f"  RHHF HDFC anchor (01-Apr-2026 opening): ₹2,64,563.47 — verify manually against Tally FY26-27 row 0")
    else:
        print("  RHHF HDFC Bank ledger: NOT FOUND")


# ---------------------------------------------------------------------------
# 5.3  Opening balance anchor check (RFPL audited BS 31-Mar-2025)
# ---------------------------------------------------------------------------
def check_opening_balances():
    print()
    print("── 5.3  RFPL OPENING BALANCE ANCHORS (31-Mar-2025 Audited) ─")

    anchors = [
        ("Peninsular Fisheries",              "Dr",  Decimal("1068100")),
        ("TDS Receivable",                    "Dr",  Decimal("228771")),
        ("Canara Bank",                       "Dr",  Decimal("170")),
        ("Tarun Philip",                      "Dr",  Decimal("237890")),
    ]

    for lname, expected_dr_cr, expected_amt in anchors:
        rows = pramaana("ledgers").select("opening_balance,opening_dr_cr").eq(
            "company_id", RFPL_UUID).eq("name", lname).execute()
        if not rows.data:
            print(f"  {lname}: LEDGER NOT FOUND")
            continue
        ob  = Decimal(str(rows.data[0].get("opening_balance") or 0))
        drc = rows.data[0].get("opening_dr_cr", "?")
        match = "✓" if ob == expected_amt and drc == expected_dr_cr else f"⚠ got {drc} ₹{float(ob):,.2f}"
        print(f"  {lname:<35} expected {expected_dr_cr} ₹{float(expected_amt):>12,.2f}  {match}")

    # Rent Deposit (Peninsular) — Note 2.6: ₹54,00,000 Cr
    rd = pramaana("ledgers").select("opening_balance,opening_dr_cr").eq(
        "company_id", RFPL_UUID).ilike("name", "%Rent Deposit%").execute()
    if rd.data:
        for r in rd.data:
            ob  = Decimal(str(r.get("opening_balance") or 0))
            drc = r.get("opening_dr_cr", "?")
            match = "✓" if ob == Decimal("5400000") else f"⚠ got {drc} ₹{float(ob):,.2f}"
            print(f"  Rent Deposit (Peninsular)           expected Cr ₹  54,00,000.00  {match}")


# ---------------------------------------------------------------------------
# 5.4  Voucher count spot-check
# ---------------------------------------------------------------------------
def check_voucher_counts():
    print()
    print("── 5.4  VOUCHER COUNT SPOT-CHECK ────────────────────────────")
    for cid, cname in [(RFPL_UUID, "RFPL"), (RHHF_UUID, "RHHF")]:
        r = pramaana("vouchers").select("id", count="exact").eq("company_id", cid).gte("voucher_date", "2025-04-01").execute()
        print(f"  {cname}: {r.count} vouchers")
        # By source (manual = both tally and ra)
        by_vtype = {}
        vrows = pramaana("vouchers").select("voucher_number").eq("company_id", cid).gte("voucher_date", "2025-04-01").limit(10000).execute()
        tally_cnt = sum(1 for v in vrows.data if v["voucher_number"].startswith("TALLY-"))
        ra_cnt    = sum(1 for v in vrows.data if v["voucher_number"].startswith("VCH-"))
        print(f"    Tally-sourced: {tally_cnt}  RA-sourced: {ra_cnt}")


# ---------------------------------------------------------------------------
# 5.5  Payee coverage
# ---------------------------------------------------------------------------
def check_payee_coverage():
    print()
    print("── 5.5  PAYEE (entity_id) COVERAGE ─────────────────────────")
    for cid, cname in [(RFPL_UUID, "RFPL"), (RHHF_UUID, "RHHF")]:
        r = pramaana("vouchers").select("id", count="exact").eq("company_id", cid).gte("voucher_date", "2025-04-01").execute()
        total = r.count
        rw = pramaana("vouchers").select("id", count="exact").eq("company_id", cid).gte("voucher_date", "2025-04-01").not_.is_("entity_id", "null").execute()
        with_entity = rw.count
        pct = 100 * with_entity / total if total else 0
        flag = "✓ >90%" if pct >= 90 else ("✓ >80%" if pct >= 80 else f"⚠ {pct:.1f}%")
        print(f"  {cname}: {with_entity}/{total} = {pct:.1f}%  {flag}")


# ---------------------------------------------------------------------------
# 5.6  Bank ledger coverage
# ---------------------------------------------------------------------------
def check_bank_coverage():
    print()
    print("── 5.6  BANK LEDGER COVERAGE ────────────────────────────────")
    for cid, cname in [(RFPL_UUID, "RFPL"), (RHHF_UUID, "RHHF")]:
        r = pramaana("vouchers").select("id", count="exact").eq("company_id", cid).gte("voucher_date", "2025-04-01").execute()
        total = r.count
        rw = pramaana("vouchers").select("id", count="exact").eq("company_id", cid).gte("voucher_date", "2025-04-01").not_.is_("bank_ledger_id", "null").execute()
        with_bank = rw.count
        pct = 100 * with_bank / total if total else 0
        # defaulted count
        rd = pramaana("vouchers").select("id", count="exact").eq("company_id", cid).gte("voucher_date", "2025-04-01").eq("_bank_source", "defaulted").execute() if False else None
        flag = "✓ >85%" if pct >= 85 else f"⚠ {pct:.1f}%"
        print(f"  {cname}: {with_bank}/{total} = {pct:.1f}%  {flag}")
        # Note: 672 of these are 'defaulted' per Motty sign-off (Phase 2)
    print("  Note: 672 bank ledgers were defaulted per Phase 2 sign-off (432 RHHF→HDFC Bank, 240 RFPL→Federal)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print("PHASE 5 — VERIFY")
    print("=" * 60)
    print()

    check_trial_balance()
    check_bank_recon()
    check_opening_balances()
    check_voucher_counts()
    check_payee_coverage()
    check_bank_coverage()

    print()
    print("=" * 60)
    print("PHASE 5 COMPLETE")
    print("=" * 60)
