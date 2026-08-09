#!/usr/bin/env python3
"""
rerun_federal_ocr.py — Re-run OCR on Federal PDFs + OCR-error files
with the updated bank-label-aware extraction prompt.

Targets:
  - Vouchers where payment_reference IS NULL and receipt attachment exists
  - Specifically those where previous attempt got "pytesseract not installed"
    or "ocr_failed" (from receipt_diagnostic.csv)
  - Companies: relish-foods (RFPL), relish-hhc (RHHF)

The prompt now looks for bank-specific labels:
  UTR | UPI Transaction ID | Transaction ID | RRN Number |
  Reference Number | IMPS Ref No | "Re NNNNN" in statement text

USAGE:
  python scripts/rerun_federal_ocr.py [--live] [--limit N]

Dry-run (default): proposes writes, prints evidence chain, applies amount guard.
Live: writes payment_reference to RA vouchers.

REQUIRES: anthropic, requests, Pillow (pip install anthropic Pillow requests)
"""
import os, re, json, ssl, sys, base64, urllib.request, urllib.error
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

LIVE  = "--live" in sys.argv
LIMIT = next((int(sys.argv[sys.argv.index("--limit") + 1])
              for i, a in enumerate(sys.argv) if a == "--limit"), 200)

ctx = ssl.create_default_context()
RA_URL = os.environ["RA_SUPABASE_URL"]
RA_KEY = os.environ["RA_SERVICE_ROLE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
RA_S3_ENDPOINT = os.environ.get("RA_S3_ENDPOINT", "")
RA_S3_ACCESS   = os.environ.get("RA_S3_ACCESS_KEY_ID", "")
RA_S3_SECRET   = os.environ.get("RA_S3_SECRET_ACCESS_KEY", "")
RA_COMPANIES   = ["relish-foods", "relish-hhc"]

# Updated bank-label-aware extraction prompt
EXTRACTION_PROMPT = """You are extracting a payment reference number from a bank payment receipt image.

Look for the reference under ANY of these labels (banks use different names):
- UTR
- UPI Transaction ID
- Transaction ID  
- RRN Number
- Reference Number
- IMPS Ref No
- Embedded in statement text as "Re NNNNNNNNN" or "Ref: NNNNNNNNN"

The reference is typically 9–16 characters, numeric or alphanumeric (e.g. 621817021557, H49023IDHR, HDFCH01127205671).

Return ONLY a JSON object: {"reference": "<value>"} or {"reference": null} if not found.
Do NOT guess or infer. If the label is present but the value is unclear, return null.
Do not return the account number, IFSC, or any other field — only the payment reference."""


def ra_get(path, range_hdr="0-999"):
    req = urllib.request.Request(f"{RA_URL}/rest/v1/{path}",
        headers={"apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}", "Range": range_hdr})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

def ra_patch(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{RA_URL}/rest/v1/{path}", data=data, method="PATCH",
        headers={"apikey": RA_KEY, "Authorization": f"Bearer {RA_KEY}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, context=ctx) as r: r.read()

def fetch_receipt_image(receipt_url: str) -> bytes | None:
    """Download from public payment_receipt_url — no signing needed."""
    try:
        with urllib.request.urlopen(receipt_url, context=ctx) as r:
            return r.read()
    except Exception as e:
        print(f"    [fetch error] {e}")
        return None

def extract_ref_via_claude(image_bytes: bytes, media_type: str = "image/jpeg") -> str | None:
    """Call Claude with the receipt. PDFs use document block + beta header; images use image block."""
    b64 = base64.standard_b64encode(image_bytes).decode()
    is_pdf = media_type == "application/pdf"
    file_block = (
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
        if is_pdf else
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}}
    )
    payload = {
        "model": "claude-opus-4-5",
        "max_tokens": 64,
        "messages": [{
            "role": "user",
            "content": [file_block, {"type": "text", "text": EXTRACTION_PROMPT}]
        }]
    }
    headers = {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    if is_pdf:
        headers["anthropic-beta"] = "pdfs-2024-09-25"
    data = json.dumps(payload).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=data, method="POST",
        headers=headers)
    try:
        with urllib.request.urlopen(req, context=ctx) as r:
            resp = json.loads(r.read())
        text = resp["content"][0]["text"].strip()
        parsed = json.loads(text)
        return parsed.get("reference") or None
    except Exception as e:
        print(f"    [claude error] {e}")
        return None

def amount_guard(proposed_ref: str, voucher_amount: float,
                 all_ra_vouchers_by_ref: dict) -> tuple[bool, str]:
    """
    Check if the proposed ref already exists on another voucher with a different amount.
    Returns (pass, reason).
    """
    existing = all_ra_vouchers_by_ref.get(proposed_ref, [])
    if not existing:
        return True, "no conflict"
    amounts = {v["amount"] for v in existing}
    if len(amounts) == 1 and abs(list(amounts)[0] - voucher_amount) < 1:
        return True, f"matches existing amount {list(amounts)[0]}"
    return False, f"ref already used with amounts {amounts} (this voucher: {voucher_amount})"


print(f"{'[DRY RUN] ' if not LIVE else '[LIVE] '}Federal PDF OCR re-run  limit={LIMIT}")
print("=" * 60)

# Load all vouchers with payment_reference for conflict checking
all_with_ref = ra_get(
    "vouchers?payment_reference=not.is.null&select=id,serial_number,company_id,amount,payment_reference&limit=5000"
)
ref_map: dict[str, list] = {}
for v in all_with_ref:
    ref_map.setdefault(v["payment_reference"], []).append(v)
print(f"Existing refs in RA: {len(ref_map)} unique, {len(all_with_ref)} total")

# Fetch vouchers with payment_receipt_url set but no payment_reference
candidates = []
for company in RA_COMPANIES:
    rows = ra_get(
        f"vouchers?company_id=eq.{company}&payment_reference=is.null"
        f"&payment_receipt_url=not.is.null"
        f"&select=id,serial_number,company_id,amount,payment_receipt_url"
        f"&limit={LIMIT}"
    )
    candidates.extend(rows)

print(f"Candidates (has receipt URL, no ref): {len(candidates)}")
print()

ok = 0; skipped_guard = 0; skipped_no_image = 0; skipped_no_ref = 0
proposals = []
# Cache downloaded images by URL — batch receipts are shared across multiple vouchers
url_cache: dict[str, bytes] = {}

for i, v in enumerate(candidates[:LIMIT]):
    print(f"[{i+1}/{min(len(candidates), LIMIT)}] {v['serial_number']}  amt={v['amount']}")
    receipt_url = v.get("payment_receipt_url") or ""
    if not receipt_url:
        skipped_no_image += 1; continue

    ext = receipt_url.rsplit(".", 1)[-1].lower().split("?")[0]
    media_type = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
                  "png": "image/png", "pdf": "application/pdf"}.get(ext, "image/png")

    # Reuse cached download for batch receipts (same URL → same image → same ref)
    if receipt_url not in url_cache:
        img = fetch_receipt_image(receipt_url)
        if not img:
            skipped_no_image += 1; continue
        url_cache[receipt_url] = img
        print(f"    downloaded {len(img)} bytes  ({ext})")
    else:
        img = url_cache[receipt_url]
        print(f"    using cached image ({ext})")

    best_ref = extract_ref_via_claude(img, media_type)
    if best_ref:
        best_ref = best_ref.strip().upper()
        # Enforce 9–16 char alphanumeric — guard against Claude returning short/wrong strings
        import re as _re
        if not _re.match(r'^[A-Z0-9]{9,16}$', best_ref):
            print(f"    rejected (format fail, len={len(best_ref)}): {best_ref!r}")
            best_ref = None
    if not best_ref:
        skipped_no_ref += 1
        print(f"    no ref extracted")
        continue

    print(f"    extracted: {best_ref!r}")
    guard_pass, guard_reason = amount_guard(best_ref, v["amount"], ref_map)
    if not guard_pass:
        skipped_guard += 1
        print(f"    AMOUNT GUARD FAIL: {guard_reason} — skipped")
        continue

    ok += 1
    proposals.append({"id": v["id"], "serial_number": v["serial_number"],
                      "ref": best_ref, "amount": v["amount"]})
    print(f"    PROPOSED: {best_ref}  ({guard_reason})")

    if LIVE:
        try:
            ra_patch(f"vouchers?id=eq.{v['id']}", {"payment_reference": best_ref})
            print(f"    WRITTEN")
        except urllib.error.HTTPError as e:
            print(f"    WRITE ERROR: {e.read().decode()[:80]}")

print()
print("=" * 60)
print(f"Proposed: {ok}  |  No ref found: {skipped_no_ref}  |  Amount guard fail: {skipped_guard}  |  No image: {skipped_no_image}")
if not LIVE:
    print(f"\n[DRY RUN] — pass --live to write {ok} payment_reference values to RA")
