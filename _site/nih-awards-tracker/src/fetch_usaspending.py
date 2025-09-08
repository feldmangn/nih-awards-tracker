#!/usr/bin/env python3
"""
NIH awards tracker via TRANSACTIONS (robust)
1) Query /search/spending_by_transaction/ with safe fields & sort.
2) Enrich each row via /awards/{internal_id}/ for:
   - type_set_aside, type_set_aside_description
   - contracting_officers_determination_of_business_size
   - PSC/NAICS/PoP/PIID (fallbacks)
3) Filter to NIH awarding subtier from detail payload.
4) Write CSV/JSON and top recipients. Includes "Is Small Business" & "Is 8a Set-Aside".

Usage:
  python src/fetch_usaspending.py --days 90 --outdir data
"""

import argparse, json, pathlib, sys, time, random
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

TXN_API = "https://api.usaspending.gov/api/v2/search/spending_by_transaction/"
DETAIL_API = "https://api.usaspending.gov/api/v2/awards/{award_id}/"

# Transaction-safe page & sort
PAGE_LIMIT = 75
TIMEOUT = 60
TXN_SORT = "Action Date"        # valid for transactions
TXN_ORDER = "desc"

# Fields that the transaction endpoint explicitly allows (based on API response list)
TXN_FIELDS = [
    "internal_id",
    "Award ID",
    "Recipient Name",
    "Action Date",
    "Transaction Amount",
    "Awarding Agency",
    "Awarding Sub Agency",
    "product_or_service_code",          # <-- was psc_code
    "product_or_service_description",
    "naics_code",
    "naics_description",
    "pop_state_code",                   # <-- was Primary Place of Performance
]


# Final output columns (same shape as your pages expect)
COLS_OUT = [
    "Award Id",
    "Recipient Name",
    "Action Date",
    "Award Amount",
    "Piid",
    "Place Of Performance State Code",
    "Product Or Service Code (Psc)",
    "Psc Description",
    "Naics Code",
    "Naics Description",
    "Type Of Set Aside",
    "Type Of Set Aside Description",
    "Contracting Officer Business Size Determination",
    "Last Modified Date",
    "Is Small Business",
    "Is 8a Set-Aside",
]

FRIENDLY_TXN = {
    "Award ID": "Award Id",
    "Recipient Name": "Recipient Name",
    "Action Date": "Action Date",
    "Transaction Amount": "Award Amount",
    "product_or_service_code": "Product Or Service Code (Psc)",   # <-- was psc_code
    "product_or_service_description": "Psc Description",
    "naics_code": "Naics Code",
    "naics_description": "Naics Description",
    "pop_state_code": "Place Of Performance State Code",          # <-- new
}


def date_window(last_n_days: int) -> Tuple[str, str]:
    end = date.today()
    start = end - timedelta(days=last_n_days)
    return start.isoformat(), end.isoformat()

def make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=6, connect=6, read=6,
        backoff_factor=0.7,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET", "POST"]),
        raise_on_status=False, respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=16, pool_maxsize=32)
    s.mount("https://", adapter)
    s.headers.update({
        "Accept": "application/json",
        "User-Agent": "nih-awards-tracker/txn/1.0 (+https://github.com/feldmangn/nih-awards-tracker)"
    })
    return s

def _post_txn(s: requests.Session, payload: Dict) -> Dict:
    r = s.post(TXN_API, json=payload, timeout=TIMEOUT)
    if r.status_code != 200:
        print("Payload sent:", json.dumps(payload, indent=2))
        print("Status:", r.status_code, "Body:", r.text[:2000])
        r.raise_for_status()
    return r.json() or {}

def _get_detail(s: requests.Session, award_internal_id: str) -> Optional[Dict]:
    time.sleep(0.02 + random.random() * 0.03)  # tiny jitter
    r = s.get(DETAIL_API.format(award_id=award_internal_id), timeout=TIMEOUT)
    if r.status_code != 200:
        return None
    return r.json() or None

