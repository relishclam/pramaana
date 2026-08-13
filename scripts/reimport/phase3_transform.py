"""
Phase 3 — Transform
Pramaana Full Reimport Work Order, 12-Aug-2026
Builds final insert payload.  No DB writes.
"""
from __future__ import annotations

import sys
import uuid
import warnings
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Optional

import pandas as pd
from fuzzywuzzy import process, fuzz

warnings.filterwarnings("ignore", category=UserWarning)
sys.path.insert(0, str(Path(__file__).parent))
from phase2_validate import run_phase2

# ---------------------------------------------------------------------------
# Constants (repeated here for self-containment)
# ---------------------------------------------------------------------------
RFPL_UUID = "bc455c94-0bcd-4d66-a040-d29ed880d22f"
RHHF_UUID = "b8beb440-df7f-48e8-a012-ac5750502eca"
MIGRATION_USER = "8ff1fb6d-30c4-407b-a951-bab1aab37b6d"

# ---------------------------------------------------------------------------
# HOA → Pramaana ledger name maps (keyed by (head_of_account, sub_head))
# Sub-head "" means "any / unspecified sub-head" as fallback.
# ---------------------------------------------------------------------------
RFPL_HOA_MAP: dict[tuple[str, str], str] = {
    ("Air Conditioner", ""):                                   "Electrical Equipment",
    ("Building Construction", ""):                             "Building Construction",
    ("Computer & Peripherals", ""):                            "Office Equipment",
    ("Electricity Charges paid", ""):                          "Electricity Charges",
    ("Fuel Expenses", ""):                                     "Petrol & Diesel Charges",
    ("Loan Repayment", ""):                                    "Tarun Philip",
    ("Loan Repayment", "Education Loan EMI"):                  "Tarun Philip",
    ("Loans & Advances", ""):                                  "Salary Advance",
    ("Loans & Advances", "Staff Loans"):                       "Salary Advance",
    ("Maintenance & Repairs", ""):                             "Repairs & Maintainence",
    ("Maintenance & Repairs", "Labour Charges - Plumbing"):    "Repairs & Maintainence",
    ("Maintenance & Repairs", "Refrigeration Installation Charges"): "Repairs & Maintainence",
    ("Maintenance & Repairs", "Refrigeration Service Charges"): "Repairs & Maintainence",
    ("Motty Current Account", ""):                             "Motty Philip",
    ("Office Expenses", ""):                                   "Office Expenses",
    ("Office Expenses", "Stationery"):                         "Printing and Stationary",
    ("Office Supplies", ""):                                   "Office Expenses",
    ("Printing & Stationery", ""):                             "Printing and Stationary",
    ("Professional Fees", ""):                                 "Professional Charges",
    ("Professional Fees", "Auditing Fees"):                    "Audit Fee",
    ("Rent", ""):                                              "Office Rent",
    ("Repairs & Maintenance", ""):                             "Repairs & Maintainence",
    ("Repairs & Maintenance", "Premises"):                     "Repairs & Maintainence",
    ("Repairs & Maintenance", "Refrigeration Installation Charges"): "Repairs & Maintainence",
    ("Repairs & Maintenance", "Refrigeration Service Charges"): "Repairs & Maintainence",
    ("Salaries & Wages", ""):                                  "Salary",
    ("Service Charges", ""):                                   "Professional Charges",
    ("Subscriptions", ""):                                     "Subscriptions and Periodicals",
    ("Subscriptions", "Membership Fee"):                       "Subscriptions and Periodicals",
    ("Subscriptions", "News Papper"):                          "Subscriptions and Periodicals",
    ("Transportation & Freight", ""):                          "Petrol & Diesel Charges",
    ("Transportation & Freight", "Equipment Hire"):            "Repairs & Maintainence",
    ("Travelling Expenses", ""):                               "Travelling Expense",
}

