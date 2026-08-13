#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Inspect 5 sample RHHF approved-not-posted vouchers before batch-posting.
READ-ONLY — no writes performed.
"""
import os, json, ssl, urllib.request
from dotenv import load_dotenv
load_dotenv()

URL  = os.environ["PM_SUPABASE_URL"]
KEY  = os.environ["PM_SERVICE_ROLE_KEY"]
ctx  = ssl.create_default_context()

def pg(path, profile="pramaana"):
    req = urllib.request.Request(
        f"{URL}/rest/v1/{path}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                 "Accept-Profile": profile},
    )
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

def ledger_name(lid):
    if not lid:
        return "NULL"
    rows = pg(f"ledgers?id=eq.{lid}&select=id,name")
    return rows[0]["name"] if rows else lid[:16] + "..."

SAMPLES = [
    ("RHHF/PYMT/2627/0001", "b35fa626-153e-4605-93a0-51cb52710743"),
    ("RHHF/PYMT/2627/0028", "203cf347-0077-4093-8229-116c20e7b184"),
    ("RHHF/PYMT/2627/0126", "96d445b6-0cf4-448e-9f10-7917856d7b62"),
    ("RHHF/PYMT/2627/0168", "9f757a46-8924-41a2-a17a-4160248b8dcd"),
    ("RHHF/PYMT/2627/0175", "e83fc8f9-b220-4d97-bb8e-73d9f075648c"),
]

print("=" * 70)
print("RHHF approved-not-posted — 5 SAMPLE VOUCHERS (READ-ONLY CHECK)")
print("=" * 70)

for vnum, vid in SAMPLES:
    v = pg(
        f"vouchers?id=eq.{vid}"
        f"&select=voucher_number,voucher_date,amount,status,narration,"
        f"bank_ledger_id,utr_number,paid_at,paid_by,payment_mode"
    )[0]

    entries = pg(
        f"voucher_entries?voucher_id=eq.{vid}"
        f"&select=entry_type,amount,ledger_id,narration"
    )

    bank_lid  = v.get("bank_ledger_id")
    bank_name = ledger_name(bank_lid)

    total_dr = sum(e["amount"] for e in entries if e["entry_type"] == "Dr")
    total_cr = sum(e["amount"] for e in entries if e["entry_type"] == "Cr")
    balanced = "BALANCED" if abs(total_dr - total_cr) < 0.01 else "*** IMBALANCED ***"

    print(f"\n--- {vnum}  |  {v['voucher_date']}  |  amt={v['amount']:,.2f} ---")
    print(f"  status          : {v['status']}")
    print(f"  payment_mode    : {v['payment_mode']}")
    print(f"  narration       : {v['narration']}")
    print(f"  utr_number      : {v['utr_number']}")
    print(f"  paid_at         : {v['paid_at']}  paid_by={v['paid_by']}")
    print(f"  bank_ledger_id  : {bank_lid}")
    print(f"  bank_ledger_nm  : {bank_name}")
    print(f"  entries:")
    for e in entries:
        lname = ledger_name(e["ledger_id"])
        note  = f"  [{e['narration']}]" if e.get("narration") else ""
        print(f"    {e['entry_type']:2s}  {e['amount']:>12,.2f}  {lname}{note}")
    print(f"  Dr={total_dr:,.2f}  Cr={total_cr:,.2f}  -> {balanced}")

print()
