/* NIH Awards Tracker – web/app.js
 * - Robust header normalization (works with title-case CSV headers)
 * - All vs SB/8(a) tabs
 * - US map with PSC/NAICS filters and clickable state details
 * - Careers links
 */

// =============== config & helpers ===============
const DEBUG = false;
const debug = (m) => { if (DEBUG) console.log(m); };

const bust = () => `?t=${Date.now()}`;
// base URL for GitHub Pages
const BASE = window.__NIH_BASEURL__ || "";
const DATA_DIR = `${BASE}/data`;

const bust = () => `?t=${Date.now()}`;
const TOP_RECIP_ENRICH = `${DATA_DIR}/nih_top_recipients_last_90d_enriched.csv${bust()}`;
const TOP_RECIP        = `${DATA_DIR}/nih_top_recipients_last_90d.csv${bust()}`;
const AWARDS           = `${DATA_DIR}/nih_awards_last_90d.csv${bust()}`;

const fmtUSD = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    .format(+n || 0);

const toNum = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0;

const careersUrl = (name) =>
  `https://www.google.com/search?q=${encodeURIComponent(`${name} careers jobs`)}`;

const $ = (id) => document.getElementById(id);

// =============== CSV loading ===============
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
  try { return await loadCSV(TOP_RECIP_ENRICH); } catch (e) { debug(e.message); }
  try { return await loadCSV(TOP_RECIP);        } catch (e) { debug(e.message); }
  return null;
}

// =============== set-aside (SB/8a) detection ===============
const SB_PATTERNS = [
  /8\(?a\)?/i,
  /small\s*business/i,
  /\bSBA\b/i, /\bSDB\b/i,
  /women[-\s]?owned/i, /\bWOSB\b|\bEDWOSB\b/i,
  /\bHUBZone\b/i,
  /service[-\s]?disabled/i, /veteran/i,
];

function getSetAsideFromRow(originalRow, lowerRow) {
  // prefer explicit keys; otherwise any key that mentions set-aside or business size
  const candidates = [
    "type of set aside",
    "contracting officer business size determination",
    "business size",
  ];
  for (const k of candidates) if (k in lowerRow) return lowerRow[k];
  const loose = Object.keys(lowerRow).find((k) => /set.?aside|business.*size/.test(k));
  return loose ? lowerRow[loose] : null;
}

function isSmallBusinessSetAside(text) {
  if (!text) return false;
  const s = String(text);
  return SB_PATTERNS.some((rx) => rx.test(s));
}

// =============== normalization helpers (YOUR headers) ===============
function normalizeAwardRow(row) {
  // make a lowercase-keyed copy so we can match title-case headers
  const lower = {};
  for (const [k, v] of Object.entries(row || {})) lower[String(k || "").toLowerCase()] = v;

  // exact header names in your CSV (title-case) become these lowercase keys:
  // "Product Or Service Code (Psc)" -> "product or service code (psc)"
  // "Naics Code"                    -> "naics code"
  // "Place Of Performance State Code" -> "place of performance state code"

  const action_date   = lower["action date"] ?? lower["action_date"] ?? lower["actiondate"] ?? null;
  const recipient     = (lower["recipient name"] ?? lower["recipient_name"] ?? "").trim();
  const amount        = toNum(lower["award amount"] ?? lower["award_amount"]);
  const piid          = lower["piid"] ?? lower["piid "] ?? null; // tolerate odd spaces
  const stateCode     = (lower["place of performance state code"] ?? "").toString().slice(0, 2).toUpperCase();
  const stateName     = lower["place of performance state name"] ?? "";
  const psc           = lower["product or service code (psc)"] ?? lower["psc"] ?? "";
  const pscDesc       = lower["psc description"] ?? "";
  const naics         = lower["naics code"] ?? lower["naics"] ?? "";
  const naicsDesc     = lower["naics description"] ?? "";
  const setAside      = getSetAsideFromRow(row, lower);

  return {
    action_date,
    recipient_name: recipient,
    award_amount: amount,
    piid,
    set_aside: setAside,
    state: stateCode,
    state_name: stateName,
    psc,
    psc_desc: pscDesc,
    naics,
    naics_desc: naicsDesc,
  };
}

