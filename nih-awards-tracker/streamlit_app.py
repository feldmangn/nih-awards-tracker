import streamlit as st
import pandas as pd
from pathlib import Path
import altair as alt

st.set_page_config(page_title="NIH Contract Awards Tracker", layout="wide")

def is_8a_row(row) -> bool:
    # Robustly check any columns that might carry set-aside or business info
    possibles = []
    for col in row.index:
        lc = col.lower()
        if "set aside" in lc or "business" in lc or "category" in lc:
            val = str(row[col]).lower()
            possibles.append(val)
    blob = " | ".join(possibles)
    return ("8(a)" in blob) or ("8a" in blob)

def label_size_class(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        df["size_class"] = []
        return df
    # Create a per-award flag
    df["_is_8a_award"] = df.apply(is_8a_row, axis=1)
    # Roll up to recipient: “8(a)” if ANY of their awards in the window is 8(a)
    flags = df.groupby("Recipient Name", dropna=False)["_is_8a_award"].any().rename("is_8a_recipient")
    df = df.merge(flags, on="Recipient Name", how="left")
    df["size_class"] = df["is_8a_recipient"].map({True: "8(a) / Small", False: "Other"})
    return df

st.title("NIH Contract Awards Tracker")
st.caption("Recent NIH contract awards → top recipients → jump to careers searches")

days_default = 90
awards_path = Path(f"data/nih_awards_last_{days_default}d.csv")
recips_path = Path(f"data/nih_top_recipients_last_{days_default}d_enriched.csv")

if not awards_path.exists():
    st.warning("No cached data yet. Run:  `python src/fetch_usaspending.py && python src/enrich.py`")
else:
    awards = pd.read_csv(awards_path)
    # Label recipients by 8(a) / Other
    awards = label_size_class(awards)

    # Aggregate by recipient (total $) and carry the size_class
    if "Award Amount" not in awards.columns:
        st.error("“Award Amount” column not found in data. Re-run fetch with default fields.")
    else:
        roll = (awards.groupby(["Recipient Name", "size_class"], dropna=False)["Award Amount"]
                .sum().reset_index()
                .sort_values("Award Amount", ascending=False))

        # Load enriched links if present
        recips = pd.read_csv(recips_path) if recips_path.exists() else (
            roll.groupby("Recipient Name", as_index=False)["Award Amount"].sum()
        )
        if "Careers Search" not in recips.columns:
            recips["Careers Search"] = None  # placeholder

        # Tabs: All, 8(a)/Small, Other
        tab_all, tab_8a, tab_other = st.tabs(["All recipients", "8(a) / Small businesses", "Large / Other"])

        def plot_block(df_subset, title, key):
            st.subheader(title)

            # independent slider per tab via unique key
            topn = st.sidebar.number_input(
                "Show top N", min_value=1, max_value=100, value=25, step=5, key=key
            )

            if df_subset.empty:
                st.info("No rows to display for this view.")
                return

            # Keep N within available rows
            n = min(int(topn), len(df_subset))
            chart = (
                alt.Chart(df_subset.head(n))
                .mark_bar()
                .encode(
                    x=alt.X("Award Amount:Q", title="Total (USD)"),
                    y=alt.Y("Recipient Name:N", sort="-x", title="Recipient"),
                    tooltip=["Recipient Name", "Award Amount"]
                )
                .properties(height=25 * n)
            )
            st.altair_chart(chart, use_container_width=True)

            # Optional: join careers links if you built that table
            cols = ["Recipient Name", "Award Amount", "size_class"]
            if "Careers Search" in df_subset.columns:
                cols.append("Careers Search")
            st.dataframe(df_subset.head(n)[cols], use_container_width=True)


        with tab_all:
            plot_block(roll, "Top recipients (last 90 days)", key="topn_all")

        with tab_8a:
            roll_8a = roll[roll["size_class"] == "8(a) / Small"].reset_index(drop=True)
            plot_block(roll_8a, "Top 8(a) / small-business recipients", key="topn_8a")

        with tab_other:
            roll_other = roll[roll["size_class"] == "Other"].reset_index(drop=True)
            plot_block(roll_other, "Top large/other recipients", key="topn_other")

        st.subheader("Recent awards (raw)")
        cols = ["Action Date", "Recipient Name", "Award Amount", "PIID"]
        cols = [c for c in cols if c in awards.columns]
        st.dataframe(
            awards.sort_values(cols[0] if cols else awards.columns[0], ascending=False)[cols or awards.columns.tolist()],
            use_container_width=True
        )