RHHF_HOA_MAP: dict[tuple[str, str], str] = {
    ("Building Construction", ""):                             "Building Construction",
    ("Capital Expenditure", ""):                               "Building Construction",
    ("Capital Expenditure", "Machinery Installation"):         "Diesel Generator",
    ("Capital Expenditure", "Machinery Purchase"):             "Diesel Generator",
    ("Capital Expenditure", "Plumbing Items"):                 "Building Construction",
    ("Computer & Peripherals", ""):                            "Computer",
    ("Computer & Peripherals", "Service Charge for Changing Modem"): "Computer",
    ("Electricity Charges paid", ""):                          "Electricity Charges Paid",
    ("Fuel Expenses", ""):                                     "Petrol & Diesel Charges",
    ("KWA - Pannavally Site", ""):                             "Suspense",
    ("Legal Fees", ""):                                        "Legal and Professional Fee.",
    ("Loan Repayment", ""):                                    "Interest on Loan",
    ("Loans & Advances", ""):                                  "Rent Advance",
    ("Loans & Advances", "Staff Loans"):                       "Balachandran - Staff",
    ("Maintenance & Repairs", ""):                             "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Labour Charges Carpenter"):     "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Labour Charges Civil"):         "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Labour Charges Electrical"):    "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Labour Charges-Plumbing"):      "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Computer Service Charges (Office)"): "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Electrical"):                   "Repairs & Maintenance Charges",
    ("Maintenance & Repairs", "Vehicle Maintenance"):          "Vehicle Expenses",
    ("Miscellaneous Expenses", ""):                            "Miscellaneous Expenses",
    ("Miscellaneous Expenses", "Compliance - Haritha Karma Sena"): "Miscellaneous Expenses",
    ("Office Expenses", ""):                                   "Office Expense",
    ("Petrol & Diesel Charges", ""):                           "Petrol & Diesel Charges",
    ("Postage & Courier Charges", ""):                         "Postage & Courier Charges",
    ("Printing & Stationery", ""):                             "Printing & Stationery Expense",
    ("Professional Fees", ""):                                 "Professional Fees",
    ("Professional Fees", "Auditing Fees"):                    "Auditing Fee Paid",
    ("Provision for staff", ""):                               "Staff Welfare",
    ("Provision for staff", "Food Expenses"):                  "Staff Welfare",
    ("Provision for staff", "Utensils"):                       "Staff Welfare",
    ("Rates & Taxes", ""):                                     "Rates & Taxes",
    ("Rent", ""):                                              "Rent Paid",
    ("Rent", "House Rent Panavally"):                          "Rent Paid",
    ("Rent", "House Rent Staff Quarters-  Panavally"):         "Rent Paid",
    ("Rent", "Office-Alappuzha"):                              "Rent Paid",
    ("Repairs & Maintenance", ""):                             "Repairs & Maintenance Charges",
    ("Repairs & Maintenance", "Computer Service Charges (Office)"): "Repairs & Maintenance Charges",
    ("Repairs & Maintenance", "Electrical"):                   "Repairs & Maintenance Charges",
    ("Repairs & Maintenance", "Vehicle Maintenance"):          "Vehicle Expenses",
    ("Salaries & Wages", ""):                                  "Salaries & Allowances",
    ("Salaries & Wages", "Driver Bata"):                       "Salaries & Allowances",
    ("Staff Welfare", ""):                                     "Staff Welfare",
    ("Taxes & Duties", "Building Tax"):                        "Rates & Taxes",
    ("Transportation & Freight", ""):                          "Transportation Charge Paid",
    ("Transportation & Freight", "Building Materials"):        "Transportation Charge Paid",
    ("Transportation & Freight", "Loading & Unloading Charges"): "Transportation Charge Paid",
    ("Travelling Expenses", ""):                               "Travelling Expense",
    ("Utilities - Telephone Recharge", ""):                    "Telephone Charges Paid",
}

# Building Construction: all sub_heads go to same ledger — handled via HOA fallback


