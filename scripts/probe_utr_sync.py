#!/usr/bin/env python3
"""
probe_utr_sync.py — Task 1 probe (read-only)
Verify live schema and count matched/unmatched/ambiguous per company before syncing.

USAGE:
  python scripts/probe_utr_sync.py
"""

import os, json, ssl, urllib.request
from dotenv import load_dotenv

load_dotenv()

ctx = ssl.create_default_context()

RA_URL = os.environ["RA_SUPABASE_URL"]
RA_KEY = os.environ["RA_SERVICE_ROLE_KEY"]
# company_id values in Approvals
RA_COMPANIES = {
    "relish-foods": "RFPL",
    "relish-hhc":   "RHHF",
}

PM_URL = os.environ["PM_SUPABASE_URL"]
PM_KEY = os.environ["PM_SERVICE_ROLE_KEY"]
# company UUIDs in Pramaana — confirmed via live DB probe
# bc455c94 = RFPL (recon_statements, .env PM_RFPL_COMPANY_ID)
# b8beb440 = RHHF (has bank accounts, ledgers, but no migrated vouchers yet = expected)
PM_RFPL_ID = os.environ["PM_RFPL_COMPANY_ID"]  # bc455c94-0bcd-4d66-a040-d29ed880d22f
PM_RHHF_ID = os.environ.get("PM_RHHF_COMPANY_ID", "")

RA_TO_PM_COMPANY = {
    "relish-foods": PM_RFPL_ID,
    "relish-hhc":   PM_RHHF_ID,
}


def ra_get(path: str) -> list:
    req = urllib.request.Request(
        f"{RA_URL}/rest/v1/{path}",
        headers={"apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}"},
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())


def pm_get(path: str) -> list:
    req = urllib.request.Request(
        f"{PM_URL}/rest/v1/{path}",
        headers={
            "apikey": PM_KEY, "Authorization": f"Bearer {PM_KEY}",
            "Accept-Profile": "pramaana",
        },
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())


