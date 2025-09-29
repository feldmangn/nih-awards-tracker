---
layout: page
title: DoD · Air Force · AFRL
permalink: /dod/air-force/afrl/
agency_prefix: dod_air_force_afrl
no_push_state: true
---
{% include agency_data.html prefix=page.agency_prefix %}
{% include expand_sidebar.html %}


<script data-no-instant>
  (function () {
    function boot() {
      // If app.js already attached a rerender hook, call it
      if (window.__AWARDS_RERENDER__) window.__AWARDS_RERENDER__();
    }

    // If app.js is already present (PJAX navigation), just rerender.
    if (window.__AWARDS_RERENDER__) {
      boot();
      return;
    }

    // Load app.js exactly once per site session.
    if (!window.__AWARDS_APP_ATTACHED__) {
      window.__AWARDS_APP_ATTACHED__ = true;
      var s = document.createElement('script');
      s.src = '{{ "/assets/js/app.js" | relative_url }}';
      s.defer = true;
      s.setAttribute('data-no-instant', '');
      s.onload = boot;
      document.head.appendChild(s);
    } else {
      // app.js is being attached elsewhere; try to rerender after a tick
      setTimeout(boot, 0);
    }
  })();
</script>
