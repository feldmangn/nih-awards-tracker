---
layout: page
title: NIH
permalink: /hhs/nih/
agency_prefix: nih
no_push_state: true
---

{% include agency_data.html prefix=page.agency_prefix %}

<script data-no-instant>
  (function () {
    // If the app is already on the page (Hydejack PJAX navigation), just rerender.
    function boot() {
      if (window.__AWARDS_RERENDER__) window.__AWARDS_RERENDER__();
    }

    if (window.__AWARDS_RERENDER__) {
      // app.js already loaded globally
      boot();
    } else if (!window.__AWARDS_APP_ATTACHED__) {
      // load app.js exactly once
      window.__AWARDS_APP_ATTACHED__ = true;
      var s = document.createElement('script');
      s.src = '{{ "/assets/js/app.js" | relative_url }}';
      s.defer = true;
      s.setAttribute('data-no-instant', '');
      s.onload = boot;
      document.head.appendChild(s);
    }
  })();
</script>

