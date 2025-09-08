---
layout: page
title: Dashboard
permalink: /dashboard/
---

<link rel="stylesheet" href="https://unpkg.com/mvp.css" />
<script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js"></script>

<div id="debug" class="muted" style="margin:1rem 0;"></div>

<!-- Your existing HTML (kept mostly intact) -->
<section>
  <h2>Top recipients</h2>
  <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
    <div>
      <button id="tabAll" class="tab-btn active">All recipients</button>
      <button id="tabSB" class="tab-btn">Small business / 8(a)</button>
    </div>
    <label for="topN">Show top N:</label>
    <input id="topN" type="number" min="5" max="100" value="25" step="5" />
  </div>
  <div id="chart" style="width:100%;height:600px;"></div>
</section>

<section>
  <h2>Geography (place of performance)</h2>
  <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end">
    <div>
      <label>PSC starts with:</label>
      <input id="pscFilter" placeholder="e.g. R or 66" />
    </div>
    <div>
      <label>NAICS starts with:</label>
      <input id="naicsFilter" placeholder="e.g. 541 or 5415" />
    </div>
    <div>
      <label>Aggregate by:</label>
      <select id="aggMetric">
        <option value="amount">Total obligated amount</option>
        <option value="count">Award count</option>
      </select>
    </div>
    <button id="applyFilters">Apply</button>
  </div>
  <div id="map" style="width:100%;height:620px;margin-top:1rem;"></div>
  <div id="mapNote" class="muted"></div>
</section>

<section>
  <h2>Recent awards (raw)</h2>
  <div id="summary" class="muted"></div>
  <div class="table-wrap">
    <table id="awardsTable">
      <thead></thead>
      <tbody></tbody>
    </table>
  </div>
</section>

<style>
.tab-btn { padding: .4rem .8rem; border:1px solid #ccc; border-radius:4px; background:#eee; cursor:pointer; margin-right:.25rem; }
.tab-btn.active { background:#000; color:#fff; }
.table-wrap { overflow:auto; max-height:70vh; }
th,td { white-space:nowrap; }
.muted { opacity:.7; font-size:.9rem; }
</style>

<script type="module">
// Pass baseurl from Jekyll to JS so /docs paths work on GitHub Pages
const BASE = "{{ site.baseurl }}";
window.__NIH_BASEURL__ = BASE;
// Load your app.js from the repo
import BASE_APP from "{{ site.baseurl }}/web/app.js";
</script>

<script type="module" src="{{ site.baseurl }}/web/app.js"></script>
