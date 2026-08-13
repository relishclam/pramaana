#!/usr/bin/env python3
"""audit_codebase_state.py — Section B/C/D live queries for the PRAMAANA CODEBASE STATE AUDIT."""
import os, json, ssl, urllib.request
from dotenv import load_dotenv
load_dotenv()

PM_URL  = os.environ["PM_SUPABASE_URL"]
PM_KEY  = os.environ["PM_SERVICE_ROLE_KEY"]
RA_URL  = os.environ["RA_SUPABASE_URL"]
RA_KEY  = os.environ.get("RA_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
RFPL    = os.environ["PM_RFPL_COMPANY_ID"]
RHHF    = os.environ["PM_RHHF_COMPANY_ID"]
ctx     = ssl.create_default_context()

def pg(url, key, path, schema="pramaana"):
    req = urllib.request.Request(f"{url}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept-Profile": schema})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

def rpc(url, key, fn, body, schema="pramaana"):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{url}/rest/v1/rpc/{fn}", data=data, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "Accept-Profile": schema, "Content-Profile": schema})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

COMPANY = {RFPL: "RFPL", RHHF: "RHHF"}

print("=" * 70)
print("SECTION B — CURRENT DATA INTEGRITY (live Pramaana DB)")
print("=" * 70)

# B1: Payee completeness
print("\n--- B1: Payee completeness on posted vouchers ---")
# entity_id is the payee field
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&status=eq.posted&select=id,entity_id")
    total = len(rows)
    has_entity = sum(1 for r in rows if r.get("entity_id"))
    missing = total - has_entity
    print(f"  {label}: total_posted={total}  has_entity_id={has_entity}  missing_entity_id={missing}")

# B2: Bank ledger completeness
print("\n--- B2: Bank ledger completeness on posted vouchers ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&status=eq.posted&select=id,bank_ledger_id")
    total = len(rows)
    has_bank = sum(1 for r in rows if r.get("bank_ledger_id"))
    missing = total - has_bank
    print(f"  {label}: total_posted={total}  has_bank_ledger_id={has_bank}  missing_bank_ledger_id={missing}")

# B3: Balance integrity (Dr != Cr)
print("\n--- B3: Posted vouchers where Dr != Cr ---")
for cid, label in COMPANY.items():
    # Fetch all posted voucher IDs and their entries
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&status=eq.posted&select=id,voucher_number,voucher_date,amount")
    imbalanced = []
    for batch_start in range(0, len(rows), 100):
        batch = rows[batch_start:batch_start+100]
        ids = ",".join(r["id"] for r in batch)
        entries = pg(PM_URL, PM_KEY, f"voucher_entries?voucher_id=in.({ids})&select=voucher_id,entry_type,amount")
        totals = {}
        for e in entries:
            vid = e["voucher_id"]
            if vid not in totals: totals[vid] = {"Dr": 0, "Cr": 0}
            totals[vid][e["entry_type"]] = totals[vid].get(e["entry_type"], 0) + float(e["amount"])
        for r in batch:
            t = totals.get(r["id"], {"Dr": 0, "Cr": 0})
            if abs(t["Dr"] - t["Cr"]) >= 0.01:
                imbalanced.append(f'{r["voucher_number"]} {r["voucher_date"]} Dr={t["Dr"]:.2f} Cr={t["Cr"]:.2f}')
    if imbalanced:
        print(f"  {label}: {len(imbalanced)} IMBALANCED:")
        for i in imbalanced[:10]: print(f"    {i}")
    else:
        print(f"  {label}: ALL BALANCED")

# B4: Status breakdown
print("\n--- B4: Status breakdown, both companies ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&select=status,voucher_date,amount")
    from collections import defaultdict
    stats = defaultdict(lambda: {"count": 0, "min_date": "9999", "max_date": "0000", "sum": 0})
    for r in rows:
        s = r["status"] or "null"
        stats[s]["count"] += 1
        d = (r["voucher_date"] or "")
        if d < stats[s]["min_date"]: stats[s]["min_date"] = d
        if d > stats[s]["max_date"]: stats[s]["max_date"] = d
        stats[s]["sum"] += float(r["amount"] or 0)
    print(f"  {label}:")
    for status, v in sorted(stats.items()):
        print(f"    {status:20s} count={v['count']:5d}  {v['min_date']}→{v['max_date']}  sum=₹{v['sum']:,.2f}")

# B5: Duplicate voucher_number
print("\n--- B5: Duplicate voucher_number within company ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&select=voucher_number")
    from collections import Counter
    counts = Counter(r["voucher_number"] for r in rows if r.get("voucher_number"))
    dups = {k: v for k, v in counts.items() if v > 1}
    if dups:
        print(f"  {label}: {len(dups)} DUPLICATES: {list(dups.items())[:10]}")
    else:
        print(f"  {label}: NO DUPLICATES")

# B6: Zero/null amount
print("\n--- B6: Zero or null amount ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&select=id,amount")
    bad = [r for r in rows if not r.get("amount") or float(r["amount"]) == 0]
    print(f"  {label}: {len(bad)} zero/null-amount vouchers")

