/* NIH Awards Tracker – app.js (clean, consolidated)
 * - Top recipients (All vs SB/8(a))
 * - US choropleth + state drilldown (county outlines + recipient points)
 * - Recent awards table:
 *     • Collapsible section
 *     • Sortable headers
 *     • NAICS filter (client-side)
 *     • “Show more rows” paged rendering
 * - Robust header normalization for CSVs
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

// expose a quick selector
const $ = (id) => document.getElementById(id);

const fmtUSD = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    .format(+n || 0);

const toNum = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0;

const careersUrl = (name) =>
  `https://www.google.com/search?q=${encodeURIComponent(`${name} careers jobs`)}`;

/* ---- Top recipients: detect SB/8(a) from text ---- */
const SB_PATTERNS = [
  /8\(?a\)?/i,
  /small\s*business/i,
  /\bSBA\b/i, /\bSDB\b/i,
  /women[-\s]?owned/i, /\bWOSB\b|\bEDWOSB\b/i,
  /\bHUBZone\b/i,
  /service[-\s]?disabled/i, /veteran/i,
];
function isSmallBusinessSetAside(text) {
  if (!text) return false;
  const s = String(text);
  return SB_PATTERNS.some((rx) => rx.test(s));
}
function getSetAsideFromRow(_orig, lowerRow) {
  const candidates = [
    "type of set aside",
    "type_of_set_aside",
    "contracting officer business size determination",
    "business size",
  ];
  for (const k of candidates) if (k in lowerRow) return lowerRow[k];
  const loose = Object.keys(lowerRow).find((k) => /set.?aside|business.*size/.test(k));
  return loose ? lowerRow[loose] : null;
}

/* ================= CSV loading ================= */

async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  debug("fetch", url, "->", res.status);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const text = await res.text();
  return new Promise((resolve) =>
    Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true, complete: (r) => resolve(r.data) })
  );
}

