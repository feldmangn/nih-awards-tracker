#!/usr/bin/env python3
"""
Multi-agency USAspending pull via TRANSACTIONS (fast + robust)

- Accepts repeatable --toptier "Exact Name" and --subtier "Exact Name"
- Iterates each agency separately and writes per-agency outputs:
    data/<slug>_awards_last_{days}d.csv
    data/<slug>_awards_last_{days}d.json
    data/<slug>_top_recipients_last_{days}d.csv
- Optional fast mode (--no-detail) skips /awards/{id} calls
- Detail mode enriches set-aside, business size, PoP city/zip/county

Usage examples:
  python src/fetch_usaspending.py --days 90 \
    --subtier "National Institutes of Health" \
    --toptier "Department of Energy" \
    --subtier "Air Force Research Laboratory"
"""

import argparse, json, pathlib, sys, time, random, re
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

TXN_API    = "https://api.usaspending.gov/api/v2/search/spending_by_transaction/"
DETAIL_API = "https://api.usaspending.gov/api/v2/awards/{award_id}/"

# Tuning
PAGE_LIMIT = 75
TIMEOUT    = 60
TXN_SORT   = "Action Date"
TXN_ORDER  = "desc"

# Fields we can rely on from the transaction endpoint
TXN_FIELDS = [
    "generated_internal_id",            # preferred id for detail
    "internal_id",                      # fallback id for detail
    "Award ID",
    "Recipient Name",
    "Action Date",
    "Transaction Amount",
    "Awarding Agency",
    "Awarding Sub Agency",
    "product_or_service_code",
    "product_or_service_description",
    "naics_code",
    "naics_description",
    "pop_state_code",
]

# Final output columns (front-end expects these)
COLS_OUT = [
    "Award Id",
    "Recipient Name",
    "Action Date",
    "Award Amount",
    "Piid",
    "Place Of Performance State Code",
    "Place Of Performance City Name",
    "Place Of Performance ZIP Code",
    "Place Of Performance County Name",
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
    "product_or_service_code": "Product Or Service Code (Psc)",
    "product_or_service_description": "Psc Description",
    "naics_code": "Naics Code",
    "naics_description": "Naics Description",
    "pop_state_code": "Place Of Performance State Code",
}

def slugify(name: str) -> str:
    s = name.strip().lower()
    s = re.sub(r"&", " and ", s)
    s = re.sub(r"[^\w]+", "_", s)           # keep letters/digits/underscore
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "agency"

# Optionally override long names with short slugs you prefer
PREFERRED_SLUGS = {
    "national_institutes_of_health": "nih",
    "advanced_research_projects_agency_for_health": "arpa_h",
    "agency_for_healthcare_research_and_quality": "ahrq",
    "centers_for_medicare_and_medicaid_services": "cms",
    "department_of_defense": "dod",
    "office_of_naval_research": "onr",
    "naval_information_warfare_systems_command": "navwar",
    "air_force_research_laboratory": "afrl",
    "u_s_army_medical_research_and_development_command": "usamrdc",
    "u_s_army_engineer_research_and_development_center": "erdc",
    "defense_health_agency": "dha",
    "department_of_energy": "doe",
    "office_of_science": "doe_office_of_science",
    "advanced_research_projects_agency_energy": "arpa_e",
    "environmental_protection_agency": "epa",
}

def friendly_slug(name: str) -> str:
    s = slugify(name)
    return PREFERRED_SLUGS.get(s, s)

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
        "User-Agent": "nih-awards-tracker/txn/1.4 (+https://github.com/feldmangn/nih-awards-tracker)"
    })
    return s

def _post_txn(s: requests.Session, payload: Dict) -> Dict:
    r = s.post(TXN_API, json=payload, timeout=TIMEOUT)
    if r.status_code != 200:
        print("Payload sent:", json.dumps(payload, indent=2))
        print("Status:", r.status_code, "Body:", r.text[:2000])
        r.raise_for_status()
    return r.json() or {}

