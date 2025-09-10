/* NIH Awards Tracker – app.js
 * - Top recipients (All vs SB/8(a))
 * - US map w/ PSC & NAICS filters
 * - State drill-down (outline + county borders) + recipient points by ZIP
 * - Recent awards table + recent awardees table
 * - Robust header normalization & defensive guards
 */

/* ================= config & helpers ================= */

const DEBUG = false;
const debug = (m, ...rest) => { if (DEBUG) console.log(m, ...rest); };

const bust = () => `?t=${Date.now()}`;

// Base URL from Jekyll; ignore it in Codespaces/local dev
let BASE = window.__NIH_BASEURL__ || "";
const H = location.hostname;
if (H === "localhost" || H.endsWith(".app.github.dev")) BASE = "";

// Prefer URLs injected from the page; fallback to BASE/data/...
const U = window.APP_DATA_URLS || {};
const DATA_DIR = `${BASE}/data`;

const AWARDS_URL           = (U.AWARDS           || `${DATA_DIR}/nih_awards_last_90d.csv`)                  + bust();
const TOP_RECIP_URL        = (U.TOP_RECIP        || `${DATA_DIR}/nih_top_recipients_last_90d.csv`)          + bust();
const TOP_RECIP_ENRICH_URL = (U.TOP_RECIP_ENRICH || `${DATA_DIR}/nih_top_recipients_last_90d_enriched.csv`) + bust();
const ZIP_CENTROIDS_URL    = `${DATA_DIR}/zip_centroids.json${bust()}`;

// Expose for DevTools
window.AWARDS_URL           = AWARDS_URL;
window.TOP_RECIP_URL        = TOP_RECIP_URL;
window.TOP_RECIP_ENRICH_URL = TOP_RECIP_ENRICH_URL;
window.ZIP_CENTROIDS_URL    = ZIP_CENTROIDS_URL;

const fmtUSD = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    .format(+n || 0);

const toNum = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0;

const careersUrl = (name) =>
  `https://www.google.com/search?q=${encodeURIComponent(`${name} careers jobs`)}`;

const $ = (id) => document.getElementById(id);

// Global UI state (guarded so re-loading the file doesn’t redeclare)
window.MAP_MODE       = window.MAP_MODE       ?? "us";   // "us" | "state"
window.CURRENT_STATE  = window.CURRENT_STATE  ?? null;    // 2-letter postal
window.POINT_TRACE_ID = window.POINT_TRACE_ID ?? null;    // Plotly trace index

// Data bucket so helpers can access after render initializes it
window.__DATA__ = window.__DATA__ || { awards: [], awardsPos: [], recipsAll: [] };
const DATA = window.__DATA__;

/* ---- Precomputed ZIP centroids (no live geocoding) ---- */
let ZIPS = null;
async function loadZipCentroids() {
  if (ZIPS) return ZIPS;
  try {
    const res = await fetch(ZIP_CENTROIDS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`zip centroids ${res.status}`);
    ZIPS = await res.json();
  } catch (e) {
    console.warn("zip_centroids.json not found or failed to load. Points disabled.", e);
    ZIPS = {};
  }
  return ZIPS;
}

/* ================= CSV loading ================= */

async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  debug("fetch", url, "->", res.status);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const text = await res.text();
  return new Promise((resolve) =>
    Papa.parse(text, { header: true, dynamicTyping: true, complete: (r) => resolve(r.data) })
  );
}

async function loadRecipientsOrFallback() {
  try { return await loadCSV(TOP_RECIP_ENRICH_URL); } catch (e) { debug(e.message); }
  try { return await loadCSV(TOP_RECIP_URL);        } catch (e) { debug(e.message); }
  return null;
}

/* ================= SB/8(a) detection ================= */

const SB_PATTERNS = [
  /8\(?a\)?/i,
  /small\s*business/i,
  /\bSBA\b/i, /\bSDB\b/i,
  /women[-\s]?owned/i, /\bWOSB\b|\bEDWOSB\b/i,
  /\bHUBZone\b/i,
  /service[-\s]?disabled/i, /veteran/i,
];

