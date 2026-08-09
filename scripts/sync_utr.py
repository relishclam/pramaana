#!/usr/bin/env python3
"""
sync_utr.py — Task 1 UTR sync  (Approvals → Pramaana, one-way, re-runnable)
===========================================================================
Reads RA.vouchers.payment_reference for each company and writes it to
PM.pramaana.vouchers.utr_number where the current value is null or identical.

KEY NAMING:
  Approvals calls it  payment_reference
  Pramaana   calls it utr_number
  Both are TEXT; never cast to integer.

RULES:
  - Idempotent: re-running produces the same result.
  - Existing utr_number == incoming value → skip (already synced).
  - Existing utr_number ≠ incoming value  → skip + report CONFLICT, no overwrite.
  - RHHF vouchers join via ref_document_number ('RA-{serial_number}' crosswalk).
  - All string handling; no integer casts.

USAGE:
  python scripts/sync_utr.py [--dry-run]   # --dry-run reports without writing
"""

import os, json, ssl, sys, urllib.request, urllib.parse
from dotenv import load_dotenv

load_dotenv()

DRY_RUN = "--dry-run" in sys.argv

ctx = ssl.create_default_context()

RA_URL = os.environ["RA_SUPABASE_URL"]
RA_KEY = os.environ["RA_SERVICE_ROLE_KEY"]
PM_URL = os.environ["PM_SUPABASE_URL"]
PM_KEY = os.environ["PM_SERVICE_ROLE_KEY"]

PM_RFPL_ID = os.environ["PM_RFPL_COMPANY_ID"]   # bc455c94-...
PM_RHHF_ID = os.environ["PM_RHHF_COMPANY_ID"]   # b8beb440-...

# Approvals company_id → (label, Pramaana company UUID)
COMPANY_MAP = {
    "relish-foods": ("RFPL", PM_RFPL_ID),
    "relish-hhc":   ("RHHF", PM_RHHF_ID),
}


def ra_get(path: str) -> list:
    req = urllib.request.Request(
        f"{RA_URL}/rest/v1/{path}",
        headers={"apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}"},
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())


def pm_get(path: str, large_range: bool = False) -> list:
    headers = {
        "apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
        "Accept-Profile": "pramaana",
    }
    if large_range:
        headers["Range"] = "0-4999"
    req = urllib.request.Request(f"{PM_URL}/rest/v1/{path}", headers=headers)
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())