def ra_count(path: str) -> str:
    req = urllib.request.Request(
        f"{RA_URL}/rest/v1/{path}",
        headers={
            "apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}",
            "Prefer": "count=exact", "Range": "0-0",
        },
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return r.headers.get("Content-Range", "?")


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


# ── 1. Schema verification ────────────────────────────────────────────────────
print("=" * 60)
print("SCHEMA VERIFICATION")
print("=" * 60)

ra_sample = ra_get("vouchers?limit=1&select=*")
ra_cols = list(ra_sample[0].keys()) if ra_sample else []
print(f"RA  vouchers columns: {ra_cols}")
assert "payment_reference" in ra_cols, "MISSING: RA.payment_reference"
assert "company_id"        in ra_cols, "MISSING: RA.company_id"
assert "serial_number"     in ra_cols, "MISSING: RA.serial_number (= voucher_number)"
print("  ✓ payment_reference present")
print("  ✓ company_id present")
print("  ✓ serial_number present (RA's voucher number column)")

pm_sample = pm_get("vouchers?limit=1&select=*")
pm_cols = list(pm_sample[0].keys()) if pm_sample else []
print(f"\nPM  vouchers columns: {pm_cols}")
assert "utr_number"     in pm_cols, "MISSING: PM.utr_number"
assert "company_id"     in pm_cols, "MISSING: PM.company_id"
assert "voucher_number" in pm_cols, "MISSING: PM.voucher_number"
print("  ✓ utr_number present")
print("  ✓ company_id present")
print("  ✓ voucher_number present")

# ── 2. Totals in Approvals ────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("APPROVALS — PAYMENT_REFERENCE COUNTS")
print("=" * 60)

for ra_cid, label in RA_COMPANIES.items():
    total = ra_count(f"vouchers?company_id=eq.{ra_cid}&select=id")
    with_ref = ra_count(f"vouchers?company_id=eq.{ra_cid}&payment_reference=not.is.null&select=id")
    print(f"  {label} ({ra_cid}): total={total}  with_payment_reference={with_ref}")

# ── 3. Per-company match probe ────────────────────────────────────────────────
print("\n" + "=" * 60)
print("MATCH PROBE (RA → PM by company + voucher_number)")
print("=" * 60)
print("  NOTE: RA.serial_number  == PM.voucher_number")
print("  NOTE: RA.payment_reference → PM.utr_number (deliberate naming difference)\n")

for ra_cid, label in RA_COMPANIES.items():
    pm_cid = RA_TO_PM_COMPANY.get(ra_cid, "")
    print(f"── {label}  RA={ra_cid}  PM={pm_cid or '(not configured)'} ──")

    # Fetch all RA vouchers with payment_reference for this company
    ra_rows = ra_get(
        f"vouchers?company_id=eq.{ra_cid}"
        f"&payment_reference=not.is.null"
        f"&select=id,serial_number,payment_reference"
    )
    print(f"  RA vouchers with payment_reference: {len(ra_rows)}")

    if not ra_rows:
        print("  → nothing to sync\n")
        continue

    if not pm_cid:
        print("  ⚠  PM company UUID not configured — all RA rows will be 'unmatched_in_pramaana'")
        print(f"  unmatched_in_pramaana: {len(ra_rows)}\n")
        continue

    # Fetch ALL PM vouchers for this company (voucher_number + utr_number)
    pm_rows = pm_get(
        f"vouchers?company_id=eq.{pm_cid}"
        f"&select=id,voucher_number,utr_number"
    )
    pm_by_vnum: dict[str, list[dict]] = {}
    for row in pm_rows:
        vn = row["voucher_number"]
        if vn:
            pm_by_vnum.setdefault(vn, []).append(row)

    matched        = 0
    unmatched_pm   = 0  # RA has ref but PM voucher doesn't exist
    ambiguous      = 0  # multiple PM vouchers share the same voucher_number
    conflict       = 0  # PM already has a DIFFERENT utr_number
    already_synced = 0  # PM already has the SAME utr_number
    would_sync     = 0  # PM utr_number is null → will be written

    for row in ra_rows:
        vn  = row["serial_number"]
        ref = str(row["payment_reference"]).strip()  # always string

        pm_matches = pm_by_vnum.get(vn, [])
        if not pm_matches:
            unmatched_pm += 1
            continue
        if len(pm_matches) > 1:
            ambiguous += 1
            continue

        matched += 1
        pm_utr = pm_matches[0]["utr_number"]
        if pm_utr is None:
            would_sync += 1
        elif pm_utr == ref:
            already_synced += 1
        else:
            conflict += 1
            print(f"    CONFLICT: {vn}  RA={ref}  PM={pm_utr}")

    print(f"  RA rows with payment_reference:  {len(ra_rows)}")
    print(f"  Matched (1:1 by voucher_number): {matched}")
    print(f"    → would write utr_number:      {would_sync}")
    print(f"    → already identical (skip):    {already_synced}")
    print(f"    → CONFLICT (skip+report):      {conflict}")
    print(f"  Unmatched in Pramaana:           {unmatched_pm}  (expected for RHHF — not migrated yet)")
    print(f"  Ambiguous (>1 PM row):           {ambiguous}")
    print()

# ── 4. Pramaana current utr_number state ─────────────────────────────────────
print("=" * 60)
print("PRAMAANA — CURRENT utr_number STATE")
print("=" * 60)
for pm_cid in [PM_RFPL_ID, PM_RHHF_ID]:
    if not pm_cid:
        continue
    label = "RFPL" if pm_cid == PM_RFPL_ID else "RHHF"
    total  = pm_count(f"vouchers?company_id=eq.{pm_cid}&select=id")
    w_utr  = pm_count(f"vouchers?company_id=eq.{pm_cid}&utr_number=not.is.null&select=id")
    print(f"  {label} ({pm_cid[:8]}): total={total}  with_utr_number={w_utr}")
