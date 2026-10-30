/* SZGC-адаптер для контейнера SyllaZip ([1B mode][payload]).
 * Регистрирует SZGC как режим 18: compress/decompress синхронны после
 * однократной инициализации модели. Селектор контейнера перебирает режимы
 * и выбирает минимальный размер — SZGC просто ещё один кандидат. */
"use strict";
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./szgc.js"));
  else root.SZGCAdapter = factory(root.SZGC);
})(typeof self !== "undefined" ? self : this, function (SZGC) {
  var SZGC_MODE = 18;
  var ready = false;

  /* Однократная загрузка модели (graph-model.bin, ~16.3 МБ). Варианты:
   *   браузер:  await SZGCAdapter.initUrl("graph-model.bin");
   *   Node:     SZGCAdapter.initFile("graph-model.bin");
   *   свой путь: SZGCAdapter.initBytes(new Uint8Array(...)); */
  function initBytes(u8) {
    SZGC.loadModel(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
    ready = true;
  }
  function initUrl(url) {
    return fetch(url).then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { initBytes(new Uint8Array(buf)); });
  }
  function initFile(path) {
    var fs = require("fs");
    initBytes(new Uint8Array(fs.readFileSync(path)));
  }

  function assertReady() {
    if (!ready) throw new Error("SZGCAdapter: модель не загружена (init*)");
  }

  /* payload = сжатый SZGC-поток (первый байт — тег режима 0x02..0x05). */
  function compress(text) {
    assertReady();
    return SZGC.compress(text);          // Uint8Array
  }
  function decompress(payload) {
    assertReady();
    return SZGC.decompress(payload instanceof Uint8Array ? payload : new Uint8Array(payload));
  }

  return {
    mode: SZGC_MODE,
    initBytes: initBytes,
    initUrl: initUrl,
    initFile: initFile,
    compress: compress,
    decompress: decompress,
    isReady: function () { return ready; }
  };
});
