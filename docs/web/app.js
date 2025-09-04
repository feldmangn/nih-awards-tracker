// docs/web/app.js
const DEBUG = true;
const debug = (msg) => {
  if (!DEBUG) return;
  const el = document.getElementById("debug");
  if (el) el.insertAdjacentHTML("beforeend", `<div>${msg}</div>`);
  // also log to console for good measure
  console.log(msg);
};

const bust = () => `?t=${Date.now()}`;
const DATA_DIR = "./data";
const TOP_RECIP_ENRICH = `${DATA_DIR}/nih_top_recipients_last_90d_enriched.csv${bust()}`;
const TOP_RECIP        = `${DATA_DIR}/nih_top_recipients_last_90d.csv${bust()}`;
const AWARDS           = `${DATA_DIR}/nih_awards_last_90d.csv${bust()}`;

const fmtUSD = n => new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(+n || 0);

async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  debug(`fetch ${url} -> ${res.status}`);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const text = await res.text();
  return new Promise((resolve) =>
    Papa.parse(text, { header: true, dynamicTyping: true, complete: (r) => resolve(r.data) })
  );
}

async function loadRecipientsOrFallback() {
  try { return await loadCSV(TOP_RECIP_ENRICH); }
  catch (e) { debug(e.message); }
  try { return await loadCSV(TOP_RECIP); }
  catch (e) { debug(e.message); }
  return null; // will compute from awards
}

function coerceNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/,/g, "")) || 0;
  return 0;
}

async function render() {
  const [recipsMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS).catch(e => { debug(e.message); return []; })
  ]);

  debug(`awards rows: ${awardsRaw.length}`);

  // Normalize awards rows (lowercase keys)
  const awards = awardsRaw.map(row => {
    const obj = {};
    for (const [k,v] of Object.entries(row)) obj[(k || "").toString().toLowerCase()] = v;
    return {
      action_date: obj["action date"] ?? obj["action_date"] ?? obj["actiondate"] ?? null,
      recipient_name: obj["recipient name"] ?? obj["recipient_name"] ?? "",
      award_amount: coerceNumber(obj["award amount"] ?? obj["award_amount"]),
      piid: obj["piid"] ?? null
    };
  });

  // Build recipients rollup if needed
  const recipsRaw = recipsMaybe ?? (() => {
    const by = {};
    for (const r of awards) {
      const name = (r.recipient_name || "").trim();
      if (!name) continue;
      by[name] = (by[name] || 0) + (r.award_amount || 0);
    }
    return Object.entries(by).map(([name, amt]) => ({ "Recipient Name": name, "Award Amount": amt }));
  })();

  // Clean/sort recipients
  let recips = (recipsRaw || [])
    .filter(r => r && (r["Recipient Name"] || r["recipient_name"]))
    .map(r => ({
      name: r["Recipient Name"] ?? r["recipient_name"] ?? "",
      amount: coerceNumber(r["Award Amount"] ?? r["award_amount"])
    }))
    .filter(r => r.name);

  recips.sort((a,b) => b.amount - a.amount);

  debug(`recipients rows: ${recips.length}`);

  // Draw chart
  const topNInput = document.getElementById("topN");
  function drawChart() {
    const N = Math.min(Math.max(+topNInput.value || 25, 1), 100);
    const top = recips.slice(0, N);
    if (top.length === 0) {
      document.getElementById("chart").innerHTML = "<p><em>No recipient data available.</em></p>";
      return;
    }
    Plotly.newPlot("chart", [{
      type: "bar",
      x: top.map(d => d.amount),
      y: top.map(d => d.name),
      orientation: "h",
      hovertemplate: "<b>%{y}</b><br>%{x:$,~s}<extra></extra>"
    }], { margin:{l:260,r:20,t:10,b:40}, xaxis:{title:"Total (USD)"} }, {displayModeBar:false});
  }
  topNInput.addEventListener("input", drawChart);
  drawChart();

  // Table
  const thead = document.querySelector("#awardsTable thead");
  const tbody = document.querySelector("#awardsTable tbody");
  thead.innerHTML = `<tr><th>Action Date</th><th>Recipient Name</th><th>Award Amount</th><th>PIID</th></tr>`;
  tbody.innerHTML = (awards.length ? awards : []).slice(0, 500).map(r => `
    <tr>
      <td>${r.action_date ?? ""}</td>
      <td>${r.recipient_name ?? ""}</td>
      <td>${fmtUSD(r.award_amount)}</td>
      <td>${r.piid ?? ""}</td>
    </tr>
  `).join("");

  document.getElementById("summary").textContent =
    `Rows shown: ${Math.min(500, awards.length)} of ${awards.length}`;
}

render().catch(err => {
  const msg = err.stack || err;
  console.error(msg);
  const el = document.getElementById("debug");
  if (el) el.innerHTML = `<pre style="color:#c33">${msg}</pre>`;
});