# B7: ref_document_number crosswalk
print("\n--- B7: ref_document_number crosswalk coverage ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&select=ref_document_number")
    total = len(rows)
    ra_cross = sum(1 for r in rows if (r.get("ref_document_number") or "").startswith("RA-"))
    ra_uuid  = sum(1 for r in rows if r.get("ref_document_number") and not (r.get("ref_document_number") or "").startswith("RA-"))
    no_ref   = sum(1 for r in rows if not r.get("ref_document_number"))
    print(f"  {label}: total={total}  RA-prefix={ra_cross}  raw-UUID-or-other={ra_uuid}  null={no_ref}")
    # Show sample of non-RA, non-null refs
    samples = [r["ref_document_number"] for r in rows if r.get("ref_document_number") and not r["ref_document_number"].startswith("RA-")][:3]
    if samples: print(f"    Sample non-RA refs: {samples}")

# B8: UTR coverage on posted vouchers
print("\n--- B8: UTR coverage on posted vouchers ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{cid}&status=eq.posted&select=id,utr_number")
    total = len(rows)
    has_utr = sum(1 for r in rows if r.get("utr_number"))
    pct = round(100.0 * has_utr / total, 1) if total else 0
    print(f"  {label}: total_posted={total}  has_utr={has_utr}  pct={pct}%")

print("\n" + "=" * 70)
print("SECTION C — ENTITY/LEDGER FOUNDATION")
print("=" * 70)

# C1: Opening balances
print("\n--- C1: Ledgers with opening balances ---")
for cid, label in COMPANY.items():
    rows = pg(PM_URL, PM_KEY, f"ledgers?company_id=eq.{cid}&opening_balance=not.is.null&opening_balance=neq.0&select=name,opening_dr_cr,opening_balance&order=name.asc")
    total_ob = sum(float(r["opening_balance"] or 0) for r in rows)
    print(f"  {label}: {len(rows)} ledgers with non-zero opening balance, total={total_ob:,.2f}")
    for r in rows[:20]:
        print(f"    {r['name'][:40]:40s}  {r['opening_dr_cr'] or '  '}  {float(r['opening_balance']):>14,.2f}")
    if len(rows) > 20: print(f"    ... and {len(rows)-20} more")

# C2: Pre-April 2026 RFPL vouchers (Tally import, must survive reimport)
print("\n--- C2: RFPL vouchers before 2026-04-01 (Tally import) ---")
rows = pg(PM_URL, PM_KEY, f"vouchers?company_id=eq.{RFPL}&voucher_date=lt.2026-04-01&select=id,amount,voucher_date")
total = len(rows)
total_amt = sum(float(r["amount"] or 0) for r in rows)
min_d = min((r["voucher_date"] for r in rows), default="?")
max_d = max((r["voucher_date"] for r in rows), default="?")
print(f"  count={total}  min_date={min_d}  max_date={max_d}  total_amount=₹{total_amt:,.2f}")

# C3: Master data structures
print("\n--- C3: Master data (ledger_groups, voucher_types) ---")
for cid, label in COMPANY.items():
    groups = pg(PM_URL, PM_KEY, f"ledger_groups?company_id=eq.{cid}&select=id,name,nature")
    vtypes = pg(PM_URL, PM_KEY, f"voucher_types?select=id,code,name,nature&is_active=eq.true")
    ledgers = pg(PM_URL, PM_KEY, f"ledgers?company_id=eq.{cid}&select=id")
    print(f"  {label}: ledger_groups={len(groups)}  ledgers={len(ledgers)}")
print(f"  voucher_types (shared): {len(vtypes)}: {', '.join(v['code'] for v in vtypes)}")

print("\n" + "=" * 70)
print("SECTION D — APPROVALS (RA) SOURCE DATA READINESS")
print("=" * 70)

# D1: RA payee completeness for paid/completed vouchers
print("\n--- D1: RA payee completeness (paid/completed vouchers) ---")
for ra_cid, label in [("relish-foods", "RFPL"), ("relish-hhc", "RHHF")]:
    try:
        rows = pg(RA_URL, RA_KEY, f"vouchers?company_id=eq.{ra_cid}&status=in.(paid,completed)&select=id,payee_id", schema="public")
        total = len(rows)
        has_payee = sum(1 for r in rows if r.get("payee_id"))
        missing = total - has_payee
        print(f"  {label}: total={total}  has_payee_id={has_payee}  missing_payee_id={missing}")
    except Exception as e:
        print(f"  {label}: ERROR: {e}")

# D2: RA paid_from_account values
print("\n--- D2: RA paid_from_account values (paid/completed) ---")
KNOWN_ACCOUNTS = {
    "RFPL – Canara Bank (A/C …1375)", "RFPL - Canara Bank (A/C ...1375)", "Canara Bank",
    "RFPL – Federal Bank (A/C …4513)", "RFPL - Federal Bank (A/C ...4513)", "Federal Bank",
    "ICICI - Motty Philip's A/c",
    "RHHF – HDFC Bank No-Lien Account", "RHHF - HDFC Bank No-Lien Account",
    "HDFC No-Lien", "HDFC Current",
    "Cash",
}
for ra_cid, label in [("relish-foods", "RFPL"), ("relish-hhc", "RHHF")]:
    try:
        rows = pg(RA_URL, RA_KEY, f"vouchers?company_id=eq.{ra_cid}&status=in.(paid,completed)&select=paid_from_account,payment_mode", schema="public")
        from collections import Counter
        account_counts = Counter(r.get("paid_from_account") or f'[null, mode={r.get("payment_mode")}]' for r in rows)
        print(f"  {label}:")
        for acc, cnt in sorted(account_counts.items(), key=lambda x: -x[1]):
            flag = "" if acc in KNOWN_ACCOUNTS or "null" in acc else "  *** UNMAPPED ***"
            print(f"    {cnt:5d}  {acc}{flag}")
    except Exception as e:
        print(f"  {label}: ERROR: {e}")
