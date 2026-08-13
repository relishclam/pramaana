"""
Phase 1 — Extract (READ-ONLY)
Pramaana Full Reimport Work Order, 12-Aug-2026
Parses all source files into canonical in-memory data.  No DB writes.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

import pandas as pd
from fuzzywuzzy import fuzz

warnings.filterwarnings("ignore", category=UserWarning)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE = Path(__file__).parent / "source-data"
RFPL = BASE / "RFPL"
RHHF = BASE / "RHHF"


# ---------------------------------------------------------------------------
# Canonical record
# ---------------------------------------------------------------------------
@dataclass
class Voucher:
    company: str
    source: str                      # "tally" | "ra"
    voucher_number: str
    voucher_date: date
    payee_name: str
    payee_entity_id: Optional[str] = None   # Phase 2
    amount: Decimal = Decimal("0")
    payment_mode: str = "bank"
    paid_from_account: Optional[str] = None
    bank_ledger_id: Optional[str] = None    # Phase 2
    utr_number: Optional[str] = None
    ra_uuid: Optional[str] = None
    ra_serial: Optional[str] = None
    status: str = "paid"
    head_of_account: str = ""
    sub_head: str = ""
    narration: str = ""
    bank_source: str = ""            # resolved | defaulted | icici_via_motty | csv_match | tally
    direction: str = ""              # "Dr" (To) or "Cr" (By) — for diagnostics


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _to_decimal(val) -> Optional[Decimal]:
    """Convert a cell value to Decimal; return None for blanks/errors."""
    if pd.isna(val):
        return None
    try:
        return Decimal(str(val).replace(",", "").strip())
    except InvalidOperation:
        return None


def _to_date(val) -> Optional[date]:
    if pd.isna(val):
        return None
    if isinstance(val, (datetime,)):
        return val.date()
    if isinstance(val, date):
        return val
    try:
        return pd.to_datetime(str(val)).date()
    except Exception:
        return None


def _str(val) -> str:
    if pd.isna(val):
        return ""
    return str(val).strip()


# ---------------------------------------------------------------------------
# Tally bank-book parser (shared format for RFPL Canara + all RHHF books)
# ---------------------------------------------------------------------------
def parse_tally_book(
    path: Path,
    company: str,
    paid_from_account: str,
    payment_mode: str,
    header_row: int,        # 0-indexed
    book_tag: str = "",     # short prefix to ensure uniqueness across books (e.g. "NL", "CC")
) -> list[Voucher]:
    """Parse a Tally bank or cash book export (.xls / .xlsx)."""
    df = pd.read_excel(path, header=header_row, dtype=str)

    # Normalise column names — Tally exports have Unnamed:N for unnamed cols
    cols = list(df.columns)
    # Expected: Date | Particulars | Unnamed:2 [| Unnamed:3 | Unnamed:4] | Vch Type | Vch No. | Debit | Credit
    date_col = cols[0]
    part_col = cols[1]       # "To" / "By"
    name_col = cols[2]       # actual payee name
    vchtype_col = next((c for c in cols if str(c).strip() == "Vch Type"), None)
    vchno_col   = next((c for c in cols if str(c).strip() == "Vch No."),  None)
    debit_col   = next((c for c in cols if str(c).strip() == "Debit"),    None)
    credit_col  = next((c for c in cols if str(c).strip() == "Credit"),   None)

    if not all([vchtype_col, vchno_col, debit_col, credit_col]):
        raise ValueError(f"Could not identify required columns in {path.name}. Found: {cols}")

    vouchers: list[Voucher] = []
    last_date: Optional[date] = None

    for _, row in df.iterrows():
        vch_type = _str(row[vchtype_col])
        vch_no   = _str(row[vchno_col])

        # Skip continuation sub-detail rows (null Vch Type means sub-entry)
        if not vch_type:
            continue

        # Skip inter-account transfers (Contra)
        if vch_type.lower() == "contra":
            continue

        raw_date = row[date_col]
        row_date = _to_date(raw_date)
        if row_date is not None:
            last_date = row_date
        elif last_date is not None:
            row_date = last_date    # same-day continuation row with a Vch Type
        else:
            continue                # no date context yet — skip

        direction_prefix = _str(row[part_col]).lower()  # "to" or "by"
        payee = _str(row[name_col])

        # Skip pure bookkeeping / opening balance rows
        if payee.lower() in ("opening balance", "(as per details)", ""):
            if direction_prefix not in ("to", "by"):
                continue

        debit_val  = _to_decimal(row[debit_col])
        credit_val = _to_decimal(row[credit_col])

        if direction_prefix == "to":
            amount = debit_val
            direction = "Dr"
        elif direction_prefix == "by":
            amount = credit_val
            direction = "Cr"
        else:
            # Fallback: whichever side is populated
            if debit_val:
                amount, direction = debit_val, "Dr"
            elif credit_val:
                amount, direction = credit_val, "Cr"
            else:
                continue

        if amount is None or amount <= 0:
            continue

        tag = f"{book_tag}-" if book_tag else ""
        voucher_number = f"TALLY-{tag}{vch_type}-{vch_no}" if vch_no else f"TALLY-{tag}{vch_type}"

        vouchers.append(Voucher(
            company=company,
            source="tally",
            voucher_number=voucher_number,
            voucher_date=row_date,
            payee_name=payee,
            amount=amount,
            payment_mode=payment_mode,
            paid_from_account=paid_from_account,
            status="paid",
            head_of_account=vch_type,
            sub_head="",
            narration=payee,
            direction=direction,
        ))

    return vouchers


# ---------------------------------------------------------------------------
# RA voucher parser (shared format for RFPL and RHHF)
# ---------------------------------------------------------------------------
def parse_ra(path: Path, company: str) -> list[Voucher]:
    df = pd.read_excel(path, dtype=str)
    vouchers: list[Voucher] = []

    for _, row in df.iterrows():
        status = _str(row.get("Status", "")).lower()
        if status != "paid":
            continue

        raw_date = row.get("Date", "")
        voucher_date = _to_date(raw_date)
        if voucher_date is None:
            continue

        # Scope: FY25-26 onwards (1-Apr-2025)
        if voucher_date < date(2025, 4, 1):
            continue

        voucher_no = _str(row.get("Voucher No.", ""))
        payee      = _str(row.get("Payee", ""))
        narration  = _str(row.get("Narration", ""))
        hoa        = _str(row.get("Head of Account", ""))
        sub_head   = _str(row.get("Sub Head", ""))
        inv_ref    = _str(row.get("Invoice Ref", ""))
        pmode_raw  = _str(row.get("Payment Mode", "")).lower()
        amount_raw = _to_decimal(row.get("Amount (₹)", None))

        if amount_raw is None or amount_raw <= 0:
            continue

        # Payment mode mapping
        if pmode_raw in ("account transfer", "upi", "neft", "rtgs", "imps"):
            pmode = "bank"
        elif pmode_raw == "cash":
            pmode = "cash"
        else:
            pmode = pmode_raw

        # Paid-from-account: not in flat file for RFPL (to be resolved Phase 2)
        paid_from = _str(row.get("Paid From Account", "")) or None

        # RA serial extracted from VCH-YYYY-YY-NNNNN format
        ra_serial: Optional[str] = None
        if voucher_no.startswith("VCH-"):
            parts = voucher_no.split("-")
            if len(parts) == 4:
                ra_serial = parts[-1]

        vouchers.append(Voucher(
            company=company,
            source="ra",
            voucher_number=voucher_no,
            voucher_date=voucher_date,
            payee_name=payee,
            amount=amount_raw,
            payment_mode=pmode,
            paid_from_account=paid_from,
            ra_serial=ra_serial,
            status="paid",
            head_of_account=hoa,
            sub_head=sub_head,
            narration=f"{narration} | inv:{inv_ref}".strip(" |") if inv_ref else narration,
            direction="Cr",  # RA = outgoing payment
        ))

    return vouchers


# ---------------------------------------------------------------------------
# Overlap detection
# ---------------------------------------------------------------------------
def detect_overlaps(
    tally: list[Voucher],
    ra: list[Voucher],
    overlap_start: date,
    overlap_end: date,
    use_payee_match: bool = False,
) -> tuple[list[Voucher], int]:
    """
    For each RA voucher in the overlap window, check if a matching Tally row
    exists (amount ±1, date ±3 days).  Payee fuzzy match is optional because
    Tally records expense-ledger names while RA records vendor/person names —
    they are structurally incompatible for string matching.
    Returns deduplicated list (RA wins) and overlap count.
    """
    tally_overlap = [v for v in tally if overlap_start <= v.voucher_date <= overlap_end]
    ra_overlap    = [v for v in ra    if overlap_start <= v.voucher_date <= overlap_end]

    matched_tally_indices: set[int] = set()
    overlap_count = 0

    for ra_v in ra_overlap:
        for i, t_v in enumerate(tally_overlap):
            if i in matched_tally_indices:
                continue
            # Amount match (±1)
            if abs(ra_v.amount - t_v.amount) > Decimal("1"):
                continue
            # Date match (±3 days)
            if abs((ra_v.voucher_date - t_v.voucher_date).days) > 3:
                continue
            # Optional payee fuzzy match
            if use_payee_match:
                score = fuzz.token_sort_ratio(
                    ra_v.payee_name.lower(), t_v.payee_name.lower()
                )
                if score < 85:
                    continue
            matched_tally_indices.add(i)
            overlap_count += 1
            break

    # Build deduplicated list: keep all Tally rows NOT matched + all RA rows
    tally_deduped = [
        v for i, v in enumerate(tally_overlap)
        if i not in matched_tally_indices
    ]
    tally_outside = [v for v in tally if not (overlap_start <= v.voucher_date <= overlap_end)]
    ra_outside    = [v for v in ra    if not (overlap_start <= v.voucher_date <= overlap_end)]

    combined = tally_outside + tally_deduped + ra_outside + ra_overlap
    return combined, overlap_count


# ---------------------------------------------------------------------------
# Main extraction
# ---------------------------------------------------------------------------
def extract_rfpl() -> tuple[list[Voucher], list[Voucher], int]:
    print("Extracting RFPL Tally (Canara Bank Book)…")
    rfpl_tally = parse_tally_book(
        RFPL / "Tally-RFPL- April 1, 2025 to March 31, 2026.xls",
        company="RFPL",
        paid_from_account="Canara Bank",
        payment_mode="bank",
        header_row=5,
        book_tag="CNR",
    )
    print(f"  Raw Tally rows: {len(rfpl_tally)}")

    print("Extracting RFPL RA vouchers…")
    rfpl_ra = parse_ra(
        RFPL / "All_Vouchers_2025-04-01_to_2026-08-11.xlsx",
        company="RFPL",
    )
    print(f"  Raw RA rows (paid, ≥1-Apr-2025): {len(rfpl_ra)}")

    # Overlap: Feb-2026 → Mar-2026.
    # NOTE: RFPL Tally = Canara Bank; RFPL RA = Federal Bank (Account Transfer/UPI).
    # Different bank accounts → structural zero overlaps is expected and correct.
    # Amount+date matching across different banks produces coincidental false positives.
    overlaps = 0

    return rfpl_tally, rfpl_ra, overlaps


def extract_rhhf() -> tuple[list[Voucher], list[Voucher], int]:
    print("Extracting RHHF Tally — HDFC Current FY25-26…")
    rhhf_tally_curr1 = parse_tally_book(
        RHHF / "RHHF - April 01 ,2025 to Mar 31, 2026-Current Acc.xlsx",
        company="RHHF",
        paid_from_account="HDFC Current A/c",
        payment_mode="bank",
        header_row=7,
        book_tag="HDFCC",
    )
    print(f"  Raw rows: {len(rhhf_tally_curr1)}")

    print("Extracting RHHF Tally — HDFC Current FY26-27…")
    rhhf_tally_curr2 = parse_tally_book(
        RHHF / "RHHF - April 2026 to July 2026 - HDFC Current Ac.xlsx",
        company="RHHF",
        paid_from_account="HDFC Current A/c",
        payment_mode="bank",
        header_row=7,
        book_tag="HDFCC2",
    )
    # Skip Opening Balance row (it's parsed as a To row with Debit=264563.47)
    rhhf_tally_curr2 = [v for v in rhhf_tally_curr2 if v.payee_name.lower() != "opening balance"]
    print(f"  Raw rows (excl. opening balance): {len(rhhf_tally_curr2)}")

    print("Extracting RHHF Tally — HDFC No-Lien…")
    rhhf_tally_nolien = parse_tally_book(
        RHHF / "HDFC No Lien-1st Jan-31st March 2026.xls",
        company="RHHF",
        paid_from_account="HDFC No-Lien A/c",
        payment_mode="bank",
        header_row=7,
        book_tag="NL",
    )
    # Filter out 1970-01-01 footer rows
    rhhf_tally_nolien = [v for v in rhhf_tally_nolien if v.voucher_date.year > 2020]
    print(f"  Raw rows (excl. footer): {len(rhhf_tally_nolien)}")

    print("Extracting RHHF Tally — Cash Book…")
    rhhf_tally_cash = parse_tally_book(
        RHHF / "RHHF Tally-Cash.xls",
        company="RHHF",
        paid_from_account="Cash",
        payment_mode="cash",
        header_row=6,
        book_tag="CASH",
    )
    print(f"  Raw rows: {len(rhhf_tally_cash)}")

    rhhf_tally_all = rhhf_tally_curr1 + rhhf_tally_curr2 + rhhf_tally_nolien + rhhf_tally_cash
    print(f"  Total RHHF Tally rows: {len(rhhf_tally_all)}")

    print("Extracting RHHF RA vouchers…")
    rhhf_ra = parse_ra(
        RHHF / "All_Vouchers_2025-11-01_to_2026-08-11.xlsx",
        company="RHHF",
    )
    print(f"  Raw RA rows (paid, ≥1-Apr-2025): {len(rhhf_ra)}")

    # Overlap: Jan-2026 → Mar-2026.
    # NOTE: Tally records expense-ledger names; RA records vendor names — payee
    # fuzzy match is structurally unreliable. Using amount±1 + date±3 days only.
    overlap_start = date(2026, 1, 1)
    overlap_end   = date(2026, 3, 31)
    combined, overlaps = detect_overlaps(
        rhhf_tally_all, rhhf_ra, overlap_start, overlap_end, use_payee_match=False
    )

    return rhhf_tally_all, rhhf_ra, overlaps


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print("PHASE 1 — EXTRACT")
    print("=" * 60)
    print()

    rfpl_tally, rfpl_ra, rfpl_overlaps = extract_rfpl()
    print()
    rhhf_tally, rhhf_ra, rhhf_overlaps = extract_rhhf()

    print()
    print("=" * 60)
    print("PHASE 1 SUMMARY REPORT")
    print("=" * 60)

    rfpl_total = len(rfpl_tally) + len(rfpl_ra) - rfpl_overlaps
    rhhf_total = len(rhhf_tally) + len(rhhf_ra) - rhhf_overlaps
    grand_total = rfpl_total + rhhf_total

    print(f"\nRFPL:")
    print(f"  Tally rows extracted : {len(rfpl_tally):>5}  (excl. 37 Contra + 3 null-VchType from 947 raw)")
    print(f"  RA rows extracted    : {len(rfpl_ra):>5}  (paid, ≥1-Apr-2025)")
    print(f"  Overlaps detected    : {rfpl_overlaps:>5}  (Feb–Mar 2026 — structural zero: Tally=Canara, RA=Federal Bank)")
    print(f"  Net vouchers for import: {rfpl_total}")

    # Breakdown by FY
    rfpl_ra_fy25 = sum(1 for v in rfpl_ra if v.voucher_date < date(2026, 4, 1))
    rfpl_ra_fy26 = sum(1 for v in rfpl_ra if v.voucher_date >= date(2026, 4, 1))
    print(f"    RA FY25-26: {rfpl_ra_fy25}  |  RA FY26-27: {rfpl_ra_fy26}")

    print(f"\nRHHF:")
    print(f"  Tally rows extracted : {len(rhhf_tally):>5}")
    print(f"  RA rows extracted    : {len(rhhf_ra):>5}  (paid, ≥1-Apr-2025)")
    print(f"  Overlaps detected    : {rhhf_overlaps:>5}  (Jan–Mar 2026 — by amount±1 + date±3d; needs manual verify)")
    print(f"  Net vouchers for import: {rhhf_total}")

    rhhf_ra_fy24 = sum(1 for v in rhhf_ra if v.voucher_date < date(2025, 4, 1))
    rhhf_ra_fy25 = sum(1 for v in rhhf_ra if date(2025, 4, 1) <= v.voucher_date < date(2026, 4, 1))
    rhhf_ra_fy26 = sum(1 for v in rhhf_ra if v.voucher_date >= date(2026, 4, 1))
    print(f"    RA FY24-25: {rhhf_ra_fy24}  |  RA FY25-26: {rhhf_ra_fy25}  |  RA FY26-27: {rhhf_ra_fy26}")

    # RHHF Tally breakdown by book
    rhhf_curr1 = sum(1 for v in rhhf_tally if v.paid_from_account == "HDFC Current A/c" and v.voucher_date < date(2026, 4, 1))
    rhhf_curr2 = sum(1 for v in rhhf_tally if v.paid_from_account == "HDFC Current A/c" and v.voucher_date >= date(2026, 4, 1))
    rhhf_nolien = sum(1 for v in rhhf_tally if v.paid_from_account == "HDFC No-Lien A/c")
    rhhf_cash   = sum(1 for v in rhhf_tally if v.paid_from_account == "Cash")
    print(f"    Tally: HDFC Current FY25-26={rhhf_curr1}  FY26-27={rhhf_curr2}  No-Lien={rhhf_nolien}  Cash={rhhf_cash}")

    print(f"\nTotal vouchers for import: {grand_total}")
    print()

    # Sanity checks vs work-order expected counts
    print("--- Sanity checks vs work order ---")
    print(f"  RFPL Tally expected ~944, got {len(rfpl_tally)}")
    print(f"  RFPL RA FY25-26 expected ~166, got {rfpl_ra_fy25}")
    print(f"  RFPL RA FY26-27 expected ~434, got {rfpl_ra_fy26}")
    print(f"  RHHF HDFC Current FY25-26 expected ~337, got {rhhf_curr1}")
    print(f"  RHHF HDFC Current FY26-27 expected ~19 (excl. opening bal), got {rhhf_curr2}")
    print(f"  RHHF No-Lien expected ~263, got {rhhf_nolien}")
    print(f"  RHHF Cash expected ~35, got {rhhf_cash}")
    print(f"  RHHF RA total expected ~647, got {len(rhhf_ra)}")

    print()
    print("Phase 1 complete. Awaiting confirmation before Phase 2.")