# ---------------------------------------------------------------------------
# Deduplication: identify Tally voucher_numbers to DROP (confirmed duplicates)
# ---------------------------------------------------------------------------
def build_drop_set(overlap_pairs: list[dict]) -> set[str]:
    """Return set of Tally voucher_numbers confirmed as duplicates by Motty."""
    drop: set[str] = set()
    for p in overlap_pairs:
        ra_payee  = p["ra_payee"].lower()
        t_ledger  = p["tally_ledger"].lower()
        amt       = Decimal(str(p["amount"]))
        delta     = p["date_diff_days"]
        tally_vch = p["tally_vch"]

        # Named specific confirmed duplicates
        if "drishya" in t_ledger and abs(amt - Decimal("400000")) <= 1:
            drop.add(tally_vch)
            continue
        if "interest on loan" in t_ledger and abs(amt - Decimal("52356")) <= 1:
            drop.add(tally_vch)
            continue
        if "salaries" in t_ledger and "sangeetha" in ra_payee and amt in (
            Decimal("15000"), Decimal("10000")
        ):
            drop.add(tally_vch)
            continue
        if "balachandran" in t_ledger and abs(amt - Decimal("5000")) <= 1:
            drop.add(tally_vch)
            continue

        # Robin / Anil Kumar / Varghese John — Building Construction, ΔDays 0-3
        targeted = any(n in ra_payee for n in ("robin", "anil kumar", "varghese john"))
        if targeted and "building construction" in t_ledger and delta <= 3:
            drop.add(tally_vch)

    return drop


# ---------------------------------------------------------------------------
# Expense ledger resolution
# ---------------------------------------------------------------------------
def resolve_expense_ledger(
    v,
    all_ledgers: dict[str, dict[str, str]],
    suspense_id: str,
    _cache: dict = {},
) -> tuple[str, str]:
    """Return (ledger_id, note). Falls back to Suspense if unresolvable."""
    cid   = RFPL_UUID if v.company == "RFPL" else RHHF_UUID
    ldgrs = all_ledgers[cid]      # name → id
    hoa   = (v.head_of_account or "").strip()
    sub   = (v.sub_head or "").strip()
    hoa_map = RFPL_HOA_MAP if v.company == "RFPL" else RHHF_HOA_MAP

    # For Tally: head_of_account contains the Tally Vch Type (Payment/Receipt/Journal)
    # and payee_name contains the actual expense account name.
    # Use payee_name as the ledger key for Tally rows.
    if v.source == "tally":
        pname = v.payee_name.strip()
        if pname in ldgrs:
            return ldgrs[pname], f"tally_exact:{pname}"
        # Fuzzy match
        cache_key = (v.company, "tally", pname)
        if cache_key not in _cache:
            names = list(ldgrs.keys())
            if names:
                match, score = process.extractOne(pname, names, scorer=fuzz.token_sort_ratio)
                _cache[cache_key] = (match, score)
            else:
                _cache[cache_key] = ("", 0)
        match, score = _cache[cache_key]
        if score >= 80:
            return ldgrs[match], f"tally_fuzzy({score}%):{pname}→{match}"
        return suspense_id, f"SUSPENSE:tally:{pname}"

    # For RA: try explicit HOA map with sub_head, then HOA-only, then fuzzy
    # 1. Exact (HOA, sub)
    if (hoa, sub) in hoa_map:
        lname = hoa_map[(hoa, sub)]
        if lname == "Suspense":
            return suspense_id, f"SUSPENSE:hoa_map:{hoa}/{sub}"
        if lname in ldgrs:
            return ldgrs[lname], f"hoa_exact:{hoa}/{sub}→{lname}"

    # 2. HOA wildcard: all Building Construction sub-heads → Building Construction
    if hoa == "Building Construction" and "Building Construction" in ldgrs:
        return ldgrs["Building Construction"], f"hoa_bc_wildcard:{sub}"

    # 3. HOA without sub_head
    if (hoa, "") in hoa_map:
        lname = hoa_map[(hoa, "")]
        if lname == "Suspense":
            return suspense_id, f"SUSPENSE:hoa_map:{hoa}"
        if lname in ldgrs:
            return ldgrs[lname], f"hoa_fallback:{hoa}→{lname}"

    # 4. Fuzzy match on sub_head if non-empty, then HOA
    cache_key = (v.company, "ra", hoa, sub)
    if cache_key not in _cache:
        names = list(ldgrs.keys())
        search_term = sub if sub else hoa
        if names:
            match, score = process.extractOne(search_term, names, scorer=fuzz.token_sort_ratio)
            _cache[cache_key] = (match, score)
        else:
            _cache[cache_key] = ("", 0)
    match, score = _cache[cache_key]
    if score >= 80:
        return ldgrs[match], f"ra_fuzzy({score}%):{hoa}/{sub}→{match}"

    return suspense_id, f"SUSPENSE:ra_unresolved:{hoa}/{sub}"


