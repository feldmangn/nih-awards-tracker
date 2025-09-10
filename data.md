---
layout: page
title: Data
permalink: /data/
---

<style>
  .pill { padding:.45rem .8rem; border-radius:.6rem; border:1px solid #ddd; cursor:pointer; background:#fff; }
  .pill:hover { background:#f6f6f6; }
  .pill.active { background:#eef6ff; border-color:#c6e0ff; }
  .muted { color:#666; }
  .row { display:flex; gap:2rem; flex-wrap:wrap; align-items:flex-start; }
  .card { padding:1rem; border:1px solid #e5e5e5; border-radius:.75rem; }
  table.table { border-collapse: collapse; width: 100%; }
  table.table thead th { background:#1f77b4; color:#fff; text-align:left; padding:.6rem .8rem; position:sticky; top:0; }
  table.table tbody td { padding:.35rem .6rem; border-bottom:1px solid #eee; font-size:.95rem; }
  table.table tbody tr:nth-child(even) { background:#f7fbff; }
  able.table thead th { background:#1f77b4; color:#fff; text-align:left; padding:.45rem .6rem; position:sticky; top:0; cursor:pointer; }
</style>
<style>
  #awardsPanel > summary .pill { width:2rem; text-align:center; }
  #awardsPanel[open] > summary .pill { content:"–"; }
  #awardsPanel[open] > summary .pill::after { content:"–"; }
  #awardsPanel:not([open]) > summary .pill::after { content:"+"; }
  th.sortable { cursor:pointer; user-select:none; }
  th.sortable .dir { opacity:.6; font-size:.9em; margin-left:.25rem; }
</style>

<div class="prose">

  <!-- Top recipients -->
  <div class="card" style="margin-bottom:1rem;">
    <div style="display:flex; align-items:center; gap:.75rem; margin-bottom:.75rem;">
      <button id="tab-all" class="pill active">All recipients</button>
      <button id="tab-sb"  class="pill">Small business / 8(a)</button>
      <label for="topN" style="margin-left:1rem;">Show top N:</label>
      <input id="topN" type="number" value="25" min="1" max="200" style="width:5rem;">
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
      <!-- Map controls -->
      <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin-bottom:.75rem;">
        <button id="togglePoints" class="pill">Show recipient points</button>
        <button id="backToUS" class="pill" style="display:none;">← Back to US</button>
        <button id="togglePoints" class="pill" style="display:none; margin-bottom:.75rem;">Hide recipient points</button>

      </div>
      <!-- The map -->
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
  <details id="awardsPanel" class="card" style="padding:0;">
    <summary style="list-style:none; padding:1rem; cursor:pointer; display:flex; align-items:center; gap:.5rem; border-bottom:1px solid #eee;">
      <span class="pill" aria-hidden="true">+</span>
      <strong>Show / hide recent awards</strong>
      <span id="summary" class="muted" style="margin-left:auto;"></span>
    </summary>

    <div style="padding:1rem;">
      <div style="display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin-bottom:.5rem;">
        <a class="pill" href="{{ '/data/nih_awards_last_90d.csv'  | relative_url }}">Download CSV</a>
        <a class="pill" href="{{ '/data/nih_awards_last_90d.json' | relative_url }}">Download JSON</a>
        <button id="showMore" class="pill">Show more rows</button>

        <!-- NEW: NAICS filter -->
        <span class="muted" style="margin-left:.75rem;">Filter NAICS:</span>
        <input id="awardsNaics" placeholder="e.g. 541 or 541714" style="padding:.35rem .5rem; width:12rem;">
        <button id="awardsNaicsClear" class="pill">Clear</button>
      </div>

      <div style="overflow:auto;">
        <table id="awardsTable" class="table" style="min-width:1000px;">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </details>


  <!-- Recent awardees (aggregated) -->
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

<!-- 1) libraries (must load before your app) -->
<script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<!-- topojson for any future state/county outlines (optional but harmless) -->
<script src="https://cdn.jsdelivr.net/npm/topojson-client@3"></script>

<!-- 2) Jekyll baseurl -> JS -->
<script>window.__NIH_BASEURL__ = "{{ site.baseurl }}";</script>

<!-- 3) Exact data URLs (works locally and on Pages) -->
<script>
  window.APP_DATA_URLS = {
    AWARDS: "{{ '/data/nih_awards_last_90d.csv' | relative_url }}",
    TOP_RECIP: "{{ '/data/nih_top_recipients_last_90d.csv' | relative_url }}",
    TOP_RECIP_ENRICH: "{{ '/data/nih_top_recipients_last_90d_enriched.csv' | relative_url }}"
  };
</script>

<!-- 4) your app (after all configs/libs) -->
<script src="{{ '/assets/js/app.js' | relative_url }}"></script>