def _get_detail(s: requests.Session, award_internal_id: str, tries: int = 4, sleep_base: float = 0.09) -> Dict:
    """Fetch award detail with light client-side retries. Always returns a dict (possibly empty)."""
    for attempt in range(tries):
        try:
            time.sleep(sleep_base * (attempt + 1) + random.random() * 0.05)
            r = s.get(DETAIL_API.format(award_id=award_internal_id), timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json() or {}
            if r.status_code in (429, 500, 502, 503, 504):
                continue
            return {}
        except requests.exceptions.RequestException:
            if attempt < tries - 1:
                continue
            return {}
    return {}

def fetch_for_agency(days: int, tier: str, name: str, do_detail: bool = True,
                     max_pages: Optional[int] = None) -> pd.DataFrame:
    """Fetch transactions for a single agency (awarding + tier + exact name)."""
    s = make_session()
    start, end = date_window(days)
    page = 1
    rows: List[Dict] = []
    printed_cols = False

    # Pull transactions for the specific agency
    while True:
        payload = {
            "fields": TXN_FIELDS,
            "filters": {
                "time_period": [{"start_date": start, "end_date": end}],
                "agencies": [
                    {"type": "awarding", "tier": tier, "name": name},
                ],
                "award_type_codes": ["A", "B", "C", "D"],  # Contracts & IDVs
            },
            "page": page,
            "limit": PAGE_LIMIT,
            "sort": TXN_SORT,
            "order": TXN_ORDER,
        }
        data = _post_txn(s, payload)
        results = data.get("results", []) or []
        if results and not printed_cols:
            print(f"[{tier}:{name}] Txn columns:", sorted(list(results[0].keys())))
            printed_cols = True
        rows.extend(results)

        meta = data.get("page_metadata") or {}
        if not meta.get("hasNext") or not results:
            break
        page += 1
        if max_pages and page > max_pages:
            break
        time.sleep(0.05)

    if not rows:
        print(f"[{tier}:{name}] No transactions found in window.")
        return pd.DataFrame(columns=COLS_OUT)

    df = pd.DataFrame(rows)
    present = [c for c in TXN_FIELDS if c in df.columns]
    df = df[present].copy()
    df.rename(columns=FRIENDLY_TXN, inplace=True)

    # Base columns we already have from the txn query
    base = pd.DataFrame({
        "Award Id": df.get("Award Id", pd.Series(dtype=object)),
        "Recipient Name": df.get("Recipient Name", pd.Series(dtype=object)),
        "Action Date": pd.to_datetime(df.get("Action Date", pd.Series(dtype=object)), errors="coerce"),
        "Award Amount": df.get("Award Amount", pd.Series(dtype=float)),
        "Piid": pd.Series([""] * len(df)),
        "Place Of Performance State Code": df.get("Place Of Performance State Code", pd.Series(dtype=object)),
        "Place Of Performance City Name": pd.Series([""] * len(df)),
        "Place Of Performance ZIP Code": pd.Series([""] * len(df)),
        "Place Of Performance County Name": pd.Series([""] * len(df)),
        "Product Or Service Code (Psc)": df.get("Product Or Service Code (Psc)", pd.Series(dtype=object)),
        "Psc Description": df.get("Psc Description", pd.Series(dtype=object)),
        "Naics Code": df.get("Naics Code", pd.Series(dtype=object)),
        "Naics Description": df.get("Naics Description", pd.Series(dtype=object)),
        "Type Of Set Aside": pd.Series([""] * len(df)),
        "Type Of Set Aside Description": pd.Series([""] * len(df)),
        "Contracting Officer Business Size Determination": pd.Series([""] * len(df)),
        "Last Modified Date": pd.Series([""] * len(df)),
        "Is Small Business": pd.Series([False] * len(df)),
        "Is 8a Set-Aside": pd.Series([False] * len(df)),
    })

    if not do_detail:
        return base[COLS_OUT]

    # Enrich with detail
    gen_ids = df.get("generated_internal_id")
    int_ids = df.get("internal_id")
    awd_ids = df.get("Award Id")  # final fallback

    ids: List[Optional[str]] = []
    for i in range(len(df)):
        gid = None if gen_ids is None else gen_ids.iloc[i]
        iid = None if   int_ids is None else int_ids.iloc[i]
        aid = None if   awd_ids is None else awd_ids.iloc[i]
        ids.append(str(gid or iid or aid or ""))

    add = {
        "Piid": [],
        "Place Of Performance City Name": [],
        "Place Of Performance ZIP Code": [],
        "Place Of Performance County Name": [],
        "Type Of Set Aside": [],
        "Type Of Set Aside Description": [],
        "Contracting Officer Business Size Determination": [],
        "Last Modified Date": [],
    }

    with make_session() as s2:
        for i, award_id in enumerate(ids, 1):
            det = _get_detail(s2, award_id) if award_id else {}

            pop = det.get("place_of_performance") or {}

            pop_city   = det.get("pop_city_name")  or pop.get("city_name")  or ""
            pop_zip_raw = (det.get("pop_zip5") or pop.get("location_zip5") or pop.get("zip5")
                           or det.get("pop_zip4") or pop.get("zip4") or "")
            pop_zip5   = str(pop_zip_raw)[:5] if pop_zip_raw else ""
            pop_county = det.get("pop_county_name") or pop.get("county_name") or ""

            add["Piid"].append(det.get("piid") or "")
            add["Place Of Performance City Name"].append(pop_city)
            add["Place Of Performance ZIP Code"].append(pop_zip5)
            add["Place Of Performance County Name"].append(pop_county)
            add["Type Of Set Aside"].append(det.get("type_set_aside") or "")
            add["Type Of Set Aside Description"].append(det.get("type_set_aside_description") or "")
            add["Contracting Officer Business Size Determination"].append(
                det.get("contracting_officers_determination_of_business_size") or ""
            )
            add["Last Modified Date"].append(det.get("last_modified_date") or "")

            if i % 200 == 0:
                time.sleep(0.35)

    for k, v in add.items():
        base[k] = v

    # Flags for UI
    def _is_small_business(x: str) -> bool:
        return isinstance(x, str) and x.strip().upper() == "SMALL BUSINESS"
    def _is_8a(x: str) -> bool:
        return isinstance(x, str) and "8(A" in x.upper()

    base["Is Small Business"] = base["Contracting Officer Business Size Determination"].apply(_is_small_business)
    base["Is 8a Set-Aside"] = (
        base["Type Of Set Aside Description"].apply(_is_8a) |
        base["Type Of Set Aside"].apply(_is_8a)
    )

    return base[COLS_OUT]

def write_outputs(df: pd.DataFrame, out_dir: pathlib.Path, slug: str, days: int) -> None:
    csv_path  = out_dir / f"{slug}_awards_last_{days}d.csv"
    json_path = out_dir / f"{slug}_awards_last_{days}d.json"
    df.to_csv(csv_path, index=False)
    df.to_json(json_path, orient="records")
    if not df.empty:
        agg = (df.groupby("Recipient Name", dropna=False)["Award Amount"]
                 .sum().reset_index().sort_values("Award Amount", ascending=False))
        agg.to_csv(out_dir / f"{slug}_top_recipients_last_{days}d.csv", index=False)
        print(f"[{slug}] Saved {len(df)} transactions across {agg.shape[0]} recipients.")
    else:
        print(f"[{slug}] Saved 0 transactions (window).")

def main(days: int = 90, outdir: str = "data", max_pages: Optional[int] = None, no_detail: bool = False,
         toptiers: Optional[List[str]] = None, subtiers: Optional[List[str]] = None) -> None:
    out_dir = pathlib.Path(outdir); out_dir.mkdir(parents=True, exist_ok=True)

    targets: List[Tuple[str, str]] = []
    for name in (toptiers or []):
        targets.append(("toptier", name))
    for name in (subtiers or []):
        targets.append(("subtier", name))

    # Default to NIH if nothing provided (so local runs still do something)
    if not targets:
        targets = [("subtier", "National Institutes of Health")]

    for tier, name in targets:
        slug = friendly_slug(name)
        try:
            df = fetch_for_agency(days=days, tier=tier, name=name, do_detail=not no_detail, max_pages=max_pages)
            write_outputs(df, out_dir, slug, days)
        except Exception as e:
            print(f"[{tier}:{name}] ERROR: {e}")
            # keep going for other agencies
            continue

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--outdir", type=str, default="data")
    ap.add_argument("--max-pages", type=int, default=None, help="Cap number of pages for testing")
    ap.add_argument("--no-detail", action="store_true", help="Skip /awards/{id} enrichment for speed")
    ap.add_argument("--toptier", action="append", default=[], help="Exact toptier agency name (repeatable)")
    ap.add_argument("--subtier", action="append", default=[], help="Exact subtier agency name (repeatable)")
    args = ap.parse_args()
    try:
        main(days=args.days, outdir=args.outdir, max_pages=args.max_pages, no_detail=args.no_detail,
             toptiers=args.toptier, subtiers=args.subtier)
    except Exception as e:
        print("FATAL ERROR:", e)
        sys.exit(1)