async function loadRecipientsOrFallback() {
  try { return await loadCSV(TOP_RECIP_ENRICH_URL); } catch (e) { debug(e.message); }
  try { return await loadCSV(TOP_RECIP_URL);        } catch (e) { debug(e.message); }
  return null;
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

  const city   = lower["place of performance city name"] ??
                 lower["primary place of performance city name"] ?? "";
  const zipRaw = lower["place of performance zip code"] ??
                 lower["primary place of performance zip code"] ??
                 lower["place of performance zip code (+4)"] ?? "";
  const zip5   = String(zipRaw).slice(0, 5);

  // If CSV has these (optional), use them; else null (we attach from ZIP centroids for map)
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

// Map state postal -> FIPS (2-digit)
const STATE_FIPS = {
  AL:"01", AK:"02", AZ:"04", AR:"05", CA:"06", CO:"08", CT:"09", DE:"10", FL:"12",
  GA:"13", HI:"15", ID:"16", IL:"17", IN:"18", IA:"19", KS:"20", KY:"21", LA:"22",
  ME:"23", MD:"24", MA:"25", MI:"26", MN:"27", MS:"28", MO:"29", MT:"30", NE:"31",
  NV:"32", NH:"33", NJ:"34", NM:"35", NY:"36", NC:"37", ND:"38", OH:"39", OK:"40",
  OR:"41", PA:"42", RI:"44", SC:"45", SD:"46", TN:"47", TX:"48", UT:"49", VT:"50",
  VA:"51", WA:"53", WV:"54", WI:"55", WY:"56", DC:"11"
};

// Precomputed ZIP centroids (no live geocoding)
let ZIPS = null;
async function loadZipCentroids() {
  if (ZIPS) return ZIPS;
  try {
    const res = await fetch(ZIP_CENTROIDS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    ZIPS = await res.json();
  } catch (e) {
    console.warn("zip_centroids.json not found or failed to load. Points disabled.", e);
    ZIPS = {};
  }
  return ZIPS;
}

// Track map UI state
if (typeof window.MAP_MODE === "undefined") window.MAP_MODE = "us";
let POINT_TRACE_ID = null;

/* ================= state drilldown renderer ================= */

async function drawStateDrilldown(stateCode, awardsAll) {
  await ensureTopo();
  const fips = STATE_FIPS[stateCode];
  if (!fips || !_statesGeo || !_countiesGeo) return;

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
    hovertemplate: `${stateCode}<extra></extra>`
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
        showlegend: false
      });
    });
  });

  await Plotly.newPlot("map", [stateFill, ...countyOutlines], {
    geo: { scope: "usa", fitbounds: "locations" },
    margin: { l:10, r:10, t:10, b:10 },
    showlegend: false
  }, { displayModeBar:false });

  // Gather rows for this state with positive amounts
  const pscPrefix   = (document.getElementById("pscFilter")?.value || "").trim();
  const naicsPrefix = (document.getElementById("naicsFilter")?.value || "").trim();

  const inState = awardsAll.filter(r =>
    r.state === stateCode && (+r.award_amount || 0) > 0 && passesCodeFilters(r, pscPrefix, naicsPrefix)
  );

  await loadZipCentroids();

  // Attach coords from precomputed ZIPs if needed
  const rows = inState.map(r => {
    const zip = String(r.pop_zip5 || "").slice(0, 5);
    const z   = zip && ZIPS[zip] ? ZIPS[zip] : null;
    return {
      ...r,
      lat: r.lat ?? (z ? z.lat : null),
      lon: r.lon ?? (z ? z.lon : null)
    };
  });

  // Build marker arrays
  const pts  = rows.filter(r => r.lat != null && r.lon != null);
  const lat  = pts.map(r => r.lat);
  const lon  = pts.map(r => r.lon);
  const text = pts.map(r =>
    `<b>${r.recipient_name || "Unknown"}</b><br>${r.pop_city || ""}${r.pop_zip5 ? " " + r.pop_zip5 : ""}<br>${fmtUSD(r.award_amount)}`
  );

  debug(`[${stateCode}] rows: ${inState.length}  with coords: ${pts.length}`);

  POINT_TRACE_ID = null;
  if (lat.length) {
    Plotly.addTraces("map", [{
      type: "scattergeo",
      mode: "markers",
      lat, lon,
      text,
      hovertemplate: "%{text}<extra></extra>",
      marker: { size: 8, opacity: 0.85, line: { width: 0.5, color: "#333" } },
      name: "Recipients",
      showlegend: false
    }]).then((inds) => { POINT_TRACE_ID = inds && inds[0]; });
  }

  // UI state
  window.MAP_MODE = "state";
  const backBtn = $("backToUS");
  if (backBtn) backBtn.style.display = "inline-block";

  const toggleBtn = $("togglePoints");
  if (toggleBtn) {
    toggleBtn.style.display = lat.length ? "inline-block" : "none";
    toggleBtn.textContent = "Hide recipient points";
  }
}

/* ================= Recent awards (table) – state & helpers ================= */

// Global table state (single declarations)
let awards = [];                 // all normalized rows
let awardsFiltered = [];         // filtered subset
let awardsSlice = 50;            // default page size
let awardsFilter = { naics: "", psc: "", text: "" };
let awardsSort   = { key: "action_date", dir: "desc" };

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function parseDateLoose(s) { const d = new Date(s); return isNaN(d) ? null : d; }

function sortRows(rows) {
  const { key, dir } = awardsSort;
  const mult = dir === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    if (key === "award_amount") return mult * (toNum(a.award_amount) - toNum(b.award_amount));
    if (key === "action_date") {
      const da = parseDateLoose(a.action_date) || new Date(0);
      const db = parseDateLoose(b.action_date) || new Date(0);
      return mult * (da - db);
    }
    // string fields
    const sa = String(a[key] ?? "").toLowerCase();
    const sb = String(b[key] ?? "").toLowerCase();
    return mult * cmp(sa, sb);
  });
}

function applyAwardsFiltersAndRender() {
  awardsFiltered = awards.filter(r => {
    const okNaics = !awardsFilter.naics || String(r.naics || "").startsWith(awardsFilter.naics);
    const okPsc   = !awardsFilter.psc   || String(r.psc   || "").toUpperCase().startsWith(awardsFilter.psc.toUpperCase());
    const okText  = !awardsFilter.text  || String(r.recipient_name || "").toLowerCase().includes(awardsFilter.text.toLowerCase());
    return okNaics && okPsc && okText;
  });
  awardsSlice = Math.min(awardsSlice, awardsFiltered.length || 0);
  renderAwardsTable();
}

