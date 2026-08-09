#!/usr/bin/env python3
"""
tier0_rerun.py — Apply Tier 0 UTR matching to unmatched transactions.

Equivalent to running the full match engine when only Tier 0 is new:
existing Tier 1/2/3 matches are already in recon_matches and stay.
This script processes only unmatched/pending_review transactions.

USAGE:
  python scripts/tier0_rerun.py [--dry-run]
"""

import os, json, ssl, re, sys, urllib.request, urllib.error
from dotenv import load_dotenv
load_dotenv()

DRY_RUN = "--dry-run" in sys.argv

ctx = ssl.create_default_context()
PM_URL = os.environ["PM_SUPABASE_URL"]
PM_KEY = os.environ["PM_SERVICE_ROLE_KEY"]
PM_RFPL = os.environ["PM_RFPL_COMPANY_ID"]

FEDERAL_STMT = "4cf68184-7456-4a2c-a437-04886f36d314"
CANARA_STMT  = "b34b6c67-8b0c-4531-b0c7-3784062e3d9b"

def pm_get(path, range_hdr="0-4999"):
    req = urllib.request.Request(f"{PM_URL}/rest/v1/{path}",
        headers={"apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
                 "Accept-Profile": "pramaana", "Range": range_hdr})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

def pm_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{PM_URL}/rest/v1/{path}", data=data, method="POST",
        headers={"apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
                 "Accept-Profile": "pramaana", "Content-Profile": "pramaana",
                 "Content-Type": "application/json",
                 "Prefer": "return=minimal,resolution=ignore-duplicates"})
    with urllib.request.urlopen(req, context=ctx) as r: r.read()

