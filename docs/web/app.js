// ---------- config & helpers ----------
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

const fmtUSD = n =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(+n || 0);

const toNum = (v) =>
  typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0;

const careersUrl = (name) =>
  `https://www.google.com/search?q=${encodeURIComponent(`${name} careers jobs`)}`;

// ---------- CSV loading ----------
async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  debug(`fetch ${url} -> ${res.status}`);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const text = await res.text();
  return new Promise((resolve) =>
    Papa.parse(text, {
      header: true,
      dynamicTyping: true,
      complete: (r) => resolve(r.data),
    })
  );
}

async function loadRecipientsOrFallback() {
  try {
    return await loadCSV(TOP_RECIP_ENRICH);
  } catch (e) {
    debug(e.message);
  }
  try {
    return await loadCSV(TOP_RECIP);
  } catch (e) {
    debug(e.message);
  }
  return null;
}

// ---------- set-aside / small-business detection ----------
const SET_ASIDE_KEYS = [
  "Type of Set Aside",
  "type_of_set_aside",
  "Set Aside Type",
  "Contracting Officer Business Size Determination",
  "contracting officer business size determination",
  "Business Size",
  "business size",
];

function getSetAsideFromRow(row) {
  if (!row) return null;
  // exact match first
  for (const key of Object.keys(row)) {
    if (SET_ASIDE_KEYS.some((k) => k.toLowerCase() === String(key).toLowerCase())) {
      return row[key];
    }
  }
  // loose fallback
  const loose = Object.keys(row).find((k) =>
    /set.?aside|business.*size/i.test(k)
  );
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

// ---------- DOM helpers (support both id styles) ----------
const $id = (a, b) => document.getElementById(a) || document.getElementById(b);

// ---------- main renderer ----------
async function render() {
  const [recipsMaybe, awardsRaw] = await Promise.all([
    loadRecipientsOrFallback(),
    loadCSV(AWARDS).catch((e) => {
      debug(e.message);
      return [];
    }),
  ]);

  // normalize awards rows
  const awards = awardsRaw.map((row) => {
    const lower = {};
    for (const [k, v] of Object.entries(row || {}))
      lower[String(k || "").toLowerCase()] = v;
    return {
      action_date:
        lower["action date"] ?? lower["action_date"] ?? lower["actiondate"] ?? null,
      recipient_name:
        (lower["recipient name"] ?? lower["recipient_name"] ?? "").trim(),
      award_amount: toNum(lower["award amount"] ?? lower["award_amount"]),
      piid: lower["piid"] ?? null,
      set_aside: getSetAsideFromRow(row),
    };
  });

  // rollups — all recipients
  const recipsAll = (
    recipsMaybe ??
    (() => {
      const by = {};
      for (const r of awards) if (r.recipient_name)
        by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
      return Object.entries(by).map(([name, amount]) => ({
        name,
        amount,
        set_aside: null,
      }));
    })()
  )
    .map((r) => ({
      name: r["Recipient Name"] ?? r["recipient_name"] ?? r.name ?? "",
      amount: toNum(r["Award Amount"] ?? r["award_amount"] ?? r.amount),
      set_aside:
        r["Type of Set Aside"] ??
        r["type_of_set_aside"] ??
        r.set_aside ??
        null,
    }))
    .filter((r) => r.name);

  // rollups — small business / 8(a) only (from awards for accuracy)
  const recipsSB = (() => {
    const by = {};
    for (const r of awards) {
      if (!r.recipient_name) continue;
      if (!isSmallBusinessSetAside(r.set_aside)) continue;
      by[r.recipient_name] = (by[r.recipient_name] || 0) + r.award_amount;
    }
    return Object.entries(by).map(([name, amount]) => ({
      name,
      amount,
      set_aside: "SB/8(a)",
    }));
  })();

  // UI references (support both id styles)
  const topNInput = document.getElementById("topN");
  const tabAllBtn = $id("tabAll", "tab-all");
  const tabSBBtn  = $id("tabSB", "tab-sb");
  const chartTitle =
    document.getElementById("chartTitle") || document.querySelector("h2");

  let currentTab = "all";

  function setTab(tab) {
    currentTab = tab;
    if (tabAllBtn && tabSBBtn) {
      tabAllBtn.classList.toggle("active", tab === "all");
      tabSBBtn.classList.toggle("active", tab === "sb");
    }
    if (chartTitle) {
      chartTitle.textContent =
        tab === "sb"
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
      document.getElementById("chart").innerHTML =
        "<p><em>No recipient data available for this tab.</em></p>";
      return;
    }
    const hover = top.map(
      (d) =>
        `<b>${d.name}</b><br>${fmtUSD(d.amount)}${
          d.set_aside ? `<br>${d.set_aside}` : ""
        }<br><i>Click to open careers</i>`
    );
    Plotly.newPlot(
      "chart",
      [
        {
          type: "bar",
          x: top.map((d) => d.amount),
          y: top.map((d) => d.name),
          orientation: "h",
          hovertemplate: hover.map((h) => h + "<extra></extra>"),
        },
      ],
      { margin: { l: 260, r: 20, t: 10, b: 40 }, xaxis: { title: "Total (USD)" } },
      { displayModeBar: false }
    );

    // open careers search on bar click
    const chart = document.getElementById("chart");
    chart.on("plotly_click", function (ev) {
      const name = ev.points?.[0]?.y;
      if (name) window.open(careersUrl(name), "_blank");
    });
  }

  // wire events
  if (topNInput) topNInput.addEventListener("input", drawChart);
  if (tabAllBtn) tabAllBtn.addEventListener("click", () => setTab("all"));
  if (tabSBBtn)  tabSBBtn.addEventListener("click", () => setTab("sb"));

  // initial render
  setTab("all");

  // ----- table of recent awards -----
  const thead = document.querySelector("#awardsTable thead");
  const tbody = document.querySelector("#awardsTable tbody");
  if (thead && tbody) {
    thead.innerHTML = `<tr>
      <th>Action Date</th>
      <th>Recipient Name</th>
      <th>Award Amount</th>
      <th>PIID</th>
      <th>Type of Set Aside / Size</th>
      <th>Careers</th>
    </tr>`;

    tbody.innerHTML = awards.slice(0, 500).map((r) => `
      <tr>
        <td>${r.action_date ?? ""}</td>
        <td>${r.recipient_name ?? ""}</td>
        <td>${fmtUSD(r.award_amount)}</td>
        <td>${r.piid ?? ""}</td>
        <td>${r.set_aside ?? ""}</td>
        <td><a href="${careersUrl(r.recipient_name || "")}" target="_blank" rel="noopener">Search jobs</a></td>
      </tr>
    `).join("");

    const summary = document.getElementById("summary");
    if (summary) {
      summary.textContent = `Rows shown: ${Math.min(500, awards.length)} of ${awards.length}`;
    }
  }
}

// run
render().catch((err) => {
  const msg = err.stack || err;
  console.error(msg);
  const el = document.getElementById("debug");
  if (el) el.innerHTML = `<pre style="color:#c33">${msg}</pre>`;
});