def fetch(days: int = 90) -> pd.DataFrame:
    s = make_session()
    start, end = date_window(days)
    page = 1
    rows: List[Dict] = []
    printed_cols = False

    # 1) Pull transactions at HHS (no subtier filter here; we’ll use details later)
    while True:
        payload = {
            "fields": TXN_FIELDS,
            "filters": {
                "time_period": [{"start_date": start, "end_date": end}],
                "agencies": [
                    {"type": "awarding", "tier": "toptier", "name": "Department of Health and Human Services"},
                ],
                "award_type_codes": ["A", "B", "C", "D"],  # include IDVs as txn endpoint tolerates better
            },
            "page": page,
            "limit": PAGE_LIMIT,
            "sort": TXN_SORT,
            "order": TXN_ORDER,
        }
        data = _post_txn(s, payload)
        results = data.get("results", []) or []
        if results and not printed_cols:
            print("Txn search returned columns:", sorted(list(results[0].keys())))
            printed_cols = True
        rows.extend(results)

        meta = data.get("page_metadata") or {}
        if not meta.get("hasNext") or not results:
            break
        page += 1
        time.sleep(0.07)

    if not rows:
        return pd.DataFrame(columns=COLS_OUT)

    df = pd.DataFrame(rows)
    # Keep only fields we asked for
    present = [c for c in TXN_FIELDS if c in df.columns]
    df = df[present].copy()
    # Rename to friendly names
    df.rename(columns=FRIENDLY_TXN, inplace=True)

    # 2) Enrich each transaction’s award with details; filter to NIH
    add = {
        "Piid": [],
        "Place Of Performance State Code": [],
        "Type Of Set Aside": [],
        "Type Of Set Aside Description": [],
        "Contracting Officer Business Size Determination": [],
        "Last Modified Date": [],
        "_awarding_subtier_name": [],
    }

    internal_ids: List[Optional[str]] = df.get("internal_id", pd.Series([None]*len(df))).tolist()

    with make_session() as s2:
        for i, aid in enumerate(internal_ids, 1):
            det = _get_detail(s2, aid) if aid else None
            if det is None:
                det = {}
            add["Piid"].append(det.get("piid") or "")
            add["Place Of Performance State Code"].append(det.get("pop_state_code") or "")
            add["Type Of Set Aside"].append(det.get("type_set_aside") or "")
            add["Type Of Set Aside Description"].append(det.get("type_set_aside_description") or "")
            add["Contracting Officer Business Size Determination"].append(
                det.get("contracting_officers_determination_of_business_size") or ""
            )
            add["Last Modified Date"].append(det.get("last_modified_date") or "")
            awarding_agency = det.get("awarding_agency") or {}
            add["_awarding_subtier_name"].append((awarding_agency.get("subtier_name") or "").strip())
            if i % 200 == 0:
                time.sleep(0.4)

    for k, v in add.items():
        df[k] = v

    # 3) Filter to NIH (awarding subtier)
    df = df[df["_awarding_subtier_name"].str.upper().eq("NATIONAL INSTITUTES OF HEALTH")].copy()
    df.drop(columns=["_awarding_subtier_name"], inplace=True, errors="ignore")

    # 4) Parse dates & finalize columns
    if "Action Date" in df.columns:
        df["Action Date"] = pd.to_datetime(df["Action Date"], errors="coerce")

    # Flags for your UI
    def _is_small_business(x: str) -> bool:
        return isinstance(x, str) and x.strip().upper() == "SMALL BUSINESS"
    def _is_8a(x: str) -> bool:
        return isinstance(x, str) and "8(A" in x.upper()

    df["Is Small Business"] = df["Contracting Officer Business Size Determination"].apply(_is_small_business)
    df["Is 8a Set-Aside"] = (
        df["Type Of Set Aside Description"].apply(_is_8a) |
        df["Type Of Set Aside"].apply(_is_8a)
    )

    # Ensure expected columns exist
    for col in COLS_OUT:
        if col not in df.columns:
            df[col] = ""
    # Some txn pulls won’t include PSC/NAICS; keep any values we did get
    return df[COLS_OUT]

def main(days: int = 90, outdir: str = "data") -> None:
    out_dir = pathlib.Path(outdir); out_dir.mkdir(parents=True, exist_ok=True)
    df = fetch(days=days)

    csv_path = out_dir / f"nih_awards_last_{days}d.csv"
    json_path = out_dir / f"nih_awards_last_{days}d.json"
    df.to_csv(csv_path, index=False)
    df.to_json(json_path, orient="records")

    if not df.empty:
        agg = (df.groupby("Recipient Name", dropna=False)["Award Amount"]
                 .sum().reset_index().sort_values("Award Amount", ascending=False))
        agg.to_csv(out_dir / f"nih_top_recipients_last_{days}d.csv", index=False)
        print(f"Saved {len(df)} transactions across {agg.shape[0]} recipients.")
    else:
        print("Saved 0 transactions (after NIH filter).")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--outdir", type=str, default="data")
    args = ap.parse_args()
    try:
        main(days=args.days, outdir=args.outdir)
    except Exception as e:
        print("ERROR:", e)
        sys.exit(1)