// =============== map aggregation / filters ===============
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

function topRecipientsForState(awards, stateCode, pscPrefix, naicsPrefix, limit = 100) {
  const by = {};
  for (const r of awards) {
    if (r.state !== stateCode) continue;
    if (!passesCodeFilters(r, pscPrefix, naicsPrefix)) continue;
    const name = r.recipient_name || "";
    if (!name) continue;
    if (!by[name]) by[name] = { amount: 0, count: 0 };
    by[name].amount += (+r.award_amount || 0);
    by[name].count  += 1;
  }
  const rows = Object.entries(by).map(([name, v]) => ({ name, ...v }));
  rows.sort((a, b) => b.amount - a.amount || b.count - a.count);
  return rows.slice(0, limit);
}

// =============== main ===============
async function render() {
  const [recipsMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS).catch((e) => { debug(e.message); return []; }),
  ]);

  const awards = awardsRaw.map(normalizeAwardRow);

  // ----- Top recipients (All vs SB/8a) -----
  const recipsAll = (
    recipsMaybe ??
    (() => {
      const by = {};
      for (const r of awards) if (r.recipient_name)
        by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
      return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: null }));
    })()
  ).map((r) => ({
    name: r["Recipient Name"] ?? r["recipient_name"] ?? r.name ?? "",
    amount: toNum(r["Award Amount"] ?? r["award_amount"] ?? r.amount),
    set_aside: r["Type of Set Aside"] ?? r["Type Of Set Aside"] ?? r["type_of_set_aside"] ?? r.set_aside ?? null,
  })).filter((r) => r.name);

  const recipsSB = (() => {
    const by = {};
    for (const r of awards) {
      if (!r.recipient_name) continue;
      if (!isSmallBusinessSetAside(r.set_aside)) continue;
      by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
    }
    return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: "SB/8(a)" }));
  })();

  // ----- Chart (tabs) -----
  const topNInput  = $("topN");
  const tabAllBtn  = $("tab-all") || $("tabAll");
  const tabSBBtn   = $("tab-sb")  || $("tabSB");
  const chartTitle = $("chartTitle");

  let currentTab = "all";
  function setTab(tab) {
    currentTab = tab;
    if (tabAllBtn && tabSBBtn) {
      tabAllBtn.classList.toggle("active", tab === "all");
      tabSBBtn.classList.toggle("active",  tab === "sb");
    }
    if (chartTitle) {
      chartTitle.textContent = tab === "sb"
        ? "Top recipients — Small business / 8(a) only"
        : "Top recipients (by obligated amount)";
    }
    drawChart();
  }

  function dataForTab() {
    const base = (currentTab === "sb" ? recipsSB : recipsAll)
      .slice()
      .sort((a, b) => b.amount - a.amount);
    const N = Math.min(Math.max(+topNInput.value || 25, 1), 100);
    return base.slice(0, N);
  }

  function drawChart() {
    const top = dataForTab();
    if (!top.length) {
      $("chart").innerHTML = "<p><em>No recipient data available for this tab.</em></p>";
      return;
    }
    const hover = top.map(
      (d) => `<b>${d.name}</b><br>${fmtUSD(d.amount)}${d.set_aside ? `<br>${d.set_aside}` : ""}<br><i>Click to open careers</i>`
    );
    Plotly.newPlot(
      "chart",
      [{
        type: "bar",
        x: top.map((d) => d.amount),
        y: top.map((d) => d.name),
        orientation: "h",
        hovertemplate: hover.map((h) => h + "<extra></extra>"),
      }],
      { margin: { l: 260, r: 20, t: 10, b: 40 }, xaxis: { title: "Total (USD)" } },
      { displayModeBar: false }
    );

    $("chart").on("plotly_click", (ev) => {
      const name = ev.points?.[0]?.y;
      if (name) window.open(careersUrl(name), "_blank");
    });
  }

  if (topNInput) topNInput.addEventListener("input", drawChart);
  if (tabAllBtn) tabAllBtn.addEventListener("click", () => setTab("all"));
  if (tabSBBtn)  tabSBBtn.addEventListener("click",  () => setTab("sb"));
  setTab("all");

  // ----- US Map + filters -----
  function drawUSMap() {
    const pscPrefix   = ($("pscFilter")?.value || "").trim();
    const naicsPrefix = ($("naicsFilter")?.value || "").trim();
    const metric      = $("aggMetric").value;

    const by = aggregateByState(awards, metric, pscPrefix, naicsPrefix);
    const states = Object.keys(by);
    const z = states.map((s) => (metric === "amount" ? by[s].amount : by[s].count));

    if (!states.length) {
      $("map").innerHTML = "<p><em>No data for current filters.</em></p>";
      $("mapNote").textContent = (pscPrefix || naicsPrefix)
        ? "Try clearing or changing PSC/NAICS filters."
        : "";
      return;
    }

    const text = states.map((s) => {
      const a = by[s];
      return `${s}: ${metric === "amount" ? fmtUSD(a.amount) : `${a.count} awards`}`;
    });

    Plotly.newPlot(
      "map",
      [{
        type: "choropleth",
        locationmode: "USA-states",
        locations: states,
        z: z,
        text: text,
        colorbar: { title: metric === "amount" ? "USD" : "Count" },
      }],
      { geo: { scope: "usa", projection: { type: "albers usa" } }, margin: { l: 10, r: 10, t: 10, b: 10 } },
      { displayModeBar: false }
    );

    $("map").on("plotly_click", (ev) => {
      const loc = ev.points?.[0]?.location; // e.g., "MD"
      if (!loc) return;

      const top = topRecipientsForState(awards, loc, pscPrefix, naicsPrefix, 200);
      $("stateTitle").textContent = `Recipients in ${loc}`;

      if (!top.length) {
        $("stateList").innerHTML = "<li class='muted'>No recipients for current filters.</li>";
        $("stateSummary").textContent = "";
        return;
      }

      const totalAmt = top.reduce((s, r) => s + r.amount, 0);
      const totalCnt = top.reduce((s, r) => s + r.count, 0);
      $("stateSummary").textContent = `${top.length} recipients · ${totalCnt} awards · ${fmtUSD(totalAmt)} total`;

      $("stateList").innerHTML = top.map((r) => `
        <li>
          <strong>${r.name}</strong>
          — ${fmtUSD(r.amount)} (${r.count})
          · <a href="${careersUrl(r.name)}" target="_blank" rel="noopener">Search jobs</a>
        </li>
      `).join("");
    });
  }

  drawUSMap();
  $("applyFilters").addEventListener("click", () => {
    drawUSMap();
    $("stateTitle").textContent = "Click a state";
    $("stateSummary").textContent = "";
    $("stateList").innerHTML = "";
  });
  $("aggMetric").addEventListener("change", drawUSMap);
  const clearBtn = $("clearSelection");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    $("stateTitle").textContent = "Click a state";
    $("stateSummary").textContent = "";
    $("stateList").innerHTML = "";
  });

  // ----- Raw awards table -----
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

    const summary = $("summary");
    if (summary) summary.textContent = `Rows shown: ${Math.min(500, awards.length)} of ${awards.length}`;
  }
}

// =============== run ===============
render().catch((err) => {
  console.error(err);
  const el = document.getElementById("debug");
  if (el) el.innerHTML = `<pre style="color:#c33">${err.stack || err}</pre>`;
});
