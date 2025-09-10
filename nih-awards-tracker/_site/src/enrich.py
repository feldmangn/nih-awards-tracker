import pandas as pd, urllib.parse as up, sys

def careers_link(recipient:str):
    q = f'{recipient} careers OR jobs site:greenhouse.io OR site:lever.co OR site:workday.com'
    return f"https://www.google.com/search?q={up.quote(q)}"

def add_links(in_csv="data/nih_top_recipients_last_90d.csv", out_csv=None):
    df = pd.read_csv(in_csv)
    df["Careers Search"] = df["Recipient Name"].fillna("").apply(careers_link)
    out_csv = out_csv or in_csv.replace(".csv", "_enriched.csv")
    df.to_csv(out_csv, index=False)
    print(f"Wrote {out_csv}")

if __name__ == "__main__":
    in_csv = sys.argv[1] if len(sys.argv) > 1 else "data/nih_top_recipients_last_90d.csv"
    add_links(in_csv)