# ---------------------------------------------------------------------------
# Voucher type resolution
# ---------------------------------------------------------------------------
TALLY_VCHTYPE_MAP = {
    "payment": "Payment",
    "receipt": "Receipt",
    "journal": "Journal",
    "contra":  "Contra",
    "purchase": "Purchase",
    "sales":   "Sales",
}

def get_voucher_type_id(v, voucher_types: dict[str, str]) -> str:
    if v.source == "ra":
        return voucher_types["Payment"]
    key = v.head_of_account.lower()
    pm_name = TALLY_VCHTYPE_MAP.get(key, "Payment")
    return voucher_types.get(pm_name, voucher_types["Payment"])


# ---------------------------------------------------------------------------
# payment_mode normalisation for Pramaana
# ---------------------------------------------------------------------------
def pramaana_payment_mode(v) -> str:
    """Map internal 'bank'/'cash' back to Pramaana display strings."""
    if v.payment_mode == "cash":
        return "Cash"
    return "Account Transfer"   # Tally bank rows; RA rows will be overridden by DB value


# ---------------------------------------------------------------------------
# Build single transform record
# ---------------------------------------------------------------------------
def build_record(
    v,
    all_ledgers: dict[str, dict[str, str]],
    voucher_types: dict[str, str],
    ra_pmode_map: dict[tuple[str, str], str],
    suspense_ids: dict[str, str],
) -> dict:
    cid = RFPL_UUID if v.company == "RFPL" else RHHF_UUID
    suspense_id = suspense_ids[cid]
    voucher_id  = str(uuid.uuid4())

    expense_id, expense_note = resolve_expense_ledger(v, all_ledgers, suspense_id)
    bank_id     = v.bank_ledger_id or suspense_id
    vtype_id    = get_voucher_type_id(v, voucher_types)

    # ref_document_number: 'RA-SERIAL' for RA, null for Tally
    ref_doc = f"RA-{v.ra_serial}" if v.ra_serial else None

    # payment_mode: use RA DB value for RA rows if available
    if v.source == "ra":
        pmode = ra_pmode_map.get((v.voucher_number, v.company), "Account Transfer")
    else:
        pmode = "Cash" if v.payment_mode == "cash" else "Account Transfer"

    # narration: combine source narration with migration tag
    narration = (v.narration or "").strip()

    # entries: Dr/Cr depend on direction
    if v.direction == "Dr":
        # Receipt: bank Dr, expense Cr
        entries = [
            {"voucher_id": voucher_id, "ledger_id": bank_id,    "entry_type": "Dr", "amount": float(v.amount), "sort_order": 1},
            {"voucher_id": voucher_id, "ledger_id": expense_id, "entry_type": "Cr", "amount": float(v.amount), "sort_order": 2},
        ]
    else:
        # Payment: expense Dr, bank Cr
        entries = [
            {"voucher_id": voucher_id, "ledger_id": expense_id, "entry_type": "Dr", "amount": float(v.amount), "sort_order": 1},
            {"voucher_id": voucher_id, "ledger_id": bank_id,    "entry_type": "Cr", "amount": float(v.amount), "sort_order": 2},
        ]

    voucher_row = {
        "id":                  voucher_id,
        "company_id":          cid,
        "voucher_type_id":     vtype_id,
        "voucher_number":      v.voucher_number,
        "voucher_date":        v.voucher_date.isoformat(),
        "narration":           narration,
        "entity_id":           v.payee_entity_id,
        "amount":              float(v.amount),
        "payment_mode":        pmode,
        "bank_ledger_id":      bank_id,
        "utr_number":          v.utr_number,
        "ref_document_number": ref_doc,
        "status":              "posted",
        "source":              v.source,
        "paid_from_account":   v.paid_from_account,
        "created_by":          MIGRATION_USER,
        # auditing fields — set to epoch; Phase 4 INSERT handles DB defaults
        # bank_source tracked separately for Phase 4 notes
        "_bank_source":        v.bank_source,
        "_expense_note":       expense_note,
    }

    return {"voucher": voucher_row, "entries": entries}


