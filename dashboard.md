---
layout: page
title: NIH Awards Tracker (Daily)
permalink: /dashboard/
---

<div class="prose">
  <div style="margin: 1rem 0;">
    <label for="search" style="font-weight:600;">Search recipients or NAICS/PSC:</label>
    <input id="search" type="text" placeholder="e.g. Maximus, 5415, R4" style="margin-left:.5rem; padding:.35rem .5rem;">
    <label for="topn" style="margin-left:1rem; font-weight:600;">Show top N:</label>
    <input id="topn" type="number" value="25" min="1" max="200" style="width:5rem; margin-left:.5rem; padding:.35rem .5rem;">
  </div>

  <div style="display:flex; gap:2rem; flex-wrap:wrap;">
    <div style="flex:1; min-width:320px;">
      <h2>Top recipients (by obligated amount)</h2>
      <div id="topRecipients"></div>
    </div>
  </div>

<h2 style="margin-top:2rem;">Recent awards (raw)</h2>

<div class="card">
  <div id="summary" class="muted" style="margin:.5rem 0;"></div>

  <div style="display:flex; gap:.5rem; align-items:center; margin-bottom:.5rem;">
    <a class="pill" href="{{ '/data/nih_awards_last_90d.csv' | relative_url }}">Download CSV</a>
    <a class="pill" href="{{ '/data/nih_awards_last_90d.json' | relative_url }}">Download JSON</a>
    <button id="showMore" class="pill">Show more rows</button>
  </div>

  <div style="overflow:auto;">
    <table id="awardsTable" class="table" style="min-width:1000px;">
      <thead></thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="muted" style="margin-top:.5rem;">
    Data: USAspending “Spending by Award” (NIH, contracts A–D).
  </div>
</div>


  <h2>Geography (place of performance)</h2>
  <div style="margin: .5rem 0;">
    <input id="pscPrefix" placeholder="PSC starts with (e.g., R or 66)" style="padding:.35rem .5rem;">
    <input id="naicsPrefix" placeholder="NAICS starts with (e.g., 541)" style="padding:.35rem .5rem; margin-left:.5rem;">
    <button id="applyFilters" style="margin-left:.5rem; padding:.35rem .75rem;">Apply</button>
    <button id="clearFilters" style="margin-left:.5rem; padding:.35rem .75rem;">Clear</button>
  </div>
  <div id="usMap" style="height:520px;"></div>
</div>

<!-- Load libs (CDN is fine for Pages) -->
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>

<!-- Your app code -->
<script>
  window.APP_CONFIG = {
    // point to your snapshots; relative_url respects baseurl in prod
    awardsCsv: "{{ '/data/nih_awards_last_90d.csv' | relative_url }}",
    topRecipientsCsv: "{{ '/data/nih_top_recipients_last_90d_enriched.csv' | relative_url }}"
  };
</script>
<script src="{{ '/assets/js/app.js' | relative_url }}"></script>


<script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<script>window.__NIH_BASEURL__ = "{{ site.baseurl }}";</script>
<script src="{{ '/assets/js/app.js' | relative_url }}"></script>
