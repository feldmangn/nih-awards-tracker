// ================== Config & helpers ==================
const DEBUG = false;
const debug = (m) => {
  if (!DEBUG) return;
  console.log(m);
  const d = document.getElementById("debug");
  if (d) d.insertAdjacentHTML("beforeend", `<div>${m}</div>`);
};

const bust = () => `?t=${Date.now()}`;
const DATA_DIR = "./data";
const TOP_RECIP_ENRICH = `${DATA_DIR}/nih_top_recipients_last_90d_enriched.csv${bust()}`;
const TOP_RECIP        = `${DATA_DIR}/nih_top_recipients_last_90d.csv${bust()}`;
const AWARDS           = `${DATA_DIR}/nih_awards_last_90d.csv${bust()}`;

const fmtUSD = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(+n || 0);

const toNum = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0;

const careersUrl = (name) =>
  `https://www.google.com/search?q=${encodeURIComponent(`${name} careers jobs`)}`;

const $id = (a, b) => document.getElementById(a) || document.getElementById(b);

// ================== CSV loading ==================
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
  try { return await loadCSV(TOP_RECIP_ENRICH); } catch(e){ debug(e.message); }
  try { return await loadCSV(TOP_RECIP); }        catch(e){ debug(e.message); }
  return null;
}

// ================== Set-aside (SB/8a) detection ==================
const SET_ASIDE_KEYS = [
  "Type of Set Aside",
  "Type Of Set Aside",
  "type_of_set_aside",
  "Set Aside Type",
  "Contracting Officer Business Size Determination",
  "contracting officer business size determination",
  "Business Size",
  "business size",
];

function getSetAsideFromRow(row) {
  if (!row) return null;
  for (const key of Object.keys(row)) {
    if (SET_ASIDE_KEYS.some((k) => k.toLowerCase() === String(key).toLowerCase())) {
      return row[key];
    }
  }
  const loose = Object.keys(row).find((k) => /set.?aside|business.*size/i.test(k));
  return loose ? row[loose] : null;
}

const SB_PATTERNS = [
  /8\(?a\)?/i,
  /small\s*business/i,
  /\bSBA\b/i,
  /\bSDB\b/i,
  /women[-\s]?owned/i,
  /\bWOSB\b|\bEDWOSB\b/i,
  /\bHUBZone\b/i,
  /service[-\s]?disabled/i,
  /veteran/i,
];

function isSmallBusinessSetAside(text) {
  if (!text) return false;
  const s = String(text);
  return SB_PATTERNS.some((rx) => rx.test(s));
}

// ================== Key detection for your title-case headers ==================
const PSC_KEYS = [
  "Product Or Service Code (Psc)",    // your file
  "Product or Service Code (PSC)",
  "Product or Service Code",
  "Product/Service Code",
  "Product Service Code",
  "PSC", "psc",
];

const PSC_DESC_KEYS = [
  "Psc Description",                  // your file
  "PSC Description",
  "psc description",
];

const NAICS_KEYS = [
  "Naics Code",                       // your file
  "NAICS Code",
  "NAICS",
  "naics code",
  "naics",
];

const NAICS_DESC_KEYS = [
  "Naics Description",                // your file
  "NAICS Description",
  "naics description",
];

const STATE_KEYS = [
  "Place Of Performance State Code",  // your file
  "Place of Performance State Code",
  "place of performance state code",
];

function getFirst(row, keys) {
  for (const k of keys) if (k in row) return row[k];
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [String(k).toLowerCase(), v])
  );
  for (const k of keys) {
    const lk = String(k).toLowerCase();
    if (lk in lower) return lower[lk];
  }
  return null;
}

// ================== Filters & aggregation (map) ==================
function passesCodeFilters(r, pscPrefix, naicsPrefix) {
  const p = (pscPrefix || "").trim().toUpperCase();
  const n = (naicsPrefix || "").trim();
  const pscOk   = !p || (r.psc && String(r.psc).toUpperCase().startsWith(p));
  const naicsOk = !n || (r.naics && String(r.naics).startsWith(n));
  return pscOk && naicsOk;
}

function aggregateByState(awards, metric, pscPrefix, naicsPrefix) {
  const by = {};
  for (const r of awards) {
    if (!r.state) continue;
    if (!passesCodeFilters(r, pscPrefix, naicsPrefix)) continue;
    if (!(r.state in by)) by[r.state] = { amount: 0, count: 0 };
    by[r.state].amount += (+r.award_amount || 0);
    by[r.state].count  += 1;
  }
  return by;
}

