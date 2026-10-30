/**
 * window.SyllaZipUI.Utils — общие утилиты UI.
 */
(function (global) {
  'use strict';

  var Utils = {
    /** Режимы конверта SZGC (первый байт блока) — подписи и пояснения. */
    MODES: {
      2: {
        label: 'Словарь + предсказание',
        hint: 'основной режим: слова распознаёт встроенный словарь, следующее слово предсказывается по контексту, затем арифметическое сжатие',
      },
      3: {
        label: 'Байты: контекст 3',
        hint: 'резерв без словаря: байт предсказывается по трём предыдущим, при неудаче — по двум',
      },
      4: {
        label: 'Байты: контекст 2',
        hint: 'резерв без словаря: байт предсказывается по двум предыдущим',
      },
      5: {
        label: 'Байты: без контекста',
        hint: 'резерв без словаря: только частоты отдельных байтов',
      },
    },

    modeInfo: function (tag) {
      return this.MODES[tag] || null;
    },

    modeLabel: function (tag) {
      var m = this.MODES[tag];
      return m ? m.label : (tag ? 'Неизвестный (0x' + Number(tag).toString(16) + ')' : '—');
    },

    formatBytes: function (n) {
      if (n === null || n === undefined) return '—';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(2) + ' MB';
    },

    /** Space-separated hex dump of the first N bytes. */
    hexDump: function (arr, max) {
      max = max || 256;
      var len = Math.min(arr.length, max);
      var parts = [];
      for (var i = 0; i < len; i++) {
        parts.push(arr[i].toString(16).padStart(2, '0'));
      }
      return parts.join(' ') + (arr.length > max ? ' ...' : '');
    },

    utf8Decode: function (arr) {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8').decode(arr);
      }
      var s = '';
      for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      return decodeURIComponent(escape(s));
    },

    utf8Encode: function (str) {
      if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(str);
      }
      var bytes = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
        else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
      return new Uint8Array(bytes);
    },

    utf8ByteLength: function (str) {
      var len = 0;
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) len += 1;
        else if (c < 0x800) len += 2;
        else len += 3;
      }
      return len;
    },

    toBase64: function (u8) {
      var bin = '';
      var CH = 0x8000;
      for (var i = 0; i < u8.length; i += CH) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      }
      return btoa(bin);
    },

    fromBase64: function (b64) {
      var bin = atob(String(b64).replace(/\s+/g, ''));
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    },

    escapeHTML: function (s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    timeNow: function () {
      var d = new Date();
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },

    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
  };

  global.SyllaZipUI = global.SyllaZipUI || {};
  global.SyllaZipUI.Utils = Utils;
})(typeof window !== 'undefined' ? window : this);
