---
layout: page
title: NIH
permalink: /hhs/nih/
agency_prefix: nih
no_push_state: true
---

{% include agency_data.html prefix=page.agency_prefix %}

<!-- Build data URLs for THIS agency (before app.js) -->
<script data-no-instant>
  (function () {
    var prefix = "{{ include.prefix | strip | default: 'nih' }}";
    var base   = "{{ '/data/' | relative_url }}";
    window.APP_DATA_URLS = {
      AWARDS:           base + prefix + "_awards_last_90d.csv",
      TOP_RECIP:        base + prefix + "_top_recipients_last_90d.csv",
      TOP_RECIP_ENRICH: base + prefix + "_top_recipients_last_90d_enriched.csv"
    };
    // Update download links (optional)
    var csvA  = document.getElementById('dlCsv');
    var jsonA = document.getElementById('dlJson');
    if (csvA)  csvA.href  = window.APP_DATA_URLS.AWARDS;
    if (jsonA) jsonA.href = base + prefix + "_awards_last_90d.json";
  })();
</script>

<!-- App code (reads window.APP_DATA_URLS) -->
<script src="{{ '/assets/js/app.js' | relative_url }}" data-no-instant defer></script>