function topRecipientsForState(awards, stateCode, pscPrefix, naicsPrefix, limit=100) {
  const by = {};
  for (const r of awards) {
    if (!r.state || r.state !== stateCode) continue;
    if (!passesCodeFilters(r, pscPrefix, naicsPrefix)) continue;
    const name = r.recipient_name || "";
    if (!name) continue;
    if (!by[name]) by[name] = { amount: 0, count: 0 };
    by[name].amount += (+r.award_amount || 0);
    by[name].count  += 1;
  }
  const rows = Object.entries(by).map(([name, v]) => ({ name, ...v }));
  rows.sort((a,b) => b.amount - a.amount || b.count - a.count);
  return rows.slice(0, limit);
}

// ================== Main ==================
async function render() {
  const [recipsMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS).catch(e => { debug(e.message); return []; })
  ]);

  // normalize awards rows
  const awards = awardsRaw.map(row => {
    const lower = {};
    for (const [k,v] of Object.entries(row || {})) lower[String(k||"").toLowerCase()] = v;

    const psc      = getFirst(row, PSC_KEYS);
    const pscDesc  = getFirst(row, PSC_DESC_KEYS);
    const naics    = getFirst(row, NAICS_KEYS);
    const naicsDes = getFirst(row, NAICS_DESC_KEYS);
    const stateRaw = getFirst(row, STATE_KEYS);

    return {
      action_date:  lower["action date"] ?? lower["action_date"] ?? lower["actiondate"] ?? null,
      recipient_name: (lower["recipient name"] ?? lower["recipient_name"] ?? "").trim(),
      award_amount: toNum(lower["award amount"] ?? lower["award_amount"]),
      piid: lower["piid"] ?? lower["piid "] ?? null, // tolerate odd spacing
      set_aside: getSetAsideFromRow(row),
      psc, pscDesc,
      naics, naicsDesc: naicsDes,
      state: (stateRaw || "").toString().slice(0, 2).toUpperCase(),
    };
  });

  // ===== Top recipients rollups (All vs SB/8a) =====
  const recipsAll = (
    recipsMaybe ??
    (() => {
      const by = {};
      for (const r of awards) if (r.recipient_name)
        by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
      return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: null }));
    })()
  ).map(r => ({
    name:   r["Recipient Name"] ?? r["recipient_name"] ?? r.name ?? "",
    amount: toNum(r["Award Amount"] ?? r["award_amount"] ?? r.amount),
    set_aside: r["Type of Set Aside"] ?? r["Type Of Set Aside"] ?? r["type_of_set_aside"] ?? r.set_aside ?? null
  })).filter(r => r.name);

  const recipsSB = (() => {
    const by = {};
    for (const r of awards) {
      if (!r.recipient_name) continue;
      if (!isSmallBusinessSetAside(r.set_aside)) continue;
      by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
    }
    return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: "SB/8(a)" }));
  })();

  // ===== Top recipients chart (tabs) =====
  const topNInput  = document.getElementById("topN");
  const tabAllBtn  = $id("tabAll", "tab-all");
  const tabSBBtn   = $id("tabSB", "tab-sb");
  const chartTitle = document.getElementById("chartTitle");

  let currentTab = "all";
  function setTab(tab) {
    currentTab = tab;
    if (tabAllBtn && tabSBBtn) {
      tabAllBtn.classList.toggle("active", tab==="all");
      tabSBBtn.classList.toggle("active",  tab==="sb");
    }
    if (chartTitle) {
      chartTitle.textContent = tab==="sb"
        ? "Top recipients — Small business / 8(a) only"
        : "Top recipients (by obligated amount)";
    }
    drawChart();
  }

  function dataForTab() {
    const base = (currentTab === "sb" ? recipsSB : recipsAll)
      .slice()
      .sort((a,b) => b.amount - a.amount);
    const N = Math.min(Math.max(+topNInput.value || 25, 1), 100);
    return base.slice(0, N);
  }

  function drawChart() {
    const top = dataForTab();
    if (!top.length) {
      document.getElementById("chart").innerHTML =
        "<p><em>No recipient data available for this tab.</em></p>";
      return;
    }
    const hover = top.map(d =>
      `<b>${d.name}</b><br>${fmtUSD(d.amount)}${d.set_aside ? `<br>${d.set_aside}`:""}<br><i>Click to open careers</i>`
    );
    Plotly.newPlot("chart", [{
      type: "bar",
      x: top.map(d => d.amount),
      y: top.map(d => d.name),
      orientation: "h",
      hovertemplate: hover.map(h => h + "<extra></extra>")
    }], { margin:{l:260,r:20,t:10,b:40}, xaxis:{title:"Total (USD)"} }, {displayModeBar:false});

    const chart = document.getElementById("chart");
    chart.on("plotly_click", (ev) => {
      const name = ev.points?.[0]?.y;
      if (name) window.open(careersUrl(name), "_blank");
    });
  }

  if (topNInput) topNInput.addEventListener("input", drawChart);
  if (tabAllBtn) tabAllBtn.addEventListener("click", () => setTab("all"));
  if (tabSBBtn)  tabSBBtn.addEventListener("click",  () => setTab("sb"));
  setTab("all");

  // ===== US Map (choropleth) with PSC/NAICS filters =====
  function drawUSMap() {
    const pscPrefix   = (document.getElementById("pscFilter")?.value || "").trim();
    const naicsPrefix = (document.getElementById("naicsFilter")?.value || "").trim();
    const metric      = document.getElementById("aggMetric").value;

    const by = aggregateByState(awards, metric, pscPrefix, naicsPrefix);
    const states = Object.keys(by);
    const z = states.map(s => metric === "amount" ? by[s].amount : by[s].count);

    if (!states.length) {
      document.getElementById("map").innerHTML = "<p><em>No data for current filters.</em></p>";
      document.getElementById("mapNote").textContent =
        (pscPrefix || naicsPrefix) ? "Try clearing or changing PSC/NAICS filters." : "";
      return;
    }

    const text = states.map(s => {
      const a = by[s];
      return `${s}: ${metric === "amount" ? fmtUSD(a.amount) : a.count + " awards"}`;
    });

    const data = [{
      type: "choropleth",
      locationmode: "USA-states",
      locations: states,
      z: z,
      text: text,
      colorbar: { title: metric === "amount" ? "USD" : "Count" }
    }];

    const layout = {
      geo: { scope: "usa", projection: { type: "albers usa" } },
      margin: { l: 10, r: 10, t: 10, b: 10 },
    };

    Plotly.newPlot("map", data, layout, { displayModeBar: false });

    const mapEl = document.getElementById("map");
    mapEl.on("plotly_click", (ev) => {
      const loc = ev.points?.[0]?.location; // e.g., "MD"
      if (!loc) return;

      const top = topRecipientsForState(awards, loc, pscPrefix, naicsPrefix, 200);

      const title = document.getElementById("stateTitle");
      const list  = document.getElementById("stateList");
      const sum   = document.getElementById("stateSummary");

      title.textContent = `Recipients in ${loc}`;
      if (!top.length) {
        list.innerHTML = "<li class='muted'>No recipients for current filters.</li>";
        sum.textContent = "";
        return;
      }

      const totalAmt = top.reduce((s,r)=>s+r.amount,0);
      const totalCnt = top.reduce((s,r)=>s+r.count,0);
      sum.textContent = `${top.length} recipients · ${totalCnt} awards · ${fmtUSD(totalAmt)} total`;

      list.innerHTML = top.map(r => `
        <li>
          <strong>${r.name}</strong>
          — ${fmtUSD(r.amount)} (${r.count})
          · <a href="${careersUrl(r.name)}" target="_blank" rel="noopener">Search jobs</a>
        </li>
      `).join("");
    });
  }

  // Initial map + events
  drawUSMap();
  document.getElementById("applyFilters").addEventListener("click", () => {
    drawUSMap();
    document.getElementById("stateTitle").textContent = "Click a state";
    document.getElementById("stateSummary").textContent = "";
    document.getElementById("stateList").innerHTML = "";
  });
  document.getElementById("aggMetric").addEventListener("change", drawUSMap);
  const clearSelBtn = document.getElementById("clearSelection");
  if (clearSelBtn) {
    clearSelBtn.addEventListener("click", () => {
      document.getElementById("stateTitle").textContent = "Click a state";
      document.getElementById("stateSummary").textContent = "";
      document.getElementById("stateList").innerHTML = "";
    });
  }

  // ===== Raw awards table =====
  const thead = document.querySelector("#awardsTable thead");
  const tbody = document.querySelector("#awardsTable tbody");
  if (thead && tbody) {
    thead.innerHTML = `<tr>
      <th>Action Date</th>
      <th>Recipient Name</th>
      <th>Award Amount</th>
      <th>PIID</th>
      <th>Type of Set Aside / Size</th>
      <th>PSC</th>
      <th>NAICS</th>
      <th>Careers</th>
    </tr>`;

    tbody.innerHTML = awards.slice(0, 500).map((r) => `
      <tr>
        <td>${r.action_date ?? ""}</td>
        <td>${r.recipient_name ?? ""}</td>
        <td>${fmtUSD(r.award_amount)}</td>
        <td>${r.piid ?? ""}</td>
        <td>${r.set_aside ?? ""}</td>
        <td>${r.psc ?? ""}</td>
        <td>${r.naics ?? ""}</td>
        <td><a href="${careersUrl(r.recipient_name || "")}" target="_blank" rel="noopener">Search jobs</a></td>
      </tr>
    `).join("");

    const summary = document.getElementById("summary");
    if (summary) {
      summary.textContent = `Rows shown: ${Math.min(500, awards.length)} of ${awards.length}`;
    }
  }
}

// ================== Run ==================
render().catch((err) => {
  const msg = err.stack || err;
  console.error(msg);
  const el = document.getElementById("debug");
  if (el) el.innerHTML = `<pre style="color:#c33">${msg}</pre>`;
});
