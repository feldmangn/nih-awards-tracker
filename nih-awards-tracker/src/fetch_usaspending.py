#!/usr/bin/env python3
import argparse
import json
import pathlib
import sys
from typing import Dict, List

import pandas as pd
import requests
from utils import date_window

API = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
CONTRACT_TYPES = ["A", "B", "C", "D"]
PAGE_LIMIT = 100
TIMEOUT = 60

# ---- Internal field keys (match Contract Award mappings) ----
# ---- Internal field keys (must include sort key!) ----
# replace FIELDS_INTERNAL with mapping names expected by the endpoint
FIELDS = [
    "Award ID",                                # label (string with space)
    "Recipient Name",                          # label
    "Action Date",                             # label
    "Award Amount",                            # label  <-- we will sort by this
    "PIID",                                    # label
    "pop_state_code",                          # snake_case mapping key
    "psc_code",                                # snake_case mapping key
    "psc_description",                         # snake_case mapping key
    "naics_code",                              # snake_case mapping key
    "naics_description",                       # snake_case mapping key
    "Type Of Set Aside",                       # label
    "Contracting Officer Business Size Determination",  # label
    "Last Modified Date",                      # label (optional but useful)
]
SORT_LABEL = "Award Amount"   # must also be present in FIELDS
SORT_ORDER = "desc"


# ---- Friendly names ----
FRIENDLY_COLS = {
    "Award ID": "Award Id",
    "Recipient Name": "Recipient Name",
    "Action Date": "Action Date",
    "Award Amount": "Award Amount",
    "PIID": "Piid",
    "pop_state_code": "Place Of Performance State Code",
    "psc_code": "Product Or Service Code (Psc)",
    "psc_description": "Psc Description",
    "naics_code": "Naics Code",
    "naics_description": "Naics Description",
    "Type Of Set Aside": "Type Of Set Aside",
    "Contracting Officer Business Size Determination": "Contracting Officer Business Size Determination",
    "Last Modified Date": "Last Modified Date",
}


def fetch_page(payload: Dict) -> Dict:
    r = requests.post(API, json=payload, timeout=TIMEOUT)
    if r.status_code != 200:
        print("Payload sent:", json.dumps(payload, indent=2))
        print("Status:", r.status_code, "Body:", r.text[:2000])
        r.raise_for_status()
    return r.json()

def fetch_nih_awards(days: int = 90) -> pd.DataFrame:
    start, end = date_window(days)
    page = 1
    all_rows: List[Dict] = []

    while True:
        payload = {
            "fields": FIELDS,
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
            "sort": SORT_LABEL,   # <-- label that appears in FIELDS
            "order": SORT_ORDER,
        }




        data = fetch_page(payload)
        results = data.get("results", []) or []
        all_rows.extend(results)

        meta = data.get("page_metadata") or {}
        if not meta.get("hasNext") or not results:
            break
        page += 1

    df = pd.DataFrame(all_rows)
    # Keep only the fields we asked for and are actually present
    cols_present = [c for c in FIELDS if c in df.columns]
    df = df[cols_present].copy()

    # Rename them to friendly names for your CSVs
    df.rename(columns=FRIENDLY_COLS, inplace=True)


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

    if "Recipient Name" in df.columns and "Award Amount" in df.columns:
        agg = (
            df.groupby("Recipient Name", dropna=False)["Award Amount"]
              .sum().reset_index()
              .sort_values("Award Amount", ascending=False)
        )
        agg_path = out_dir / f"nih_top_recipients_last_{days}d.csv"
        agg.to_csv(agg_path, index=False)
        print(f"Saved {len(df)} awards across {agg.shape[0]} recipients.")
    else:
        print(f"Saved {len(df)} awards (top recipients skipped: missing columns).")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=90)
    p.add_argument("--outdir", type=str, default="data")
    args = p.parse_args()
    try:
        main(days=args.days, outdir=args.outdir)
    except Exception as e:
        print("ERROR:", e)
        sys.exit(1)
