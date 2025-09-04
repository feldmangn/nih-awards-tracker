#!/usr/bin/env python3
"""
Fetch recent NIH contract awards from USAspending and write CSV/JSON outputs.

- Uses internal USAspending field keys so PSC/NAICS/Place-of-Performance populate
- Handles API paging (limit=100)
- Renames to friendly headers for your frontend
- Produces:
    data/nih_awards_last_<days>d.csv
    data/nih_awards_last_<days>d.json
    data/nih_top_recipients_last_<days>d.csv
"""

import argparse
import json
import pathlib
import sys
from typing import Dict, List

import pandas as pd
import requests
from utils import date_window  # must exist: returns (start_date, end_date) as 'YYYY-MM-DD'


API = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
CONTRACT_TYPES = ["A", "B", "C", "D"]  # contract award types
PAGE_LIMIT = 100                       # USAspending max per page
TIMEOUT = 60


# ---- Internal field keys to request from USAspending ----
FIELDS_INTERNAL: List[str] = [
    "award_id",                         # -> Award Id
    "recipient_name",                   # -> Recipient Name
    "action_date",                      # -> Action Date
    "obligated_amount",                 # -> Award Amount
    "piid",                             # -> Piid

    # Geography for the map
    "place_of_performance_state_code",  # -> Place Of Performance State Code
    "place_of_performance_state_name",  # -> Place Of Performance State Name

    # Classification codes
    "product_or_service_code",          # -> Product Or Service Code (Psc)
    "psc_description",                  # -> Psc Description
    "naics_code",                       # -> Naics Code
    "naics_description",                # -> Naics Description

    # Set-aside / size
    "type_set_aside",                                   # -> Type Of Set Aside
    "contracting_officers_business_size_determination", # -> Contracting Officer Business Size Determination
]

# ---- Friendly names used by your web app ----
FRIENDLY_COLS: Dict[str, str] = {
    "award_id": "Award Id",
    "recipient_name": "Recipient Name",
    "action_date": "Action Date",
    "obligated_amount": "Award Amount",
    "piid": "Piid",
    "place_of_performance_state_code": "Place Of Performance State Code",
    "place_of_performance_state_name": "Place Of Performance State Name",
    "product_or_service_code": "Product Or Service Code (Psc)",
    "psc_description": "Psc Description",
    "naics_code": "Naics Code",
    "naics_description": "Naics Description",
    "type_set_aside": "Type Of Set Aside",
    "contracting_officers_business_size_determination": "Contracting Officer Business Size Determination",
}


def fetch_page(payload: Dict) -> Dict:
    """POST a page to USAspending and return JSON (or raise for status)."""
    r = requests.post(API, json=payload, timeout=TIMEOUT)
    if r.status_code != 200:
        # Helpful diagnostics if the API rejects the request
        print("Payload sent:", json.dumps(payload, indent=2))
        print("Status:", r.status_code, "Body:", r.text[:2000])
        r.raise_for_status()
    return r.json()


def fetch_nih_awards(days: int = 90) -> pd.DataFrame:
    """Fetch NIH contract awards for the last `days` and return a normalized DataFrame."""
    start, end = date_window(days)
    page = 1
    all_rows: List[Dict] = []

    while True:
        payload = {
            "fields": FIELDS_INTERNAL,  # INTERNAL KEYS
            "filters": {
                "time_period": [{"start_date": start, "end_date": end}],
                "agencies": [
                    {"type": "awarding", "tier": "toptier", "name": "Department of Health and Human Services"},
                    {"type": "awarding", "tier": "subtier", "name": "National Institutes of Health"},
                ],
                "award_type_codes": CONTRACT_TYPES,
            },
            "page": page,
            "limit": PAGE_LIMIT,
            # no server-side sort; we'll sort locally
        }

        data = fetch_page(payload)
        results = data.get("results", []) or []
        all_rows.extend(results)

        meta = data.get("page_metadata") or {}
        if not meta.get("hasNext") or not results:
            break

        page += 1

    # Build DataFrame strictly from the internal keys we requested
    df = pd.DataFrame(all_rows)
    # keep only requested fields (defensive if API changes)
    cols_present = [k for k in FIELDS_INTERNAL if k in df.columns]
    df = df[cols_present].copy()

    # Rename to friendly headers for your web app
    df.rename(columns=FRIENDLY_COLS, inplace=True)

    # Local sort by Action Date (desc) if available
    if "Action Date" in df.columns:
        df["Action Date"] = pd.to_datetime(df["Action Date"], errors="coerce")
        df = df.sort_values("Action Date", ascending=False)

    return df


def main(days: int = 90, outdir: str = "data") -> None:
    df = fetch_nih_awards(days=days)

    out_dir = pathlib.Path(outdir)
    out_dir.mkdir(parents=True, exist_ok=True)

    csv_path = out_dir / f"nih_awards_last_{days}d.csv"
    json_path = out_dir / f"nih_awards_last_{days}d.json"
    df.to_csv(csv_path, index=False)
    df.to_json(json_path, orient="records")

    # Roll up top recipients (sum of Award Amount)
    if "Recipient Name" in df.columns and "Award Amount" in df.columns:
        agg = (
            df.groupby("Recipient Name", dropna=False)["Award Amount"]
              .sum()
              .reset_index()
              .sort_values("Award Amount", ascending=False)
        )
        agg_path = out_dir / f"nih_top_recipients_last_{days}d.csv"
        agg.to_csv(agg_path, index=False)
        print(f"Saved {len(df)} awards across {agg.shape[0]} recipients.")
    else:
        print(f"Saved {len(df)} awards (top recipients skipped: missing columns).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch recent NIH contract awards from USAspending")
    parser.add_argument("--days", type=int, default=90, help="Lookback window in days (default: 90)")
    parser.add_argument("--outdir", type=str, default="data", help="Output directory (default: data)")
    args = parser.parse_args()

    try:
        main(days=args.days, outdir=args.outdir)
    except Exception as e:
        # Ensure a clear non-zero exit code in CI while providing context
        print("ERROR:", e)
        sys.exit(1)