def pm_patch(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{PM_URL}/rest/v1/{path}", data=data, method="PATCH",
        headers={"apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
                 "Accept-Profile": "pramaana", "Content-Profile": "pramaana",
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, context=ctx) as r: r.read()

def round_money(x): return round(x * 100) / 100

def extract_utr_candidates(narration):
    """9–16 char uppercase alphanumeric tokens containing ≥1 digit. Preserves leading zeros."""
    seen, result = set(), []
    for t in re.split(r"[^A-Z0-9]", narration.upper()):
        if 9 <= len(t) <= 16 and re.match(r"^[A-Z0-9]+$", t) and re.search(r"[0-9]", t):
            if t not in seen:
                seen.add(t); result.append(t)
    return result

def get_match_counts_by_method(stmt_id):
    """Fetch match counts per method for a statement, batching txn IDs."""
    txns = pm_get(f"recon_transactions?statement_id=eq.{stmt_id}&select=id,match_status")
    txn_ids = [t["id"] for t in txns]
    status_counts = {}
    for t in txns:
        s = t["match_status"]
        status_counts[s] = status_counts.get(s, 0) + 1

    # Batch the ID list to avoid URL length limits
    all_matches = []
    batch_size = 80
    for i in range(0, len(txn_ids), batch_size):
        batch = txn_ids[i:i+batch_size]
        rows = pm_get(f"recon_matches?bank_txn_id=in.({','.join(batch)})&select=bank_txn_id,match_method")
        all_matches.extend(rows)

    by_method = {}
    for m in all_matches:
        mm = m["match_method"]
        by_method[mm] = by_method.get(mm, 0) + 1

    return txns, status_counts, by_method

def run_tier0(bank_label, stmt_id, company_id):
    print(f"\n{'='*60}")
    print(f"TIER 0 — {bank_label}  stmt={stmt_id}")
    print(f"{'='*60}")

    # ── Before state ─────────────────────────────────────────────────────────
    txns, before_status, before_method = get_match_counts_by_method(stmt_id)
    total_txns = len(txns)
    before_matched = total_txns - before_status.get("unmatched", 0)
    print(f"BEFORE: {before_matched}/{total_txns} matched")
    print(f"  status: {before_status}")
    print(f"  method: {before_method}")

    # ── Load unmatched/pending_review transactions ────────────────────────────
    work_txns = [t for t in txns if t["match_status"] in ("unmatched", "pending_review")]
    print(f"\nProcessing {len(work_txns)} unmatched/pending_review transactions")

    # ── Get bank account and ledger ───────────────────────────────────────────
    stmt_row = pm_get(f"recon_statements?id=eq.{stmt_id}&select=bank_account_id")[0]
    bank_acct = pm_get(f"recon_bank_accounts?id=eq.{stmt_row['bank_account_id']}&select=id,ledger_id,bank_code")[0]
    ledger_id = bank_acct["ledger_id"]
    print(f"Bank ledger_id: {ledger_id}")

    # ── Fetch all voucher entries for this ledger (with utr_number) ───────────
    # ── Fetch UTR index: company-scoped, NOT ledger-scoped ───────────────────
    # UTRs live on vouchers; the bank-ledger entry is a secondary lookup.
    # Filtering by ledger first misses vouchers whose bank-side entry is on a
    # different ledger than the one configured in recon_bank_accounts.
    vouchers_with_utr = pm_get(
        f"vouchers?company_id=eq.{company_id}&utr_number=not.is.null"
        f"&status=eq.posted&select=id,voucher_number,utr_number,amount"
    )
    print(f"Company vouchers with UTR: {len(vouchers_with_utr)}")
    voucher_map = {v["id"]: v for v in vouchers_with_utr}

    # For each UTR voucher, find its bank-ledger Cr entry (payment side).
    # Try the recon bank ledger first; fall back to any Cr entry on any ledger.
    voucher_ids = list(voucher_map.keys())
    ve_by_voucher = {}   # voucher_id -> first Cr VE found
    for i in range(0, len(voucher_ids), 80):
        batch = voucher_ids[i:i+80]
        # Bank-ledger Cr entries (ideal)
        rows = pm_get(
            f"voucher_entries?voucher_id=in.({','.join(batch)})"
            f"&ledger_id=eq.{ledger_id}&entry_type=eq.Cr&select=id,voucher_id,entry_type,amount"
        )
        for r in rows:
            ve_by_voucher.setdefault(r["voucher_id"], r)

    # Fallback: Cr entries on any ledger for vouchers still missing
    missing_ids = [vid for vid in voucher_ids if vid not in ve_by_voucher]
    if missing_ids:
        for i in range(0, len(missing_ids), 80):
            batch = missing_ids[i:i+80]
            rows = pm_get(
                f"voucher_entries?voucher_id=in.({','.join(batch)})"
                f"&entry_type=eq.Cr&select=id,voucher_id,entry_type,amount&limit=1000"
            )
            for r in rows:
                ve_by_voucher.setdefault(r["voucher_id"], r)   # first Cr entry wins

    on_bank_ledger = sum(1 for vid in voucher_ids
                         if vid in ve_by_voucher and
                         pm_get(f"voucher_entries?id=eq.{ve_by_voucher[vid]['id']}&select=ledger_id")[0]["ledger_id"] == ledger_id
                         ) if False else "N/A (skipped for speed)"
    print(f"VEs resolved: {len(ve_by_voucher)}/{len(voucher_ids)} vouchers have a Cr entry")
    print(f"Missing (no Cr entry at all): {len(voucher_ids) - len(ve_by_voucher)}")

    # Build UTR index
    utr_index = {}
    for vid, voucher in voucher_map.items():
        ve = ve_by_voucher.get(vid)
        if not ve:
            continue
        entry = {
            "id":             ve["id"],
            "voucher_id":     vid,
            "entry_type":     ve["entry_type"],
            "amount":         ve["amount"],
            "voucher_number": voucher["voucher_number"],
            "utr_number":     voucher["utr_number"],
        }
        utr_index.setdefault(voucher["utr_number"], []).append(entry)

    print(f"UTR index: {len(utr_index)} unique UTRs")
    sample_utrs = list(utr_index.keys())[:6]
    print(f"  Sample UTRs: {sample_utrs}")
    sample_narr_rows = pm_get(
        f"recon_transactions?statement_id=eq.{stmt_id}&match_status=eq.unmatched&select=narration&limit=5"
    )
    for row in sample_narr_rows:
        toks = extract_utr_candidates(row["narration"])
        hits = [t for t in toks if t in utr_index]
        print(f"  narr_tokens={toks} hits={hits} | {row['narration'][:60]}")

    # Fetch already-matched VE IDs to avoid double-matching
    all_ve_ids = [ve["id"] for ve in ve_by_voucher.values() if ve.get("id")]
    matched_ve_ids = set()
    batch_size = 80
    for i in range(0, len(all_ve_ids), batch_size):
        batch = all_ve_ids[i:i+batch_size]
        rows = pm_get(f"recon_matches?voucher_entry_id=in.({','.join(batch)})&select=voucher_entry_id")
        for r in rows:
            if r.get("voucher_entry_id"):
                matched_ve_ids.add(r["voucher_entry_id"])

    # ── Reload full transaction details ───────────────────────────────────────
    full_txns = pm_get(
        f"recon_transactions?statement_id=eq.{stmt_id}"
        f"&match_status=in.(unmatched,pending_review)&select=*"
    )

    # ── Apply Tier 0 ─────────────────────────────────────────────────────────
    new_matches = []
    review_log = []
    matched_txn_ids = set()

    for txn in full_txns:
        txn_amount = txn.get("debit") or txn.get("credit")
        if txn_amount is None: continue
        book_side = "Cr" if txn.get("debit") is not None else "Dr"

        for utr_token in extract_utr_candidates(txn["narration"]):
            batch_ves = [
                ve for ve in utr_index.get(utr_token, [])
                if ve["id"] not in matched_ve_ids and ve["entry_type"] == book_side
            ]
            if not batch_ves: continue

            batch_sum = round_money(sum(ve["amount"] for ve in batch_ves))
            if abs(batch_sum - round_money(txn_amount)) <= 1:
                for ve in batch_ves:
                    new_matches.append({
                        "bank_txn_id":      txn["id"],
                        "voucher_id":       ve["voucher_id"],
                        "voucher_entry_id": ve["id"],
                        "match_method":     "utr",
                        "match_confidence": 100,
                        "match_reason":     f"UTR {utr_token} — {len(batch_ves)}-voucher batch ₹{batch_sum}",
                        "company_id":       company_id,
                    })
                    matched_ve_ids.add(ve["id"])
                matched_txn_ids.add(txn["id"])
                break
            else:
                review_log.append(
                    f"  [UTR-REVIEW] txn={txn['id'][:8]} utr={utr_token} "
                    f"batchVEs={len(batch_ves)} sum=₹{batch_sum} txnAmt=₹{txn_amount} "
                    f"narration={txn['narration'][:60]}"
                )

    # ── Write results ─────────────────────────────────────────────────────────
    print(f"\nTier 0 found {len(new_matches)} match rows for {len(matched_txn_ids)} transactions")

    if review_log:
        print(f"\nUTR-REVIEW entries (utr hit, amount mismatch — {len(review_log)}):")
        for r in review_log: print(r)

    if new_matches and not DRY_RUN:
        # Write in batches of 50 to avoid payload size limits
        for i in range(0, len(new_matches), 50):
            pm_post("recon_matches", new_matches[i:i+50])
        # Update statuses
        utr_txn_ids = list(matched_txn_ids)
        for i in range(0, len(utr_txn_ids), 80):
            batch = utr_txn_ids[i:i+80]
            pm_patch(f"recon_transactions?id=in.({','.join(batch)})", {"match_status": "auto_matched"})
        print("  -> Written to DB")
    elif DRY_RUN:
        print("  -> DRY RUN -- not written")

    # ── After state ───────────────────────────────────────────────────────────
    if not DRY_RUN:
        _, after_status, after_method = get_match_counts_by_method(stmt_id)
        after_matched = total_txns - after_status.get("unmatched", 0)
        print(f"\nAFTER: {after_matched}/{total_txns} matched")
        print(f"  status: {after_status}")
        print(f"  method: {after_method}")

    # ── Spot-check: show first 5 UTR matches with full chain ─────────────────
    if new_matches:
        print(f"\nSPOT-CHECK (first 5 UTR matches):")
        seen_txns = set()
        shown = 0
        for m in new_matches:
            if m["bank_txn_id"] in seen_txns or shown >= 5: continue
            seen_txns.add(m["bank_txn_id"])
            # Find narration
            txn_row = next((t for t in full_txns if t["id"] == m["bank_txn_id"]), None)
            narr = txn_row["narration"][:70] if txn_row else "?"
            amount = (txn_row.get("debit") or txn_row.get("credit")) if txn_row else "?"
            # Find voucher number from batch
            batch_rows = [x for x in new_matches if x["bank_txn_id"] == m["bank_txn_id"]]
            vnums = [br.get("match_reason", "").split("UTR ")[1].split(" —")[0] for br in batch_rows[:1]]
            utr = m["match_reason"].split("UTR ")[1].split(" —")[0] if "UTR " in m["match_reason"] else "?"
            # Find voucher number from index
            ve_entry = next((ve for ve_list in utr_index.get(utr, []) for ve in [ve_list]
                            if ve["id"] == m["voucher_entry_id"]), None) if utr != "?" else None
            vnum = ve_entry["voucher_number"] if ve_entry else [
                ve["voucher_number"] for ve_list in utr_index.get(utr, []) for ve in [ve_list]
                if ve["id"] == m["voucher_entry_id"]
            ]
            print(f"  [{shown+1}] txn={txn_row['txn_date'] if txn_row else '?'} amt=₹{amount}")
            print(f"       utr={utr}")
            vnum_list = [ve["voucher_number"] for ve in utr_index.get(utr, [])]
            print(f"       voucher(s)={vnum_list}")
            print(f"       narration={narr}")
            shown += 1

    return len(matched_txn_ids)


if __name__ == "__main__":
    print(f"{'[DRY RUN] ' if DRY_RUN else ''}Tier 0 UTR re-run")

    fed_new = run_tier0("FEDERAL", FEDERAL_STMT, PM_RFPL)
    can_new = run_tier0("CANARA",  CANARA_STMT,  PM_RFPL)

    print(f"\n{'='*60}")
    print(f"SUMMARY: Federal +{fed_new} utr matches | Canara +{can_new} utr matches")