function renderAwardsTable() {
  const thead = document.querySelector("#awardsTable thead");
  const tbody = document.querySelector("#awardsTable tbody");
  if (!thead || !tbody) return;

  thead.innerHTML = `
    <tr>
      <th data-key="action_date"   class="sortable">Action Date</th>
      <th data-key="recipient_name" class="sortable">Recipient Name</th>
      <th data-key="award_amount"   class="sortable">Award Amount</th>
      <th data-key="piid"           class="sortable">PIID</th>
      <th data-key="set_aside"      class="sortable">Type of Set Aside / Size</th>
      <th data-key="psc"            class="sortable">PSC</th>
      <th data-key="naics"          class="sortable">NAICS</th>
      <th>Careers</th>
    </tr>`;

  // header sort indicators + click handlers
  thead.querySelectorAll("th.sortable").forEach(th => {
    const k = th.dataset.key;
    const active = (awardsSort.key === k);
    th.style.cursor = "pointer";
    th.textContent = th.textContent.replace(/[▲▼]$/, "");
    if (active) {
      th.textContent += awardsSort.dir === "asc" ? " ▲" : " ▼";
    }
    th.onclick = () => {
      if (awardsSort.key === k) {
        awardsSort.dir = (awardsSort.dir === "asc" ? "desc" : "asc");
      } else {
        awardsSort.key = k;
        awardsSort.dir = (k === "award_amount" || k === "action_date") ? "desc" : "asc";
      }
      renderAwardsTable();
    };
  });

  const rows = sortRows(awardsFiltered).slice(0, awardsSlice);

  tbody.innerHTML = rows.map((r) => `
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
  if (summary) summary.textContent =
    `Rows shown: ${Math.min(awardsSlice, awardsFiltered.length)} of ${awardsFiltered.length}`;
}

/* ================= main ================= */

async function render() {
  // Load data
  const [recipsMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS_URL).catch((e) => { debug(e.message); return []; }),
  ]);

  debug("AWARDS_URL:", AWARDS_URL);
  debug("TOP_RECIP_URL:", TOP_RECIP_URL);
  debug("TOP_RECIP_ENRICH_URL:", TOP_RECIP_ENRICH_URL);
  debug("awardsRaw length:", awardsRaw.length, "recipsMaybe length:", recipsMaybe ? recipsMaybe.length : null);

  // Normalize and initialize global table state
  const awardsAllRows = awardsRaw.map(normalizeAwardRow);
  awards = awardsAllRows;                      // all rows for tables/side list
  awardsFiltered = awards.slice();             // start unfiltered
  awardsSlice = Math.min(awardsSlice, awardsFiltered.length || 0);

  const awardsPos = awardsAllRows.filter(r => (+r.award_amount || 0) > 0); // positive amounts for charts/maps

  // Expose for console debugging
  window._awards = awards;
  window._awardsPos = awardsPos;

  /* ----- Top recipients (All vs SB/8a) ----- */

  const recipsAll = (
    recipsMaybe ??
    (() => {
      const by = {};
      for (const r of awardsPos) if (r.recipient_name)
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
    for (const r of awardsPos) {
      if (!r.recipient_name) continue;
      if (!isSmallBusinessSetAside(r.set_aside)) continue;
      by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
    }
    return Object.entries(by).map(([name, amount]) => ({ name, amount, set_aside: "SB/8(a)" }));
  })();

  // UI refs
  const topNInput  = $("topN");
  const tabAllBtn  = $("tab-all") || $("tabAll");
  const tabSBBtn   = $("tab-sb")  || $("tabSB");
  const chartTitle = $("chartTitle");

  let currentTab = "all";

  function dataForTab() {
    const base = (currentTab === "sb" ? recipsSB : recipsAll)
      .slice()
      .sort((a, b) => b.amount - a.amount);
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
  if (tabSBBtn)  tabSBBtn.addEventListener("click",  () => setTab("sb"));
  setTab("all");

  /* ----- US Map + filters (national) ----- */

  function drawUSMap() {
    const pscPrefix   = ($("pscFilter")?.value || "").trim();
    const naicsPrefix = ($("naicsFilter")?.value || "").trim();
    const metric      = $("aggMetric")?.value || "amount";

    const by = aggregateByState(awardsPos, metric, pscPrefix, naicsPrefix);
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

    const mapEl = $("map");
    if (mapEl) {
      mapEl.on("plotly_click", (ev) => {
        const loc = ev.points?.[0]?.location; // e.g., "MD"
        if (!loc) return;

        // Update side list (use all awards so counts match the raw table)
        const top = topRecipientsForState(awards, loc, pscPrefix, naicsPrefix, 200);
        $("stateTitle").textContent = `Recipients in ${loc}`;

        if (!top.length) {
          $("stateList").innerHTML = "<li class='muted'>No recipients for current filters.</li>";
          $("stateSummary").textContent = "";
        } else {
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

        // Drill into state map (+ points)
        drawStateDrilldown(loc, awardsPos);
      });
    }

    // Reset back button (national view)
    window.MAP_MODE = "us";
    const backBtn = $("backToUS");
    if (backBtn) backBtn.style.display = "none";
    POINT_TRACE_ID = null;
  }

  drawUSMap();

  $("applyFilters")?.addEventListener("click", () => {
    // If in state view, re-render the state to respect new filters
    if (window.MAP_MODE === "state") {
      const title = $("stateTitle")?.textContent || "";
      const m = title.match(/Recipients in ([A-Z]{2})$/);
      const st = m ? m[1] : null;
      if (st) {
        drawStateDrilldown(st, awardsPos);
        return;
      }
    }
    drawUSMap();
  });
  $("aggMetric")?.addEventListener("change", drawUSMap);

  $("clearSelection")?.addEventListener("click", () => {
    $("pscFilter").value = "";
    $("naicsFilter").value = "";
    $("stateTitle").textContent = "Click a state";
    $("stateSummary").textContent = "";
    $("stateList").innerHTML = "";
    if (window.MAP_MODE === "state") {
      $("backToUS").style.display = "none";
      window.MAP_MODE = "us";
    }
    drawUSMap();
  });

  // Back button for drilldown
  $("backToUS")?.addEventListener("click", () => {
    window.MAP_MODE = "us";
    $("backToUS").style.display = "none";
    $("stateTitle").textContent = "Click a state";
    $("stateSummary").textContent = "";
    $("stateList").innerHTML = "";
    drawUSMap();
  });

  // Toggle recipient points (show/hide existing markers trace)
  $("togglePoints")?.addEventListener("click", async (ev) => {
    const gd = $("map");
    if (!gd || window.MAP_MODE !== "state") return;

    if (POINT_TRACE_ID == null) return; // no points yet

    const current = gd.data[POINT_TRACE_ID];
    const isHidden = current.visible === "legendonly" || current.visible === false;
    await Plotly.restyle(gd, { visible: isHidden ? true : "legendonly" }, POINT_TRACE_ID);

    ev.currentTarget.textContent = isHidden ? "Hide recipient points" : "Show recipient points";
  });

  /* ----- Recent awards (table): filters + render + show more + collapse ----- */

  // table initially renders from awardsFiltered already set above
  renderAwardsTable();

  // NAICS filter controls (for the table)
  const awardsNaicsInput = $("awardsNaicsInput");
  const awardsNaicsClear = $("awardsNaicsClear");
  const debounce = (fn, ms = 250) => {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  if (awardsNaicsInput) {
    awardsNaicsInput.addEventListener("input", debounce((e) => {
      awardsFilter.naics = (e.target.value || "").trim();
      applyAwardsFiltersAndRender();
    }));
  }
  if (awardsNaicsClear) {
    awardsNaicsClear.addEventListener("click", () => {
      awardsFilter.naics = "";
      if (awardsNaicsInput) awardsNaicsInput.value = "";
      applyAwardsFiltersAndRender();
    });
  }

  // “Show more rows” (respects current filters)
  const showMoreBtn = $("showMore");
  if (showMoreBtn) {
    showMoreBtn.addEventListener("click", () => {
      awardsSlice = Math.min(awardsSlice + 200, awardsFiltered.length);
      renderAwardsTable();
      if (awardsSlice >= awardsFiltered.length) showMoreBtn.disabled = true;
    });
  }

  // Optional: collapsible panel for table (use <details id="awardsPanel"> in HTML)
  const awardsPanel = $("awardsPanel");
  if (awardsPanel) {
    awardsPanel.addEventListener("toggle", () => {
      if (awardsPanel.open) renderAwardsTable();
    });
  }
}

/* ================= run ================= */

render().catch((err) => {
  console.error(err);
  const el = $("debug");
  if (el) el.innerHTML = `<pre style="color:#c33">${err.stack || err}</pre>`;
});
