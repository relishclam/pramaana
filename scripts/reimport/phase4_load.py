"""
Phase 4 — Load  (DESTRUCTIVE)
Pramaana Full Reimport Work Order, 12-Aug-2026

Triggered only after Motty typed 'proceed with Phase 4 delete' explicitly.
"""
from __future__ import annotations

import io
import os
import sys
import uuid
import contextlib
import warnings
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

warnings.filterwarnings("ignore")
load_dotenv()
sys.path.insert(0, str(Path(__file__).parent))

RFPL_UUID = "bc455c94-0bcd-4d66-a040-d29ed880d22f"
RHHF_UUID = "b8beb440-df7f-48e8-a012-ac5750502eca"
BATCH_SIZE = 100
NOW = datetime.now(timezone.utc).isoformat()

pm = create_client(os.environ["PM_SUPABASE_URL"], os.environ["PM_SERVICE_ROLE_KEY"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def pramaana(table):
    return pm.schema("pramaana").table(table)


def fetch_ids(table, company_id):
    """Fetch all voucher IDs for a company dated >= 2025-04-01."""
    ids = []
    page_size = 1000
    offset = 0
    while True:
        r = (pramaana(table)
             .select("id")
             .eq("company_id", company_id)
             .gte("voucher_date", "2025-04-01")
             .range(offset, offset + page_size - 1)
             .execute())
        ids.extend(row["id"] for row in r.data)
        if len(r.data) < page_size:
            break
        offset += page_size
    return ids


def delete_in_batches(table, column, values, batch_size=200):
    """Delete rows where column IN values, in batches."""
    deleted = 0
    for i in range(0, len(values), batch_size):
        batch = values[i:i + batch_size]
        r = pramaana(table).delete().in_(column, batch).execute()
        deleted += len(r.data)
    return deleted


def insert_in_batches(table, rows, batch_size=BATCH_SIZE, label=""):
    """Insert rows in batches; abort on any error."""
    inserted = 0
    total = len(rows)
    for i in range(0, total, batch_size):
        batch = rows[i:i + batch_size]
        try:
            r = pramaana(table).insert(batch).execute()
            inserted += len(r.data)
        except Exception as ex:
            raise RuntimeError(
                f"INSERT failed at {label} batch {i//batch_size + 1} "
                f"(rows {i}–{i+len(batch)-1}): {ex}"
            ) from ex
        if (i // batch_size) % 5 == 0:
            pct = 100 * (i + len(batch)) / total
            print(f"    {label}: {i + len(batch)}/{total} ({pct:.0f}%)…")
    return inserted


# ---------------------------------------------------------------------------
# Clean a Phase 3 record for DB insert
# ---------------------------------------------------------------------------
def clean_voucher(rec: dict) -> dict:
    v = dict(rec["voucher"])
    # Remove internal tracking keys
    v.pop("_bank_source", None)
    v.pop("_expense_note", None)
    v["source"] = "manual"
    # Insert as draft so the entries trigger doesn't block entry INSERTs for posted vouchers
    v["status"]      = "draft"
    v["needs_approval"] = False
    v["is_suspense"]    = False
    v["currency"]       = "INR"
    v["exchange_rate"]  = 1.0
    v["posted_at"]      = NOW
    v["posted_by"]      = None
    v["created_by"]     = None
    v["paid_by"]        = None
    return v


def clean_entries(rec: dict) -> list[dict]:
    return [
        {
            "id":         str(uuid.uuid4()),
            "voucher_id": e["voucher_id"],
            "ledger_id":  e["ledger_id"],
            "entry_type": e["entry_type"],
            "amount":     e["amount"],
            "sort_order": e["sort_order"],
        }
        for e in rec["entries"]
    ]


# ---------------------------------------------------------------------------
# Main Phase 4
# ---------------------------------------------------------------------------
def run_phase4():
    print("=" * 60)
    print("PHASE 4 — LOAD  ⚠  DESTRUCTIVE")
    print("=" * 60)
    print()

    # ── Step 0: Build Phase 3 payload (suppress output) ─────────────────────
    print("Building Phase 3 payload (re-running Phases 1-3)…")
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        from phase3_transform import run_phase3
        payload = run_phase3()
    print(f"  Payload ready: {len(payload)} vouchers, {len(payload)*2} entries")

    # ── Step 1: DELETE voucher_entries (entries before vouchers — FK order) ──
    print()
    print("STEP 1 — Delete existing voucher_entries…")
    for cid, cname in [(RFPL_UUID, "RFPL"), (RHHF_UUID, "RHHF")]:
        ids = fetch_ids("vouchers", cid)
        print(f"  {cname}: {len(ids)} existing voucher IDs found")
        if ids:
            n = delete_in_batches("voucher_entries", "voucher_id", ids)
            print(f"  {cname}: deleted {n} voucher_entries rows")

    # ── Step 2: DELETE vouchers ──────────────────────────────────────────────
    print()
    print("STEP 2 — Delete existing vouchers…")
    for cid, cname in [(RFPL_UUID, "RFPL"), (RHHF_UUID, "RHHF")]:
        r = (pramaana("vouchers")
             .delete()
             .eq("company_id", cid)
             .gte("voucher_date", "2025-04-01")
             .execute())
        print(f"  {cname}: deleted {len(r.data)} vouchers")

    # ── Step 3: DELETE settlement tables ────────────────────────────────────
    print()
    print("STEP 3 — Delete settlement/recon tables…")
    for tbl in ["invoice_settlements", "recon_matches"]:
        try:
            r = pramaana(tbl).delete().neq("id", "00000000-0000-0000-0000-000000000000").execute()
            print(f"  {tbl}: deleted {len(r.data)} rows")
        except Exception as ex:
            print(f"  {tbl}: skip ({ex})")

    # ── Step 4: INSERT vouchers ──────────────────────────────────────────────
    print()
    print("STEP 4 — Insert vouchers…")
    voucher_rows = [clean_voucher(rec) for rec in payload]
    n_vouchers = insert_in_batches("vouchers", voucher_rows, BATCH_SIZE, "vouchers")
    print(f"  Inserted {n_vouchers} vouchers")

    # ── Step 5: INSERT voucher_entries ───────────────────────────────────────
    print()
    print("STEP 5 — Insert voucher_entries…")
    entry_rows = []
    for rec in payload:
        entry_rows.extend(clean_entries(rec))
    n_entries = insert_in_batches("voucher_entries", entry_rows, BATCH_SIZE * 2, "entries")
    print(f"  Inserted {n_entries} voucher_entries")

    # ── Step 5.5: Batch-update all vouchers from draft → posted ─────────────
    print()
    print("STEP 5.5 — Update vouchers draft → posted…")
    all_ids = [rec["voucher"]["id"] for rec in payload]
    updated = 0
    for i in range(0, len(all_ids), BATCH_SIZE * 2):
        batch_ids = all_ids[i:i + BATCH_SIZE * 2]
        r = pramaana("vouchers").update({"status": "posted", "posted_at": NOW}).in_("id", batch_ids).execute()
        updated += len(r.data)
    print(f"  Updated {updated}/{len(all_ids)} vouchers to status='posted'")

    # ── Step 5.5: Batch-update all vouchers from draft → posted ─────────────
    print()
    print("STEP 5.5 — Update vouchers draft → posted…")
    all_ids = [rec["voucher"]["id"] for rec in payload]
    updated = 0
    for i in range(0, len(all_ids), BATCH_SIZE * 2):
        batch_ids = all_ids[i:i + BATCH_SIZE * 2]
        r = pramaana("vouchers").update({"status": "posted", "posted_at": NOW}).in_("id", batch_ids).execute()
        updated += len(r.data)
    print(f"  Updated {updated}/{len(all_ids)} vouchers to status='posted'")

    # ── Step 6: Verification counts ─────────────────────────────────────────
    print()
    print("=" * 60)
    print("STEP 6 — POST-LOAD VERIFICATION")
    print("=" * 60)

    ok = True
    for cid, cname, expected in [
        (RFPL_UUID, "RFPL", 1501),
        (RHHF_UUID, "RHHF", 1231),
    ]:
        r = (pramaana("vouchers")
             .select("id", count="exact")
             .eq("company_id", cid)
             .gte("voucher_date", "2025-04-01")
             .execute())
        actual = r.count
        flag = "✓" if actual == expected else f"⚠ MISMATCH (expected {expected})"
        print(f"  {cname} vouchers: {actual}  {flag}")
        if actual != expected:
            ok = False

    # Check 2: zero non-posted
    r2 = (pramaana("vouchers")
          .select("id", count="exact")
          .in_("company_id", [RFPL_UUID, RHHF_UUID])
          .neq("status", "posted")
          .gte("voucher_date", "2025-04-01")
          .execute())
    non_posted = r2.count
    flag2 = "✓" if non_posted == 0 else f"⚠ {non_posted} NOT posted"
    print(f"  Vouchers with status != 'posted': {non_posted}  {flag2}")
    if non_posted != 0:
        ok = False

    # Check 3: entries = exactly 2× vouchers
    r3 = (pramaana("voucher_entries")
          .select("id", count="exact")
          .execute())
    n_entries_actual = r3.count
    expected_entries = n_vouchers * 2
    flag3 = "✓" if n_entries_actual == expected_entries else f"⚠ MISMATCH (expected {expected_entries})"
    print(f"  voucher_entries total: {n_entries_actual}  {flag3}")
    if n_entries_actual != expected_entries:
        ok = False

    print()
    if ok:
        print("All 3 checks passed. Phase 4 complete.")
        print("Ready for Phase 5 — Verify.")
    else:
        print("⚠  One or more checks FAILED. Do NOT proceed to Phase 5 until resolved.")

    return ok


if __name__ == "__main__":
    run_phase4()
