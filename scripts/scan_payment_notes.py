#!/usr/bin/env python3
"""
scan_payment_notes.py — Scan Approvals.vouchers.payment_notes for SMS-paste refs.

Looks for the pattern "Re NNNNNNNNNN" (Federal Bank SMS paste) and any other
10–14 digit numeric sequences, proposing writes to payment_reference where it
is currently null. Dry-run by default.

USAGE:
  python scripts/scan_payment_notes.py [--live]   # --live actually writes
"""
import os, re, json, ssl, sys, urllib.request, urllib.error
from dotenv import load_dotenv
load_dotenv()

LIVE = "--live" in sys.argv

ctx = ssl.create_default_context()
RA_URL = os.environ["RA_SUPABASE_URL"]
RA_KEY = os.environ["RA_SERVICE_ROLE_KEY"]

# SMS-paste ref patterns (all Federal Bank formats observed):
#   "Re 622017012558"   — explicit "Re " prefix
#   bare 10–14 digit sequence embedded in notes text
SMS_PATTERNS = [
    re.compile(r'\bRe\s+(\d{9,14})\b', re.IGNORECASE),      # "Re NNNN"
    re.compile(r'\bRRN\s*:?\s*(\d{9,14})\b', re.IGNORECASE), # "RRN: NNNN"
    re.compile(r'\bRef\s*:?\s*(\d{9,14})\b', re.IGNORECASE), # "Ref: NNNN"
    re.compile(r'\bTxn\s*ID\s*:?\s*([A-Z0-9]{9,16})\b', re.IGNORECASE),
    re.compile(r'\bTransaction\s*ID\s*:?\s*([A-Z0-9]{9,16})\b', re.IGNORECASE),
    re.compile(r'\bUTR\s*:?\s*([A-Z0-9]{9,16})\b', re.IGNORECASE),
    # bare 12-digit numeric (typical IMPS UTR) as last resort
    re.compile(r'\b(\d{12})\b'),
]

def ra_get(path, range_hdr="0-4999"):
    req = urllib.request.Request(f"{RA_URL}/rest/v1/{path}",
        headers={"apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}",
                 "Range": range_hdr})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

def ra_patch(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{RA_URL}/rest/v1/{path}", data=data, method="PATCH",
        headers={"apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, context=ctx) as r: r.read()

def extract_ref_from_notes(notes: str) -> str | None:
    """Return first match from notes, highest-priority pattern first."""
    for pat in SMS_PATTERNS:
        m = pat.search(notes)
        if m:
            return m.group(1).strip()
    return None

print(f"{'[DRY RUN] ' if not LIVE else '[LIVE] '}payment_notes scanner")
print("=" * 60)

# Fetch vouchers with payment_notes set but payment_reference null
rows = ra_get(
    "vouchers?payment_reference=is.null&payment_notes=not.is.null"
    "&select=id,serial_number,company_id,amount,payment_notes,payment_reference"
    "&limit=5000"
)
print(f"Vouchers with notes but no payment_reference: {len(rows)}")

proposals = []
for row in rows:
    notes = (row.get("payment_notes") or "").strip()
    if not notes:
        continue
    ref = extract_ref_from_notes(notes)
    if not ref:
        continue
    proposals.append({
        "id": row["id"],
        "serial_number": row["serial_number"],
        "company_id": row["company_id"],
        "amount": row["amount"],
        "notes_snippet": notes[:80],
        "proposed_ref": ref,
    })

print(f"Proposals (ref extractable from notes): {len(proposals)}")
print()
for p in proposals[:20]:
    print(f"  [{p['company_id'][:12]}] {p['serial_number']}  amt={p['amount']}")
    print(f"    notes:   {p['notes_snippet']}")
    print(f"    ref:     {p['proposed_ref']}")
    print()

if len(proposals) > 20:
    print(f"  ... and {len(proposals) - 20} more")

if LIVE and proposals:
    print(f"\nWriting {len(proposals)} payment_reference values...")
    for p in proposals:
        try:
            ra_patch(f"vouchers?id=eq.{p['id']}", {"payment_reference": p["proposed_ref"]})
            print(f"  OK  {p['serial_number']} → {p['proposed_ref']}")
        except urllib.error.HTTPError as e:
            print(f"  ERR {p['serial_number']}: {e.read().decode()[:80]}")
    print("Done.")
elif proposals:
    print(f"\n[DRY RUN] Would write {len(proposals)} payment_reference values. Pass --live to commit.")
