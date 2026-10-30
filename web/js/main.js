/**
 * Boot: utils.js → tabs-controller.js → stats-renderer.js →
 * compression-handler.js → decoder-controller.js → ui-controller.js → main.js
 */
(function (global) {
  'use strict';

  function populateSamples() {
    var controller = (global.SyllaZipUI || {}).Controller;
    if (!controller) return;
    var sel = global.document && document.getElementById('sample-select');
    if (!sel) return;
    var samples = controller.getSampleTexts();
    samples.forEach(function (s, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  }

  function boot() {
    populateSamples();
    var controller = (global.SyllaZipUI || {}).Controller;
    if (controller && typeof controller.init === 'function') {
      controller.init();
    } else {
      console.error('[SyllaZip] UIController not found — check script load order.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
