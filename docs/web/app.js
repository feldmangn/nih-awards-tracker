const DATA_DIR = "./data";
const TOP_RECIP = `${DATA_DIR}/nih_top_recipients_last_90d_enriched.csv`;
const AWARDS = `${DATA_DIR}/nih_awards_last_90d.csv`;

const fmtUSD = n => new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(+n || 0);

async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const text = await res.text();
  return new Promise((resolve) => {
    Papa.parse(text, { header: true, dynamicTyping: true, complete: (r) => resolve(r.data) });
  });
}

async function render() {
  const [recipsRaw, awardsRaw] = await Promise.all([loadCSV(TOP_RECIP), loadCSV(AWARDS)]);

  const recips = recipsRaw
    .filter(r => r["Recipient Name"])
    .sort((a,b) => (b["Award Amount"]||0) - (a["Award Amount"]||0));

  const topNInput = document.getElementById("topN");
  function drawChart() {
    const N = Math.min(Math.max(+topNInput.value || 25, 1), 100);
    const top = recips.slice(0, N);
    const data = [{
      type: "bar",
      x: top.map(d => d["Award Amount"] || 0),
      y: top.map(d => d["Recipient Name"]),
      orientation: "h",
      hovertemplate: "<b>%{y}</b><br>%{x:$,~s}<extra></extra>"
    }];
    const layout = { margin:{l:260,r:20,t:10,b:40}, xaxis:{title:"Total (USD)"} };
    Plotly.newPlot("chart", data, layout, {displayModeBar:false});
  }
  topNInput.addEventListener("input", drawChart);
  drawChart();

  // Table
  const awards = awardsRaw.map(row => {
    const obj = {};
    for (const [k,v] of Object.entries(row)) obj[k.toLowerCase()] = v;
    return {
      action_date: obj["action date"] ?? obj["action_date"] ?? null,
      recipient_name: obj["recipient name"] ?? obj["recipient_name"] ?? null,
      award_amount: obj["award amount"] ?? obj["award_amount"] ?? null,
      piid: obj["piid"] ?? null
    };
  });

  const thead = document.querySelector("#awardsTable thead");
  const tbody = document.querySelector("#awardsTable tbody");
  thead.innerHTML = `<tr><th>Action Date</th><th>Recipient Name</th><th>Award Amount</th><th>PIID</th></tr>`;
  tbody.innerHTML = awards.slice(0, 500).map(r => `
    <tr>
      <td>${r.action_date ?? ""}</td>
      <td>${r.recipient_name ?? ""}</td>
      <td>${r.award_amount != null ? fmtUSD(r.award_amount) : ""}</td>
      <td>${r.piid ?? ""}</td>
    </tr>
  `).join("");

  const total = awards.reduce((s,r)=> s + (+r.award_amount || 0), 0);
  document.getElementById("summary").textContent =
    `Rows shown: ${Math.min(500, awards.length)} of ${awards.length} · Total: ${fmtUSD(total)}`;
}

render().catch(err => {
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#c33">${err.stack || err}</pre>`);
});
