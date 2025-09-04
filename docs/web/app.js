const DATA_DIR = "./data";
const TOP_RECIP_ENRICH = `${DATA_DIR}/nih_top_recipients_last_90d_enriched.csv`;
const TOP_RECIP        = `${DATA_DIR}/nih_top_recipients_last_90d.csv`;
const AWARDS           = `${DATA_DIR}/nih_awards_last_90d.csv`;

async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const text = await res.text();
  return new Promise((resolve) =>
    Papa.parse(text, { header: true, dynamicTyping: true, complete: (r) => resolve(r.data) })
  );
}

async function loadRecipientsOrFallback() {
  try { return await loadCSV(TOP_RECIP_ENRICH); }      // prefer enriched
  catch { try { return await loadCSV(TOP_RECIP); }     // fallback to plain
         catch { return null; } }                      // will compute from awards
}

async function render() {
  const [recipsRawMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS)
  ]);

  // If no recipients CSVs at all, aggregate from awards
  const recipsRaw = recipsRawMaybe ?? (() => {
    const by = {};
    for (const row of awardsRaw) {
      const name = (row["Recipient Name"] || row["recipient_name"] || "").trim();
      const amt  = +row["Award Amount"] || +row["award_amount"] || 0;
      if (!name) continue;
      by[name] = (by[name] || 0) + amt;
    }
    return Object.entries(by).map(([name, amt]) => ({ "Recipient Name": name, "Award Amount": amt }));
  })();

  // (rest of your existing code stays the same)
}
render().catch(err => {
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#c33">${err.stack || err}</pre>`);
});

