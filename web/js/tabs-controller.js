/**
 * window.SyllaZipUI.Tabs
 */
(function (global) {
  'use strict';

  var Tabs = {
    init: function (container, defaultTab) {
      container = container || document;
      var triggers = Array.prototype.slice.call(
        container.querySelectorAll('.tabs__trigger[data-tab]')
      );
      triggers.forEach(function (trigger) {
        trigger.addEventListener('click', function () {
          Tabs.setActive(container, trigger.getAttribute('data-tab'));
        });
      });
      if (defaultTab) Tabs.setActive(container, defaultTab);
      else if (triggers.length) Tabs.setActive(container, triggers[0].getAttribute('data-tab'));
    },

    setActive: function (container, id) {
      var triggers = Array.prototype.slice.call(
        container.querySelectorAll('.tabs__trigger[data-tab]')
      );
      var panels = Array.prototype.slice.call(
        container.querySelectorAll('.tabs__panel[data-tabpanel]')
      );
      triggers.forEach(function (t) {
        if (t.getAttribute('data-tab') === id) t.classList.add('is-active');
        else t.classList.remove('is-active');
      });
      panels.forEach(function (p) {
        if (p.getAttribute('data-tabpanel') === id) p.classList.add('is-active');
        else p.classList.remove('is-active');
      });
    },
  };

  global.SyllaZipUI = global.SyllaZipUI || {};
  global.SyllaZipUI.Tabs = Tabs;
})(typeof window !== 'undefined' ? window : this);
