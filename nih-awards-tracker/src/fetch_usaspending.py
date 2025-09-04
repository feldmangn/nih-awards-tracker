import requests, pandas as pd, pathlib
from utils import date_window

API = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
CONTRACT_TYPES = ["A","B","C","D"]      # contract award types
PAGE_LIMIT = 100                        # USAspending max per page

# Try a richer set first (includes Set-Aside info if available),
# then fall back to a smaller set if the API rejects something.
# Try richer sets first; fall back if USAspending rejects a field
# … keep your imports/consts …

FIELD_SETS = [
    [
        "Award ID",
        "Recipient Name",
        "Action Date",
        "Award Amount",
        "PIID",
        # + geography (for the map)
        "Place of Performance State Code",
        "Place of Performance City Code",
        "Place of Performance Zip5",
        # + classification codes
        "Product or Service Code (PSC)",
        "PSC Description",
        "NAICS Code",
        "NAICS Description",
        # set-aside / size (helps your SB tab)
        "Type of Set Aside",
        "Contracting Officer Business Size Determination",
    ],
    [
        "Award ID", "Recipient Name", "Action Date", "Award Amount", "PIID"
    ],
]



def fetch_page(payload):
    r = requests.post(API, json=payload, timeout=60)
    if r.status_code != 200:
        print("Payload sent:", payload)
        print("Status:", r.status_code, "Body:", r.text[:800])
        r.raise_for_status()
    return r.json()

def fetch_nih_awards(days=90):
    start, end = date_window(days)

    # we’ll try the first field set; on 4xx with “field” errors, we retry with the second
    for fields in FIELD_SETS:
        try:
            page = 1
            all_rows = []
            while True:
                payload = {
                    "fields": fields,
                    "filters": {
                        "time_period": [{"start_date": start, "end_date": end}],
                        "agencies": [
                            {"type": "awarding", "tier": "toptier",
                             "name": "Department of Health and Human Services"},
                            {"type": "awarding", "tier": "subtier",
                             "name": "National Institutes of Health"}
                        ],
                        "award_type_codes": CONTRACT_TYPES
                    },
                    "page": page,
                    "limit": PAGE_LIMIT
                    # no server-side sort; we'll sort locally
                }

                data = fetch_page(payload)
                results = data.get("results", []) or []
                all_rows.extend(results)

                meta = data.get("page_metadata") or {}
                has_next = meta.get("hasNext")
                if not has_next or len(results) == 0:
                    break

                page += 1

            df = pd.DataFrame(all_rows)
            df.columns = [c.strip().replace("_", " ").title() for c in df.columns]
            # local sort by Action Date if present
            if "Action Date" in df.columns:
                df["Action Date"] = pd.to_datetime(df["Action Date"], errors="coerce")
                df = df.sort_values("Action Date", ascending=False)
            return df

        except requests.HTTPError as e:
            # Try next (smaller) field set on field-related 4xx
            if 400 <= e.response.status_code < 500 and fields is FIELD_SETS[0]:
                print("Retrying with a smaller field set…")
                continue
            raise

    # Should never reach here
    return pd.DataFrame()

def main(days=90, outdir="data"):
    df = fetch_nih_awards(days=days)
    pathlib.Path(outdir).mkdir(parents=True, exist_ok=True)
    df.to_csv(f"{outdir}/nih_awards_last_{days}d.csv", index=False)
    if "Award Amount" not in df.columns:
        print("Warning: 'Award Amount' not in response; aggregation will be skipped.")
        agg = pd.DataFrame(columns=["Recipient Name", "Award Amount"])
    else:
        agg = (df.groupby("Recipient Name", dropna=False)["Award Amount"]
                 .sum().reset_index()
                 .sort_values("Award Amount", ascending=False))
        agg.to_csv(f"{outdir}/nih_top_recipients_last_{days}d.csv", index=False)
    df.to_json(f"{outdir}/nih_awards_last_{days}d.json", orient="records")
    print(f"Saved {len(df)} awards{' across ' + str(agg.shape[0]) + ' recipients' if not agg.empty else ''}.")

if __name__ == "__main__":
    main()