function getSetAsideFromRow(_orig, lowerRow) {
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

/* ================= normalization helpers ================= */

function normalizeAwardRow(row) {
  // lowercase-keyed copy to match title-case headers
  const lower = {};
  for (const [k, v] of Object.entries(row || {})) lower[String(k || "").toLowerCase()] = v;

  const action_date = lower["action date"] ?? lower["action_date"] ?? lower["actiondate"] ?? null;
  const recipient   = (lower["recipient name"] ?? lower["recipient_name"] ?? "").trim();
  const amount      = toNum(lower["award amount"] ?? lower["transaction amount"] ?? lower["award_amount"]);
  const piid        = lower["piid"] ?? lower["piid "] ?? null; // tolerate odd spaces

  const stateCode   = (lower["place of performance state code"] ??
                       lower["primary place of performance state code"] ?? "")
                      .toString().slice(0, 2).toUpperCase();
  const stateName   = lower["place of performance state name"] ??
                      lower["primary place of performance"] ?? "";

  // city + zip from CSV
  const city   = lower["place of performance city name"] ??
                 lower["primary place of performance city name"] ?? "";
  const zipRaw = lower["place of performance zip code"] ??
                 lower["primary place of performance zip code"] ??
                 lower["place of performance zip code (+4)"] ?? "";
  const zip5   = String(zipRaw).slice(0, 5);

  // coords: use CSV values if present; otherwise null (we fill from ZIPS later)
  const lat = lower["latitude"]  != null ? +lower["latitude"]  : null;
  const lon = lower["longitude"] != null ? +lower["longitude"] : null;

  const psc       = lower["product or service code (psc)"] ?? lower["psc"] ?? "";
  const pscDesc   = lower["psc description"] ?? "";
  const naics     = lower["naics code"] ?? lower["naics"] ?? "";
  const naicsDesc = lower["naics description"] ?? "";

  const setAside  = getSetAsideFromRow(row, lower);

  return {
    action_date,
    recipient_name: recipient,
    award_amount: amount,
    piid,
    set_aside: setAside,
    state: stateCode,
    state_name: stateName,
    pop_city: city,
    pop_zip5: zip5,
    lat,
    lon,
    psc,
    psc_desc: pscDesc,
    naics,
    naics_desc: naicsDesc,
  };
}

/* ================= map aggregation / filters ================= */

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

/* ================= topojson + drilldown ================= */

// TopoJSON sources (CDN)
const US_ATLAS_STATES   = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";
const US_ATLAS_COUNTIES = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";

// Cache
let _statesTopo = null, _countiesTopo = null;
let _statesGeo  = null, _countiesGeo  = null;

// Map state postal -> FIPS (2-digit)
const STATE_FIPS = {
  AL:"01", AK:"02", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", FL:"12",
  GA:"13", HI:"15", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22",
  ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30", NE:"31",
  NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38", OH:"39", OK:"40",
  OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47", TX:"48", UT:"49", VT:"50",
  VA:"51", WA:"53", WV:"54", WI:"55", WY:"56", DC:"11"
};

async function ensureTopo() {
  if (typeof topojson === "undefined") {
    console.error("topojson-client not loaded. Include it before app.js.");
    return;
  }
  if (!_statesTopo)   _statesTopo   = await (await fetch(US_ATLAS_STATES)).json();
  if (!_countiesTopo) _countiesTopo = await (await fetch(US_ATLAS_COUNTIES)).json();
  if (!_statesGeo)    _statesGeo    = topojson.feature(_statesTopo, _statesTopo.objects.states);
  if (!_countiesGeo)  _countiesGeo  = topojson.feature(_countiesTopo, _countiesTopo.objects.counties);
}

/* ================= state drilldown & points ================= */

function buildPointsForState(stateCode, awardsPos, pscPrefix, naicsPrefix) {
  if (!ZIPS) return null;

  // Aggregate by recipient+ZIP so multiple awards at same ZIP aren’t all separate
  const by = {};
  for (const r of awardsPos) {
    if (r.state !== stateCode) continue;
    if (!passesCodeFilters(r, pscPrefix, naicsPrefix)) continue;
    const amt = +r.award_amount || 0;
    if (amt <= 0) continue;
    const zip = String(r.pop_zip5 || "").slice(0, 5);
    const z   = zip && ZIPS[zip] ? ZIPS[zip] : null;
    if (!z || z.lat == null || z.lon == null) continue;

    const key = `${zip}__${r.recipient_name || ""}`;
    if (!by[key]) by[key] = { lat: z.lat, lon: z.lon, name: r.recipient_name || "", zip, amount: 0, count: 0 };
    by[key].amount += amt;
    by[key].count  += 1;
  }

  const pts = Object.values(by);
  if (!pts.length) return null;

  // sqrt size scaling
  const vmax = Math.max(...pts.map(p => p.amount), 1);
  const min = 6, max = 28, k = (max - min) / Math.sqrt(vmax);

  return {
    type: "scattergeo",
    mode: "markers",
    lat:  pts.map(p => p.lat),
    lon:  pts.map(p => p.lon),
    text: pts.map(p => `<b>${p.name}</b><br>${fmtUSD(p.amount)} · ${p.count} award(s)<br>${p.zip}`),
    hovertemplate: "%{text}<extra></extra>",
    marker: {
      size: pts.map(p => min + k * Math.sqrt(p.amount || 0)),
      line: { width: 0.5, color: "#333" },
      opacity: 0.85
    },
    name: "Recipients",
    showlegend: false
  };
}

async function drawStateDrilldown(stateCode, pscPrefix, naicsPrefix) {
  await ensureTopo();
  await loadZipCentroids();

  const fips = STATE_FIPS[stateCode];
  if (!fips || !_statesGeo || !_countiesGeo) return;

  // --- outline layers ---
  const stateFeat = _statesGeo.features.find(f => String(f.id).padStart(2, "0") === fips);
  const counties  = _countiesGeo.features.filter(f => String(f.id).padStart(5,"0").slice(0,2) === fips);

  const stateFill = {
    type: "choropleth",
    geojson: { type:"FeatureCollection", features:[stateFeat] },
    locations: [stateFeat.id],
    featureidkey: "id",
    z: [1],
    showscale: false,
    marker: { line: { width: 1, color: "#444" } },
    hovertemplate: `${stateCode}<extra></extra>`,
    name: "state",
    showlegend: false
  };

  const countyOutlines = [];
  counties.forEach(c => {
    const polys = c.geometry.type === "MultiPolygon" ? c.geometry.coordinates : [c.geometry.coordinates];
    polys.forEach(poly => {
      const outer = poly[0];
      countyOutlines.push({
        type: "scattergeo",
        mode: "lines",
        lat: outer.map(p => p[1]),
        lon: outer.map(p => p[0]),
        line: { width: 0.7, color: "#999" },
        hoverinfo: "skip",
        showlegend: false,
        name: "county"
      });
    });
  });

  await Plotly.newPlot("map", [stateFill, ...countyOutlines], {
    geo: { scope: "usa", fitbounds: "locations" },
    margin: { l:10, r:10, t:10, b:10 },
    showlegend: false
  }, { displayModeBar:false });

  // Recipient points by ZIP (filtered)
  const pts = buildPointsForState(stateCode, DATA.awardsPos, pscPrefix, naicsPrefix);
  window.POINT_TRACE_ID = null;
  if (pts) {
    const inds = await Plotly.addTraces("map", [pts]);
    window.POINT_TRACE_ID = Array.isArray(inds) ? inds[0] : inds;
  }

  // UI state
  window.MAP_MODE = "state";
  window.CURRENT_STATE = stateCode;
  $("backToUS")?.style?.setProperty("display", "inline-block");
}

/* ================= national map ================= */

function drawRecipientsList(stateCode, pscPrefix, naicsPrefix) {
  const top = topRecipientsForState(DATA.awards, stateCode, pscPrefix, naicsPrefix, 200);
  $("stateTitle").textContent = `Recipients in ${stateCode}`;

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
}

async function drawUSMap(pscPrefix, naicsPrefix, metric) {
  const by = aggregateByState(DATA.awardsPos, metric, pscPrefix, naicsPrefix);
  const states = Object.keys(by);
  const z = states.map((s) => (metric === "amount" ? by[s].amount : by[s].count));

  if (!states.length) {
    const map = $("map");
    if (map) map.innerHTML = "<p><em>No data for current filters.</em></p>";
    const note = $("mapNote");
    if (note) note.textContent = (pscPrefix || naicsPrefix)
      ? "Try clearing or changing PSC/NAICS filters."
      : "";
    return;
  }

  const text = states.map((s) => {
    const a = by[s];
    return `${s}: ${metric === "amount" ? fmtUSD(a.amount) : `${a.count} awards`}`;
  });

  await Plotly.newPlot(
    "map",
    [{
      type: "choropleth",
      locationmode: "USA-states",
      locations: states,
      z: z,
      text: text,
      colorbar: { title: metric === "amount" ? "USD" : "Count" },
      name: "usa",
      showscale: true,
      showlegend: false
    }],
    { geo: { scope: "usa", projection: { type: "albers usa" } }, margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend:false },
    { displayModeBar: false }
  );

  const mapEl = $("map");
  if (mapEl) {
    mapEl.on("plotly_click", async (ev) => {
      const loc = ev.points?.[0]?.location; // e.g., "MD"
      if (!loc) return;
      drawRecipientsList(loc, pscPrefix, naicsPrefix);
      await drawStateDrilldown(loc, pscPrefix, naicsPrefix);
    });
  }

  // Reset national view state
  window.MAP_MODE = "us";
  window.CURRENT_STATE = null;
  $("backToUS")?.style?.setProperty("display", "none");
  window.POINT_TRACE_ID = null;
}

/* ================= main ================= */

async function render() {
  // Load data
  const [recipsMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS_URL).catch((e) => { debug(e.message); return []; }),
  ]);

  debug("awardsRaw length:", awardsRaw.length, "recipsMaybe length:", recipsMaybe ? recipsMaybe.length : null);

  // Normalize and store
  const awardsAllRows = awardsRaw.map(normalizeAwardRow);
  DATA.awards    = awardsAllRows;
  DATA.awardsPos = awardsAllRows.filter(r => (+r.award_amount || 0) > 0);

  // --- Top recipients (All vs SB/8a) ---
  const recipsAll = (
    recipsMaybe ??
    (() => {
      const by = {};
      for (const r of DATA.awardsPos) if (r.recipient_name)
        by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
      return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: null }));
    })()
  ).map((r) => ({
    name: r["Recipient Name"] ?? r["recipient_name"] ?? r.name ?? "",
    amount: toNum(r["Award Amount"] ?? r["award_amount"] ?? r.amount),
    set_aside: r["Type of Set Aside"] ?? r["Type Of Set Aside"] ?? r["type_of_set_aside"] ?? r.set_aside ?? null,
  })).filter((r) => r.name);

  DATA.recipsAll = recipsAll;

  // UI refs
  const topNInput  = $("topN");
  const tabAllBtn  = $("tab-all") || $("tabAll");
  const tabSBBtn   = $("tab-sb")  || $("tabSB");
  const chartTitle = $("chartTitle");

  let currentTab = "all";

  function dataForTab() {
    const base = (currentTab === "sb"
      ? (() => {
          const by = {};
          for (const r of DATA.awardsPos) {
            if (!r.recipient_name) continue;
            if (!isSmallBusinessSetAside(r.set_aside)) continue;
            by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
          }
          return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: "SB/8(a)" }));
        })()
      : DATA.recipsAll
    ).slice().sort((a, b) => b.amount - a.amount);

    const N = Math.min(Math.max(+topNInput?.value || 25, 1), 200);
    return base.slice(0, N);
  }

  function drawChart() {
    const top = dataForTab();
    const chartEl = $("chart");
    if (!top.length) {
      if (chartEl) chartEl.innerHTML = "<p><em>No recipient data available for this tab.</em></p>";
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
    if (chartEl) {
      chartEl.on("plotly_click", (ev) => {
        const name = ev.points?.[0]?.y;
        if (name) window.open(careersUrl(name), "_blank");
      });
    }
  }

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

  if (topNInput) topNInput.addEventListener("input", drawChart);
  if (tabAllBtn) tabAllBtn.addEventListener("click", () => setTab("all"));
  if (tabSBBtn)  tabSBBtn.addEventListener("click", () => setTab("sb"));
  setTab("all");

  /* ----- Maps & filters ----- */

  const pscInput    = $("pscFilter");
  const naicsInput  = $("naicsFilter");
  const metricSel   = $("aggMetric");
  const applyBtn    = $("applyFilters");
  const clearBtn    = $("clearSelection");
  const backBtn     = $("backToUS");
  const toggleBtn   = $("togglePoints");

  async function redraw() {
    const psc   = (pscInput?.value   || "").trim();
    const naics = (naicsInput?.value || "").trim();
    const metric = metricSel?.value || "amount";

    if (window.MAP_MODE === "state" && window.CURRENT_STATE) {
      drawRecipientsList(window.CURRENT_STATE, psc, naics);
      await drawStateDrilldown(window.CURRENT_STATE, psc, naics);
    } else {
      await drawUSMap(psc, naics, metric);
    }
  }

  await drawUSMap((pscInput?.value||""), (naicsInput?.value||""), (metricSel?.value||"amount"));

  applyBtn?.addEventListener("click", () => { redraw(); });
  metricSel?.addEventListener("change", () => { redraw(); });

  clearBtn?.addEventListener("click", async () => {
    if (pscInput)   pscInput.value = "";
    if (naicsInput) naicsInput.value = "";
    $("stateTitle").textContent   = "Click a state";
    $("stateSummary").textContent = "";
    $("stateList").innerHTML      = "";
    window.MAP_MODE = "us";
    window.CURRENT_STATE = null;
    $("backToUS")?.style?.setProperty("display", "none");
    await drawUSMap("", "", metricSel?.value || "amount");
  });

  backBtn?.addEventListener("click", async () => {
    window.MAP_MODE = "us";
    window.CURRENT_STATE = null;
    $("backToUS")?.style?.setProperty("display", "none");
    $("stateTitle").textContent   = "Click a state";
    $("stateSummary").textContent = "";
    $("stateList").innerHTML      = "";
    await drawUSMap(pscInput?.value || "", naicsInput?.value || "", metricSel?.value || "amount");
  });

  toggleBtn?.addEventListener("click", async (ev) => {
    const gd = $("map");
    if (!gd || window.MAP_MODE !== "state" || window.POINT_TRACE_ID == null) return;
    const current = gd.data[window.POINT_TRACE_ID];
    const isHidden = current.visible === "legendonly" || current.visible === false;
    await Plotly.restyle(gd, { visible: isHidden ? true : "legendonly" }, window.POINT_TRACE_ID);
    ev.currentTarget.textContent = isHidden ? "Hide recipient points" : "Show recipient points";
  });

  /* ----- Recent awards table (raw) ----- */

  const thead = document.querySelector("#awardsTable thead");
  const tbody = document.querySelector("#awardsTable tbody");
  let awardsSlice = 500;

  function renderAwardsTable() {
    if (!thead || !tbody) return;

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

    tbody.innerHTML = DATA.awards.slice(0, awardsSlice).map((r) => `
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
    if (summary) summary.textContent = `Rows shown: ${Math.min(awardsSlice, DATA.awards.length)} of ${DATA.awards.length}`;
  }

  renderAwardsTable();

  const showMoreBtn = $("showMore");
  if (showMoreBtn) {
    showMoreBtn.addEventListener("click", () => {
      awardsSlice = Math.min(awardsSlice + 1000, DATA.awards.length);
      renderAwardsTable();
      if (awardsSlice >= DATA.awards.length) showMoreBtn.disabled = true;
    });
  }

  /* ----- Recent awardees (aggregated recipients) ----- */

  const awHead = document.querySelector('#awardeesTable thead');
  const awBody = document.querySelector('#awardeesTable tbody');

  if (awHead && awBody) {
    awHead.innerHTML = `<tr><th>Recipient</th><th>Total Obligated</th></tr>`;

    function renderAwardeesTable(N = 200) {
      const rows = DATA.recipsAll.slice().sort((a,b) => b.amount - a.amount).slice(0, N);
      awBody.innerHTML = rows.map(r =>
        `<tr><td>${r.name}</td><td>${fmtUSD(r.amount)}</td></tr>`
      ).join('');

      const sum = rows.reduce((s,r) => s + (r.amount || 0), 0);
      const info = $("awardeesSummary");
      if (info) info.textContent = `Top ${rows.length} recipients · ${fmtUSD(sum)} total`;
    }

    renderAwardeesTable();
  }

  // Expose for quick console checks
  window._awards    = DATA.awards;
  window._awardsPos = DATA.awardsPos;
}

/* ================= run ================= */

render().catch((err) => {
  console.error(err);
  const el = $("debug");
  if (el) el.innerHTML = `<pre style="color:#c33">${err.stack || err}</pre>`;
});