def pm_set_utr(voucher_id: str, utr: str) -> None:
    """Call pramaana.set_utr_number() RPC — bypasses posted-voucher immutability
    via a transaction-scoped session variable (migration 079)."""
    data = json.dumps({"p_id": voucher_id, "p_utr": utr}).encode()
    req = urllib.request.Request(
        f"{PM_URL}/rest/v1/rpc/set_utr_number",
        data=data, method="POST",
        headers={
            "apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
            "Content-Profile": "pramaana",
            "Content-Type": "application/json", "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        _ = r.read()


def pm_count(path: str) -> str:
    req = urllib.request.Request(
        f"{PM_URL}/rest/v1/{path}",
        headers={
            "apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
            "Accept-Profile": "pramaana",
            "Prefer": "count=exact", "Range": "0-0",
        },
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return r.headers.get("Content-Range", "?")


import time as _time
print(f"{'[DRY RUN] ' if DRY_RUN else ''}UTR Sync  {_time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime())}")
print("=" * 60)

total_written   = 0
total_skipped   = 0   # already identical
total_conflicts = 0
total_unmatched = 0
all_conflicts   = []

for ra_cid, (label, pm_cid) in COMPANY_MAP.items():
    print(f"\n── {label}  RA={ra_cid}  PM={pm_cid} ──")

    # Fetch all RA vouchers with payment_reference (string — never cast)
    ra_rows = ra_get(
        f"vouchers?company_id=eq.{ra_cid}"
        f"&payment_reference=not.is.null"
        f"&select=id,serial_number,payment_reference"
    )
    print(f"  RA with payment_reference: {len(ra_rows)}")

    if not ra_rows:
        print("  → nothing to sync")
        continue

    # Fetch all PM vouchers for this company.
    # RFPL: join key is voucher_number == serial_number (identical schemes).
    # RHHF: different numbering — PM stores 'RA-{serial_number}' in ref_document_number
    #        (crosswalk written by the migration script; confirmed live 2026-08-08).
    pm_rows = pm_get(
        f"vouchers?company_id=eq.{pm_cid}"
        f"&select=id,voucher_number,ref_document_number,utr_number"
        f"&limit=5000",
        large_range=True,
    )

    pm_by_vnum: dict[str, list[dict]] = {}   # RFPL key
    pm_by_ra:   dict[str, list[dict]] = {}   # RHHF key: 'RA-VCH-...' → row
    for row in pm_rows:
        vn  = row.get("voucher_number")
        rdn = row.get("ref_document_number") or ""
        if vn:
            pm_by_vnum.setdefault(vn, []).append(row)
        if rdn.startswith("RA-"):
            pm_by_ra.setdefault(rdn[3:], []).append(row)  # strip 'RA-' prefix

    written   = 0
    skipped   = 0
    conflicts = 0
    unmatched = 0

    for ra_row in ra_rows:
        vn  = ra_row["serial_number"]            # RA's voucher_number column
        ref = str(ra_row["payment_reference"]).strip()   # keep as string, preserve leading zeros

        # RFPL: direct voucher_number match; RHHF: crosswalk via ref_document_number
        pm_matches = pm_by_vnum.get(vn, []) or pm_by_ra.get(vn, [])
        if not pm_matches:
            unmatched += 1
            continue
        if len(pm_matches) > 1:
            print(f"  AMBIGUOUS: {vn} has {len(pm_matches)} PM rows — skipping")
            continue

        pm_row = pm_matches[0]
        pm_id  = pm_row["id"]
        pm_utr = pm_row["utr_number"]

        if pm_utr == ref:
            skipped += 1       # already synced — idempotent
            continue
        if pm_utr is not None:
            conflicts += 1
            all_conflicts.append({
                "company": label, "voucher_number": vn,
                "ra_value": ref, "pm_existing": pm_utr,
            })
            print(f"  CONFLICT: {vn}  RA={ref!r}  PM={pm_utr!r}  → skip")
            continue

        # pm_utr is null → write via RPC (migration 079) to pass the trigger gate
        if not DRY_RUN:
            pm_set_utr(pm_id, ref)
        written += 1

    print(f"  written:         {written}{' (dry run — not committed)' if DRY_RUN else ''}")
    print(f"  already synced:  {skipped}")
    print(f"  conflicts:       {conflicts}  (skipped, not overwritten)")
    print(f"  unmatched in PM: {unmatched}  (vouchers not yet in Pramaana)")
    total_written   += written
    total_skipped   += skipped
    total_conflicts += conflicts
    total_unmatched += unmatched

print("\n" + "=" * 60)
print("SUMMARY")
print(f"  Written:           {total_written}{' (dry run)' if DRY_RUN else ''}")
print(f"  Already identical: {total_skipped}")
print(f"  Conflicts:         {total_conflicts}")
print(f"  Unmatched in PM:   {total_unmatched}")

if all_conflicts:
    print("\nCONFLICT LIST:")
    for c in all_conflicts:
        print(f"  [{c['company']}] {c['voucher_number']}  RA={c['ra_value']!r}  PM={c['pm_existing']!r}")

# ── Post-sync counts ─────────────────────────────────────────────────────────
if not DRY_RUN and total_written > 0:
    print("\n" + "=" * 60)
    print("POST-SYNC utr_number COUNTS (Pramaana)")
    for pm_cid, label in [(PM_RFPL_ID, "RFPL"), (PM_RHHF_ID, "RHHF")]:
        total = pm_count(f"vouchers?company_id=eq.{pm_cid}&select=id")
        w_utr = pm_count(f"vouchers?company_id=eq.{pm_cid}&utr_number=not.is.null&select=id")
        print(f"  {label}: total={total}  with_utr_number={w_utr}")