# ---------------------------------------------------------------------------
# Phase 3 main
# ---------------------------------------------------------------------------
def run_phase3():
    print("=" * 60)
    print("PHASE 3 — TRANSFORM")
    print("=" * 60)
    print()

    # Re-run Phase 2 to get validated vouchers and reference data
    print("Re-running Phase 1+2 (read-only)…")
    results, overlap_pairs = run_phase2()
    print()

    # Reference data from Phase 2 (re-fetch for type safety)
    from phase2_validate import load_reference_data
    _, _, ra_db_raw, bank_ledgers, all_ledgers, voucher_types = load_reference_data()

    # Suspense ledger IDs per company
    suspense_ids = {
        RFPL_UUID: all_ledgers[RFPL_UUID].get("Suspense Account", ""),
        RHHF_UUID: all_ledgers[RHHF_UUID].get("Suspense", ""),
    }
    print(f"  RFPL Suspense ledger id: {suspense_ids[RFPL_UUID]}")
    print(f"  RHHF Suspense ledger id: {suspense_ids[RHHF_UUID]}")

    # RA payment_mode map: (serial, company) → original mode string
    from os import environ
    from dotenv import load_dotenv
    from supabase import create_client
    load_dotenv()
    ra_client = create_client(environ["RA_SUPABASE_URL"], environ["RA_SERVICE_ROLE_KEY"])
    ra_pmode_map: dict[tuple[str, str], str] = {}
    for ra_cid, pm_cid in [("relish-foods", "RFPL"), ("relish-hhc", "RHHF")]:
        rows = ra_client.table("vouchers").select(
            "serial_number,payment_mode"
        ).eq("company_id", ra_cid).eq("status", "paid").limit(10000).execute()
        for r in rows.data:
            ra_pmode_map[(r["serial_number"], pm_cid)] = r["payment_mode"] or "Account Transfer"
    print(f"  RA payment_mode map: {len(ra_pmode_map)} entries")

    # ── Deduplication ─────────────────────────────────────────────────────────
    drop_tally_vchs = build_drop_set(overlap_pairs)
    print(f"\n  Dropping {len(drop_tally_vchs)} confirmed duplicate Tally rows:")
    for vch in sorted(drop_tally_vchs):
        print(f"    {vch}")

    # Filter vouchers
    all_validated = [r["v"] for r in results]
    kept = [v for v in all_validated if not (
        v.source == "tally" and v.company == "RHHF" and v.voucher_number in drop_tally_vchs
    )]
    dropped = len(all_validated) - len(kept)
    print(f"\n  After deduplication: {len(kept)} vouchers (dropped {dropped})")
    rfpl_n = sum(1 for v in kept if v.company == "RFPL")
    rhhf_n = sum(1 for v in kept if v.company == "RHHF")
    print(f"    RFPL: {rfpl_n}  |  RHHF: {rhhf_n}")

    # ── Build transform payload ────────────────────────────────────────────────
    print("\nBuilding transform payload…")
    payload: list[dict] = []
    suspense_count = 0

    for v in kept:
        rec = build_record(v, all_ledgers, voucher_types, ra_pmode_map, suspense_ids)
        if "SUSPENSE" in rec["voucher"]["_expense_note"]:
            suspense_count += 1
        payload.append(rec)

    print(f"  Built {len(payload)} voucher records")
    print(f"  Expense ledger → Suspense (manual reclassification needed): {suspense_count}")

    # Expense resolution summary
    notes_summary: dict[str, int] = {}
    for rec in payload:
        key = rec["voucher"]["_expense_note"].split(":")[0]
        notes_summary[key] = notes_summary.get(key, 0) + 1
    print("\n  Expense ledger resolution breakdown:")
    for k, cnt in sorted(notes_summary.items(), key=lambda x: -x[1]):
        print(f"    {k}: {cnt}")

    # ── First 10 rows preview ──────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("FIRST 10 ROWS OF TRANSFORM PAYLOAD")
    print("=" * 60)

    for i, rec in enumerate(payload[:10]):
        v_row = rec["voucher"]
        entries = rec["entries"]
        print(f"\n── Row {i+1} ──────────────────────────────────────────────")
        print(f"  id              : {v_row['id']}")
        print(f"  company         : {'RFPL' if v_row['company_id']==RFPL_UUID else 'RHHF'}")
        print(f"  voucher_number  : {v_row['voucher_number']}")
        print(f"  voucher_date    : {v_row['voucher_date']}")
        print(f"  amount          : ₹{v_row['amount']:,.2f}")
        print(f"  payment_mode    : {v_row['payment_mode']}")
        print(f"  source          : {v_row['source']}")
        print(f"  status          : {v_row['status']}")
        print(f"  entity_id       : {v_row['entity_id'] or 'null'}")
        print(f"  bank_ledger_id  : {v_row['bank_ledger_id']} ({v_row['_bank_source']})")
        print(f"  utr_number      : {v_row['utr_number'] or 'null'}")
        print(f"  ref_doc_number  : {v_row['ref_document_number'] or 'null'}")
        print(f"  narration       : {v_row['narration'][:80]}")
        print(f"  paid_from_acct  : {v_row['paid_from_account'] or 'null'}")
        for j, e in enumerate(entries, 1):
            print(f"  entry {j}         : {e['entry_type']}  ledger={e['ledger_id']}  ₹{e['amount']:,.2f}")
        print(f"  _expense_note   : {v_row['_expense_note']}")

    # ── Summary ────────────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("PHASE 3 SUMMARY")
    print("=" * 60)
    print(f"\n  Total vouchers in payload   : {len(payload)}")
    print(f"  Total voucher_entries rows  : {len(payload) * 2}  (2 per voucher)")
    print(f"  Expense → Suspense (review) : {suspense_count}")
    rfpl_total = sum(1 for r in payload if r['voucher']['company_id'] == RFPL_UUID)
    rhhf_total = sum(1 for r in payload if r['voucher']['company_id'] == RHHF_UUID)
    rfpl_val = sum(r['voucher']['amount'] for r in payload if r['voucher']['company_id'] == RFPL_UUID)
    rhhf_val = sum(r['voucher']['amount'] for r in payload if r['voucher']['company_id'] == RHHF_UUID)
    print(f"\n  RFPL: {rfpl_total} vouchers  ₹{rfpl_val:,.2f}")
    print(f"  RHHF: {rhhf_total} vouchers  ₹{rhhf_val:,.2f}")
    print(f"  Grand total: ₹{rfpl_val + rhhf_val:,.2f}")
    print()
    print("Phase 3 complete. Ready for Phase 4 — awaiting 'proceed with Phase 4 delete'.")

    return payload


if __name__ == "__main__":
    import os
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    run_phase3()
