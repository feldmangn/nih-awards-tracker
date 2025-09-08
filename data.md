---
layout: page
title: Data
permalink: /data/
---

<style>
  .pill { padding:.45rem .8rem; border-radius:.6rem; border:1px solid #ddd; cursor:pointer; background:#fff; }
  .pill:hover { background:#f6f6f6; }
  .muted { color:#666; }
  .row { display:flex; gap:2rem; flex-wrap:wrap; align-items:flex-start; }
  .card { padding:1rem; border:1px solid #e5e5e5; border-radius:.75rem; }
  table.table { border-collapse: collapse; width: 100%; }
  table.table thead th { background:#1f77b4; color:#fff; text-align:left; padding:.6rem .8rem; position:sticky; top:0; }
  table.table tbody td { padding:.55rem .8rem; border-bottom:1px solid #eee; }
  table.table tbody tr:nth-child(even) { background:#f7fbff; }
</style>

<div class="prose">

  <!-- Top recipients (chart controls reused by app.js) -->
  <div class="card" style="margin-bottom:1rem;">
    <div style="display:flex; align-items:center; gap:.75rem; margin-bottom:.75rem;">
      <button id="tab-all" class="pill active">All recipients</button>
      <button id="tab-sb"  class="pill">Small business / 8(a)</button>
      <label for="topN" style="margin-left:1rem;">Show top N:</label>
      <input id="topN" type="number" value="25" min="1" max="100" style="width:5rem;">
    </div>
    <h2 id="chartTitle" style="margin:0 0 .5rem 0;">Top recipients (by obligated amount)</h2>
    <div id="chart" style="min-height:420px;"></div>
  </div>

  <!-- Geography -->
  <h2>Geography (place of performance)</h2>
  <div style="display:flex; gap:.5rem; align-items:center; margin:.5rem 0 1rem 0;">
    <input id="pscFilter"   placeholder="PSC starts with, e.g. R or 66"    style="padding:.35rem .5rem;">
    <input id="naicsFilter" placeholder="NAICS starts with, e.g. 541"      style="padding:.35rem .5rem;">
    <select id="aggMetric" style="padding:.35rem .5rem;">
      <option value="amount" selected>Total obligated amount</option>
      <option value="count">Award count</option>
    </select>
    <button id="applyFilters" class="pill">Apply</button>
    <button id="clearSelection" class="pill">Clear</button>
    <span id="mapNote" class="muted" style="margin-left:.5rem;"></span>
  </div>

  <div class="row">
    <div class="card" style="flex:2; min-width:420px;">
      <div id="map" style="height:520px;"></div>
    </div>

    <div class="card" style="flex:1; min-width:320px;">
      <h3 id="stateTitle">Click a state</h3>
      <div id="stateSummary" class="muted" style="margin-bottom:.5rem;"></div>
      <ol id="stateList"></ol>
    </div>
  </div>

  <!-- Recent awards (raw table) -->
  <h2 style="margin-top:2rem;">Recent awards (raw)</h2>
  <div class="card">
    <div id="summary" class="muted" style="margin:.5rem 0;"></div>
    <div style="display:flex; gap:.5rem; align-items:center; margin-bottom:.5rem;">
      <a class="pill" href="{{ '/data/nih_awards_last_90d.csv'  | relative_url }}">Download CSV</a>
      <a class="pill" href="{{ '/data/nih_awards_last_90d.json' | relative_url }}">Download JSON</a>
      <button id="showMore" class="pill">Show more rows</button>
    </div>
    <div style="overflow:auto;">
      <table id="awardsTable" class="table" style="min-width:1000px;">
        <thead></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- Recent awardees (aggregated recipients table) -->
  <h2 style="margin-top:2rem;">Recent awardees (top recipients by total)</h2>
  <div class="card">
    <div id="awardeesSummary" class="muted" style="margin:.5rem 0;"></div>
    <div style="overflow:auto;">
      <table id="awardeesTable" class="table" style="min-width:600px;">
        <thead></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div id="debug"></div>
</div>

<!-- Libraries -->
<script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>

<!-- Pass baseurl from Jekyll to JS -->
<script>window.__NIH_BASEURL__ = "{{ site.baseurl }}";</script>

<!-- Your app -->
<script src="{{ '/assets/js/app.js' | relative_url }}"></script>
