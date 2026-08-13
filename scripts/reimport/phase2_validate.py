"""
Phase 2 — Validate
Pramaana Full Reimport Work Order, 12-Aug-2026
Applies all 2.1-2.5 validations against live DB.  No DB writes.
"""
from __future__ import annotations

import os
import sys
import warnings
from datetime import date
from decimal import Decimal
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from fuzzywuzzy import fuzz, process
from supabase import create_client

warnings.filterwarnings("ignore", category=UserWarning)
load_dotenv()

# Re-use Phase 1 extraction
sys.path.insert(0, str(Path(__file__).parent))
from phase1_extract import (
    Voucher, extract_rfpl, extract_rhhf,
    RFPL, RHHF, _to_decimal, _to_date,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
RFPL_UUID = "bc455c94-0bcd-4d66-a040-d29ed880d22f"
RHHF_UUID = "b8beb440-df7f-48e8-a012-ac5750502eca"

RA_URL  = os.environ["RA_SUPABASE_URL"]
RA_KEY  = os.environ["RA_SERVICE_ROLE_KEY"]
PM_URL  = os.environ["PM_SUPABASE_URL"]
PM_KEY  = os.environ["PM_SERVICE_ROLE_KEY"]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def fetch_all(client, schema, table, select="*", filters=None, limit=10000):
    q = client.schema(schema).table(table).select(select)
    if filters:
        for k, v in filters.items():
            q = q.eq(k, v)
    r = q.limit(limit).execute()
    return r.data


def fetch_all_public(client, table, select="*", filters=None, limit=10000):
    q = client.table(table).select(select)
    if filters:
        for k, v in filters.items():
            q = q.eq(k, v)
    r = q.limit(limit).execute()
    return r.data


# ---------------------------------------------------------------------------
# Load reference data from DBs
# ---------------------------------------------------------------------------
def load_reference_data():
    ra = create_client(RA_URL, RA_KEY)
    pm = create_client(PM_URL, PM_KEY)

    print("Loading RA payees…")
    # All payees: RFPL + RHHF + global
    payees_raw = fetch_all_public(ra, "payees",
        select="id,name,alias,company_id,is_global")
    # Build lookup: name/alias → id (for both companies)
    payee_by_name: dict[str, str] = {}
    payee_id_to_name: dict[str, str] = {}
    for p in payees_raw:
        payee_id_to_name[p["id"]] = p["name"]
        if p["name"]:
            payee_by_name[p["name"].strip().lower()] = p["id"]
        if p["alias"]:
            payee_by_name[p["alias"].strip().lower()] = p["id"]
    print(f"  {len(payees_raw)} payees loaded")

    print("Loading RA vouchers (paid_from_account, payee_id, UTR, serial)…")
    # Key: (serial_number, pramaana_company) — prevents RFPL/RHHF collisions on shared serials
    ra_db_vouchers: dict[tuple[str, str], dict] = {}
    for ra_company, pm_company in [("relish-foods", "RFPL"), ("relish-hhc", "RHHF")]:
        rows = fetch_all_public(ra, "vouchers",
            select="serial_number,payee_id,payment_reference,paid_from_account",
            filters={"company_id": ra_company, "status": "paid"})
        for v in rows:
            ra_db_vouchers[(v["serial_number"], pm_company)] = v
    print(f"  {len(ra_db_vouchers)} RA DB records loaded")

    print("Loading Pramaana ledgers…")
    ledgers_raw = fetch_all(pm, "pramaana", "ledgers",
        select="id,name,is_bank_account,company_id")
    # Bank ledgers by company
    bank_ledgers: dict[str, dict[str, str]] = {RFPL_UUID: {}, RHHF_UUID: {}}
    all_ledgers: dict[str, dict[str, str]] = {RFPL_UUID: {}, RHHF_UUID: {}}
    for l in ledgers_raw:
        cid = l["company_id"]
        if cid not in all_ledgers:
            continue
        all_ledgers[cid][l["name"].strip()] = l["id"]
        if l["is_bank_account"]:
            bank_ledgers[cid][l["name"].strip()] = l["id"]
    # Add Cash (not is_bank_account but used as bank ledger for cash vouchers)
    for cid in [RFPL_UUID, RHHF_UUID]:
        if "Cash" in all_ledgers[cid]:
            bank_ledgers[cid]["Cash"] = all_ledgers[cid]["Cash"]
    print(f"  RFPL bank ledgers: {list(bank_ledgers[RFPL_UUID].keys())}")
    print(f"  RHHF bank ledgers: {list(bank_ledgers[RHHF_UUID].keys())}")

    print("Loading Pramaana voucher types…")
    vtypes_raw = fetch_all(pm, "pramaana", "voucher_types", select="id,name")
    voucher_types = {v["name"]: v["id"] for v in vtypes_raw}
    print(f"  {voucher_types}")

    return payee_by_name, payee_id_to_name, ra_db_vouchers, bank_ledgers, all_ledgers, voucher_types


# ---------------------------------------------------------------------------
# Load Canara CSVs for RFPL bank-source verification
# ---------------------------------------------------------------------------
def load_canara_statements() -> list[dict]:
    rows = []
    for fname in [
        "Canara-Apr 2025 - Oct 2025.csv",
        "Canara-Oct 2025 - Mar 2026.csv",
        "Canara-April 2026 - Aug 2026.csv",
    ]:
        path = RFPL / fname
        df = pd.read_csv(path, header=26, dtype=str, on_bad_lines="skip",
                         encoding="utf-8")
        # cols: Txn Date, Value Date, Cheque No., Description, Branch Code, Debit, Credit, Balance
        for _, row in df.iterrows():
            d = _to_date(row.get("Txn Date") if "Txn Date" in row.index else row.iloc[0])
            debit  = _to_decimal(row.get("Debit",  None))
            credit = _to_decimal(row.get("Credit", None))
            if d is None or d.year < 2025:
                continue
            for amt in [x for x in [debit, credit] if x]:
                rows.append({"date": d, "amount": amt})
    return rows


def canara_has_match(canara_rows: list[dict], amt: Decimal, vdate: date) -> bool:
    for r in canara_rows:
        if abs(r["amount"] - amt) <= Decimal("1"):
            if abs((r["date"] - vdate).days) <= 3:
                return True
    return False


# ---------------------------------------------------------------------------
# 2.2 — Bank ledger resolution for a single voucher
# ---------------------------------------------------------------------------
def resolve_bank_ledger(
    v: Voucher,
    db_record: dict | None,
    bank_ledgers: dict[str, dict[str, str]],
    canara_rows: list[dict],
) -> tuple[str | None, str, str]:
    """Return (ledger_id or None, resolution_note, bank_source_tag)."""
    cid = RFPL_UUID if v.company == "RFPL" else RHHF_UUID
    bl  = bank_ledgers[cid]

    # Tally source: derive from paid_from_account (set during extraction)
    if v.source == "tally":
        acct = (v.paid_from_account or "").lower().strip()
        tally_map = {
            "canara bank":       bl.get("Canara Bank"),
            "hdfc current a/c":  bl.get("HDFC Bank"),
            "hdfc no-lien a/c":  bl.get("HDFC BANK ABM"),
            "cash":              bl.get("Cash"),
        }
        if acct in tally_map and tally_map[acct]:
            return tally_map[acct], f"tally_explicit:{acct}", "tally"
        for ledger_name, ledger_id in bl.items():
            if ledger_name.lower() in acct or acct in ledger_name.lower():
                return ledger_id, f"tally_substring:{ledger_name}", "tally"
        return None, f"UNRESOLVED_BANK (tally, acct={v.paid_from_account!r})", ""

    # RA source: use paid_from_account from RA DB record
    paid_from = (db_record or {}).get("paid_from_account") or ""

    if v.company == "RFPL":
        pf = paid_from.lower()
        if "canara" in pf or "1375" in pf:
            return bl.get("Canara Bank"), "RA_account:Canara", "resolved"
        if "federal" in pf or "4513" in pf:
            return bl.get("Federal Bank"), "RA_account:Federal", "resolved"
        if "icici" in pf or "motty" in pf:
            # ① Decision: route RFPL ICICI through Federal Bank (Motty Philip's ICICI)
            lid = bl.get("Federal Bank")
            return lid, "icici_via_motty→Federal", "icici_via_motty"
        if v.payment_mode == "cash":
            return bl.get("Cash"), "cash", "resolved"
        if canara_has_match(canara_rows, v.amount, v.voucher_date):
            return bl.get("Canara Bank"), "resolved_via_Canara_CSV", "csv_match"
        # ② Decision: RFPL null account, no Canara CSV match → Federal Bank
        lid = bl.get("Federal Bank")
        return lid, "defaulted→Federal (no account, no Canara match)", "defaulted"

    else:  # RHHF
        pf = paid_from.lower()
        if "hdfc current" in pf or ("hdfc" in pf and "no" not in pf and "abm" not in pf):
            return bl.get("HDFC Bank"), "RA_account:HDFC_Current", "resolved"
        if "no-lien" in pf or "no lien" in pf or "abm" in pf:
            return bl.get("HDFC BANK ABM"), "RA_account:HDFC_NL", "resolved"
        if "icici" in pf or "motty" in pf:
            return bl.get("ICICI Bank"), "RA_account:ICICI", "resolved"
        if v.payment_mode == "cash":
            return bl.get("Cash"), "cash", "resolved"
        # ③ Decision: RHHF null account → default HDFC Bank
        lid = bl.get("HDFC Bank")
        return lid, "defaulted→HDFC_Bank (no account)", "defaulted"


# ---------------------------------------------------------------------------
# 2.1 — Payee resolution for a single voucher
# ---------------------------------------------------------------------------
def resolve_payee(
    v: Voucher,
    db_record: dict | None,
    payee_by_name: dict[str, str],
    payee_id_to_name: dict[str, str],
    payee_names_list: list[str],
) -> tuple[str | None, str]:
    """Return (entity_id or None, resolution_note)."""

    # RA source: get payee_id directly from DB record
    if v.source == "ra" and db_record:
        pid = db_record.get("payee_id")
        if pid:
            name = payee_id_to_name.get(pid, "")
            return pid, f"ra_db_exact:{name}"
        return None, "ra_db_null_payee_id"

    # Tally source: fuzzy match payee_name against payee names
    pname = v.payee_name.strip()
    if not pname or pname.lower() in (
        "opening balance", "interest & bank charges", "(as per details)",
        "building construction", "repairs & maintenance charges",
        "subscription software", "software", "scooter", "petrol & diesel charges",
        "legal and professional fee.", "staff welfare", "miscellaneous expenses",
    ):
        return None, "tally_expense_ledger_not_a_payee"

    # Exact match
    if pname.lower() in payee_by_name:
        pid = payee_by_name[pname.lower()]
        return pid, f"exact:{pname}"

    # Fuzzy match
    if payee_names_list:
        match, score = process.extractOne(pname, payee_names_list,
                                          scorer=fuzz.token_sort_ratio)
        if score >= 85:
            pid = payee_by_name.get(match.lower()) or payee_by_name.get(match.strip().lower())
            return pid, f"fuzzy({score}%): {pname!r} → {match!r}"

    return None, f"UNRESOLVED_PAYEE:{pname}"


# ---------------------------------------------------------------------------
# Build RHHF overlap pairs table (97 potential duplicates)
# ---------------------------------------------------------------------------
def build_rhhf_overlap_pairs(rhhf_tally: list[Voucher], rhhf_ra: list[Voucher]) -> list[dict]:
    overlap_start = date(2026, 1, 1)
    overlap_end   = date(2026, 3, 31)

    tally_ov = [v for v in rhhf_tally if overlap_start <= v.voucher_date <= overlap_end]
    ra_ov    = [v for v in rhhf_ra    if overlap_start <= v.voucher_date <= overlap_end]

    pairs = []
    used_tally: set[int] = set()

    for ra_v in ra_ov:
        for i, t_v in enumerate(tally_ov):
            if i in used_tally:
                continue
            if abs(ra_v.amount - t_v.amount) > Decimal("1"):
                continue
            if abs((ra_v.voucher_date - t_v.voucher_date).days) > 3:
                continue
            used_tally.add(i)
            pairs.append({
                "date":          ra_v.voucher_date,
                "amount":        float(ra_v.amount),
                "tally_ledger":  t_v.payee_name,
                "tally_vch":     t_v.voucher_number,
                "tally_date":    t_v.voucher_date,
                "ra_payee":      ra_v.payee_name,
                "ra_serial":     ra_v.voucher_number,
                "ra_date":       ra_v.voucher_date,
                "date_diff_days": abs((ra_v.voucher_date - t_v.voucher_date).days),
            })
            break

    return pairs


# ---------------------------------------------------------------------------
# Main Phase 2 logic
# ---------------------------------------------------------------------------
def run_phase2():
    print("=" * 60)
    print("PHASE 2 — VALIDATE")
    print("=" * 60)
    print()

    # Re-run Phase 1 (read-only, fast)
    print("Re-running Phase 1 extraction…")
    rfpl_tally, rfpl_ra, _ = extract_rfpl()
    rhhf_tally, rhhf_ra, _ = extract_rhhf()
    all_vouchers = rfpl_tally + rfpl_ra + rhhf_tally + rhhf_ra
    print(f"  Total: {len(all_vouchers)} vouchers\n")

    # Load DB reference data
    payee_by_name, payee_id_to_name, ra_db_vouchers, bank_ledgers, all_ledgers, voucher_types = \
        load_reference_data()

    # Canara CSV for RFPL bank resolution
    print("Loading Canara bank statements for RFPL null-account matching…")
    canara_rows = load_canara_statements()
    print(f"  {len(canara_rows)} Canara statement rows loaded\n")

    # Payee names list for fuzzy matching
    payee_names_list = list(payee_by_name.keys())

    # -----------------------------------------------------------------------
    # Apply 2.1–2.4 to all vouchers
    # -----------------------------------------------------------------------
    results = []

    payee_exact = payee_fuzzy = payee_unresolved = 0
    payee_ra_direct = payee_ra_null = 0
    payee_tally_expense = 0
    fuzzy_list: list[tuple[str, str, str]] = []    # (company, payee_raw, match)
    unresolved_payee_list: list[tuple[str, str]] = []

    bank_resolved = bank_canara_match = bank_unresolved = 0
    unresolved_bank_list: list[tuple[str, str, str, float]] = []  # (company, vch, note, amount)

    amount_invalid = 0

    for v in all_vouchers:
        db_rec = ra_db_vouchers.get((v.voucher_number, v.company)) if v.source == "ra" else None

        # 2.3 Status
        v.status = "posted"

        # 2.4 Crosswalk: RA serial already set; enrich UTR from DB
        if v.source == "ra" and db_rec:
            v.utr_number = db_rec.get("payment_reference") or None
            # Also enrich paid_from_account from DB (not in flat file)
            if not v.paid_from_account:
                v.paid_from_account = db_rec.get("paid_from_account")

        # 2.1 Payee
        entity_id, payee_note = resolve_payee(
            v, db_rec, payee_by_name, payee_id_to_name, payee_names_list
        )
        v.payee_entity_id = entity_id

        if "ra_db_exact" in payee_note:
            payee_ra_direct += 1
        elif "ra_db_null" in payee_note:
            payee_ra_null += 1
        elif "tally_expense_ledger" in payee_note:
            payee_tally_expense += 1
        elif payee_note.startswith("exact:"):
            payee_exact += 1
        elif payee_note.startswith("fuzzy"):
            payee_fuzzy += 1
            fuzzy_list.append((v.company, v.payee_name, payee_note))
        elif "UNRESOLVED_PAYEE" in payee_note:
            payee_unresolved += 1
            unresolved_payee_list.append((v.company, v.payee_name))

        # 2.2 Bank ledger
        ledger_id, bank_note, bank_src = resolve_bank_ledger(v, db_rec, bank_ledgers, canara_rows)
        v.bank_ledger_id = ledger_id
        v.bank_source    = bank_src

        # ③ ICICI narration append (Motty's decision)
        if bank_src == "icici_via_motty":
            v.narration = (v.narration + " | Paid via Motty Philip ICICI account").strip(" |")

        if "UNRESOLVED_BANK" in bank_note:
            bank_unresolved += 1
            unresolved_bank_list.append((v.company, v.voucher_number, bank_note, float(v.amount)))
        elif "resolved_via_Canara_CSV" in bank_note:
            bank_resolved += 1
            bank_canara_match += 1
        else:
            bank_resolved += 1

        # 2.5 Amount
        if v.amount <= 0:
            amount_invalid += 1

        results.append({
            "v": v,
            "payee_note": payee_note,
            "bank_note": bank_note,
        })

    # -----------------------------------------------------------------------
    # Print validation report
    # -----------------------------------------------------------------------
    total = len(results)
    rfpl_total = sum(1 for r in results if r["v"].company == "RFPL")
    rhhf_total = sum(1 for r in results if r["v"].company == "RHHF")

    print()
    print("=" * 60)
    print("PHASE 2 VALIDATION REPORT")
    print("=" * 60)

    print(f"\nScope: {rfpl_total} RFPL + {rhhf_total} RHHF = {total} total vouchers")
    print(f"  (RHHF overlaps = 0 per Motty's instruction — all rows imported, 97 pairs flagged below)")

    # ── 2.1 Payee resolution ────────────────────────────────────────────────
    print("\n── 2.1 PAYEE RESOLUTION ──")
    print(f"  RA vouchers → entity via RA DB        : {payee_ra_direct}")
    print(f"  RA vouchers → null payee_id in RA DB  : {payee_ra_null}")
    print(f"  Tally → expense ledger (no entity)    : {payee_tally_expense}")
    print(f"  Tally → exact match on payees table   : {payee_exact}")
    print(f"  Tally → fuzzy match (≥85%)            : {payee_fuzzy}")
    print(f"  UNRESOLVED_PAYEE                      : {payee_unresolved}")
    total_resolved = payee_ra_direct + payee_exact + payee_fuzzy
    pct = 100 * total_resolved / total if total else 0
    print(f"  → Resolved: {total_resolved}/{total} ({pct:.1f}%)")

    if fuzzy_list:
        print(f"\n  Fuzzy matches ({len(fuzzy_list)}) — review recommended:")
        for company, raw, note in fuzzy_list[:30]:
            print(f"    [{company}] {raw!r}  →  {note}")
        if len(fuzzy_list) > 30:
            print(f"    ... and {len(fuzzy_list)-30} more")

    if unresolved_payee_list:
        print(f"\n  UNRESOLVED payees ({len(unresolved_payee_list)}) — will import with null entity_id:")
        seen = set()
        for company, name in unresolved_payee_list:
            key = f"[{company}] {name}"
            if key not in seen:
                seen.add(key)
                print(f"    {key}")

    # ── 2.2 Bank ledger resolution ───────────────────────────────────────────
    bank_by_src: dict[str, int] = {}
    for r in results:
        src = r["v"].bank_source or ("unresolved" if "UNRESOLVED_BANK" in r["bank_note"] else "?")
        bank_by_src[src] = bank_by_src.get(src, 0) + 1

    print("\n── 2.2 BANK LEDGER RESOLUTION ──")
    print(f"  Total resolved                       : {bank_resolved}")
    print(f"    explicitly resolved (exact account): {bank_by_src.get('resolved', 0) + bank_by_src.get('tally', 0)}")
    print(f"    resolved via Canara CSV match       : {bank_canara_match}")
    print(f"    defaulted per Motty sign-off        : {bank_by_src.get('defaulted', 0)}")
    print(f"      RHHF null → HDFC Bank             : {sum(1 for r in results if r['v'].bank_source=='defaulted' and r['v'].company=='RHHF')}")
    print(f"      RFPL null → Federal Bank          : {sum(1 for r in results if r['v'].bank_source=='defaulted' and r['v'].company=='RFPL')}")
    print(f"    ICICI via Motty → Federal Bank      : {bank_by_src.get('icici_via_motty', 0)}")
    print(f"  UNRESOLVED_BANK (remaining)          : {bank_unresolved}")
    pct_bank = 100 * bank_resolved / total if total else 0
    print(f"  → Coverage: {bank_resolved}/{total} ({pct_bank:.1f}%)")

    if unresolved_bank_list:
        print(f"\n  Remaining UNRESOLVED_BANK ({len(unresolved_bank_list)}):")
        for company, vch, note, amt in unresolved_bank_list[:10]:
            print(f"    [{company}] {vch} ₹{amt:,.2f} — {note}")

    # ── 2.3 Status ───────────────────────────────────────────────────────────
    print("\n── 2.3 STATUS ──")
    print(f"  All {total} vouchers → status='posted'  ✓")

    # ── 2.4 Crosswalk ────────────────────────────────────────────────────────
    print("\n── 2.4 CROSSWALK (ref_document_number) ──")
    ra_with_serial  = sum(1 for r in results if r["v"].source == "ra" and r["v"].ra_serial)
    ra_without_serial = sum(1 for r in results if r["v"].source == "ra" and not r["v"].ra_serial)
    utr_count = sum(1 for r in results if r["v"].utr_number)
    print(f"  RA vouchers with serial (→ 'RA-NNNNN') : {ra_with_serial}")
    print(f"  RA vouchers without serial (unexpected): {ra_without_serial}")
    print(f"  Vouchers with UTR populated             : {utr_count}")

    # ── 2.5 Amount validation ────────────────────────────────────────────────
    print("\n── 2.5 AMOUNT VALIDATION ──")
    print(f"  amount ≤ 0 (invalid)                   : {amount_invalid}")
    rfpl_sum = sum(r["v"].amount for r in results if r["v"].company == "RFPL")
    rhhf_sum = sum(r["v"].amount for r in results if r["v"].company == "RHHF")
    print(f"  RFPL total value                        : ₹{float(rfpl_sum):>14,.2f}")
    print(f"  RHHF total value                        : ₹{float(rhhf_sum):>14,.2f}")
    print(f"  Grand total                             : ₹{float(rfpl_sum+rhhf_sum):>14,.2f}")

    # Split by source for sanity
    rfpl_tally_sum = sum(r["v"].amount for r in results if r["v"].company == "RFPL" and r["v"].source == "tally")
    rfpl_ra_sum    = sum(r["v"].amount for r in results if r["v"].company == "RFPL" and r["v"].source == "ra")
    rhhf_tally_sum = sum(r["v"].amount for r in results if r["v"].company == "RHHF" and r["v"].source == "tally")
    rhhf_ra_sum    = sum(r["v"].amount for r in results if r["v"].company == "RHHF" and r["v"].source == "ra")
    print(f"  RFPL: Tally ₹{float(rfpl_tally_sum):>12,.2f}  |  RA ₹{float(rfpl_ra_sum):>12,.2f}")
    print(f"  RHHF: Tally ₹{float(rhhf_tally_sum):>12,.2f}  |  RA ₹{float(rhhf_ra_sum):>12,.2f}")

    # ── RHHF Overlap Pairs ───────────────────────────────────────────────────
    print("\n── RHHF OVERLAP PAIRS (97 flagged — manual review required) ──")
    print("  All rows will be imported. Review list below before Phase 4.")
    print("  Confirm each pair: if same transaction → drop Tally row; if different → keep both.")
    print()
    overlap_pairs = build_rhhf_overlap_pairs(rhhf_tally, rhhf_ra)
    print(f"  {'DATE':<12} {'AMOUNT':>10}  {'T-DATE':<12} {'TALLY LEDGER':<35} {'RA DATE':<12} {'RA PAYEE':<35} {'ΔDays'}")
    print("  " + "-"*140)
    for p in overlap_pairs:
        print(
            f"  {str(p['ra_date']):<12} "
            f"₹{p['amount']:>9,.2f}  "
            f"{str(p['tally_date']):<12} "
            f"{p['tally_ledger'][:34]:<35} "
            f"{str(p['ra_date']):<12} "
            f"{p['ra_payee'][:34]:<35} "
            f"{p['date_diff_days']}"
        )

    # ── Final summary ─────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("PHASE 2 SUMMARY")
    print("=" * 60)
    print(f"\nTotal vouchers ready for Phase 3: {total}")
    print(f"  Entity coverage   : {total_resolved}/{total} ({pct:.1f}%)  {'✓ >90%' if pct>=90 else '⚠ <90%'}")
    print(f"  Bank ledger cov.  : {bank_resolved}/{total} ({pct_bank:.1f}%)  {'✓ >85%' if pct_bank>=85 else '⚠ <85%'}")
    print(f"  Amount invalid    : {amount_invalid}  {'✓' if amount_invalid==0 else '⚠'}")
    print(f"  RHHF overlap pairs: {len(overlap_pairs)} pending manual review")
    print()
    if payee_unresolved > 0:
        print(f"⚠  {payee_unresolved} unresolved payees — will import with null entity_id")
    if bank_unresolved > 0:
        print(f"⚠  {bank_unresolved} unresolved bank ledgers — will import with null bank_ledger_id")
    print()
    print("Phase 2 complete. Awaiting sign-off before Phase 3.")
    return results, overlap_pairs


if __name__ == "__main__":
    run_phase2()
