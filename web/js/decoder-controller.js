/**
 * SyllaZip (SZGC) — decoder-controller.js
 * Панель декомпрессора: base64 или .sz файл -> SZGC.decompress.
 * Exposes: window.SyllaZipUI.Decoder
 */
(function (global) {
  'use strict';

  var U = (global.SyllaZipUI || {}).Utils || {};
  var esc = U.escapeHTML || function (s) { return s; };

  /** Тег режима SZGC (первый байт блока) -> человекочитаемая подпись. */
  function detectMode(bytes) {
    if (!bytes || bytes.length === 0) return null;
    var m = bytes[0];
    var info = U.modeInfo(m);
    return info ? info.label
      : ('Неизвестный (0x' + m.toString(16).padStart(2, '0') + ')');
  }

  function isKnownModeByte(mode) {
    return mode >= 2 && mode <= 5;
  }

  function formatInvalidModeError(modeByte) {
    return 'Неизвестный тег режима: 0x' + modeByte.toString(16).padStart(2, '0') + '. ' +
      'Файл не является корректным блоком SyllaZip/SZGC.';
  }

  var Decoder = {
    state: {
      inputFormat: 'base64',
      base64Input: '',
      fileName: '',
      fileBytes: null,
      fileInfo: null,
      output: '',
      error: null,
      isDecoding: false,
      decodeMs: null,
    },

    el: {},

    init: function () {
      this.el.section        = U.$('#decoder-section');
      this.el.base64Panel    = U.$('#decoder-base64-panel');
      this.el.filePanel      = U.$('#decoder-file-panel');
      this.el.base64Input    = U.$('#decoder-base64-input');
      this.el.fileInput      = U.$('#decoder-file-input');
      this.el.dropzone       = U.$('#decoder-dropzone');
      this.el.fileInfo       = U.$('#decoder-file-info');
      this.el.status         = U.$('#decoder-status');
      this.el.btnDecode      = U.$('#btn-decode');
      this.el.btnReset       = U.$('#btn-decoder-reset');
      this.el.errorBox       = U.$('#decoder-error');
      this.el.outputWrap     = U.$('#decoder-output-wrap');
      this.el.outputPre      = U.$('#decoder-output-pre');
      this.el.outputMeta     = U.$('#decoder-output-meta');
      this.el.pillBase64     = U.$('[data-decoder-tab="base64"]');
      this.el.pillFile       = U.$('[data-decoder-tab="file"]');

      this.bindEvents();
      this.renderAll();
    },

    bindEvents: function () {
      var self = this;

      if (this.el.pillBase64) {
        this.el.pillBase64.addEventListener('click', function () { self.setMode('base64'); });
      }
      if (this.el.pillFile) {
        this.el.pillFile.addEventListener('click', function () { self.setMode('file'); });
      }
      if (this.el.base64Input) {
        this.el.base64Input.addEventListener('input', function (e) {
          self.state.base64Input = e.target.value;
          self.maybeShowReset();
        });
      }
      if (this.el.fileInput) {
        this.el.fileInput.addEventListener('change', function (e) {
          var f = e.target.files && e.target.files[0];
          if (f) self.handleFile(f);
        });
      }
      if (this.el.dropzone) {
        this.el.dropzone.addEventListener('click', function () {
          if (self.el.fileInput) self.el.fileInput.click();
        });
        this.el.dropzone.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (self.el.fileInput) self.el.fileInput.click();
          }
        });
        this.el.dropzone.addEventListener('dragover', function (e) {
          e.preventDefault();
          self.el.dropzone.classList.add('is-dragging');
        });
        this.el.dropzone.addEventListener('dragleave', function () {
          self.el.dropzone.classList.remove('is-dragging');
        });
        this.el.dropzone.addEventListener('drop', function (e) {
          e.preventDefault();
          self.el.dropzone.classList.remove('is-dragging');
          var f = e.dataTransfer.files && e.dataTransfer.files[0];
          if (f) self.handleFile(f);
        });
      }
    },

    setMode: function (mode) {
      this.state.inputFormat = mode;
      this.renderMode();
    },

    renderMode: function () {
      var isBase64 = this.state.inputFormat === 'base64';
      if (this.el.pillBase64) {
        this.el.pillBase64.classList.toggle('is-active', isBase64);
        this.el.pillBase64.setAttribute('aria-selected', isBase64 ? 'true' : 'false');
      }
      if (this.el.pillFile) {
        this.el.pillFile.classList.toggle('is-active', !isBase64);
        this.el.pillFile.setAttribute('aria-selected', !isBase64 ? 'true' : 'false');
      }
      if (this.el.base64Panel) this.el.base64Panel.classList.toggle('is-hidden', !isBase64);
      if (this.el.filePanel)   this.el.filePanel.classList.toggle('is-hidden', isBase64);
    },

    handleFile: function (file) {
      var self = this;
      self.state.fileName = file.name;
      self.state.output = '';
      self.state.decodeMs = null;
      self.state.error = null;
      var reader = new FileReader();
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        self.state.fileBytes = bytes;
        self.state.fileInfo = { size: bytes.length, mode: detectMode(bytes) };
        var c = (global.SyllaZipUI || {}).Controller;
        if (c && typeof c.addLog === 'function') {
          c.addLog('Выбран файл ' + file.name + ' (' + bytes.length + ' байт, режим: ' +
            (detectMode(bytes) || '—') + ')');
        }
        self.renderAll();
      };
      reader.onerror = function () {
        self.state.error = 'Не удалось прочитать файл';
        self.renderAll();
      };
      reader.readAsArrayBuffer(file);
    },

    decode: function (ctx) {
      var self = this;
      var c = ctx || (global.SyllaZipUI || {}).Controller;
      var SZGC = global.SZGC;

      if (!SZGC || !c || !c.isReady || !c.isReady()) {
        self.state.error = 'Система ещё загружается — дождитесь инициализации.';
        self.renderAll();
        return Promise.resolve();
      }

      self.state.error = null;
      self.state.isDecoding = true;
      self.state.output = '';
      self.state.decodeMs = null;
      self.renderAll();

      var bytes;
      if (self.state.inputFormat === 'base64') {
        var trimmed = (self.state.base64Input || '').trim();
        if (!trimmed) {
          self.state.error = 'Вставьте base64-строку для декомпрессии.';
          self.state.isDecoding = false;
          self.renderAll();
          return Promise.resolve();
        }
        try {
          bytes = U.fromBase64(trimmed);
        } catch (e) {
          self.state.error = 'Некорректный base64: ' + (e && e.message || e);
          self.state.isDecoding = false;
          self.renderAll();
          return Promise.resolve();
        }
      } else {
        bytes = self.state.fileBytes;
      }

      if (!bytes || bytes.length < 1) {
        self.state.error = 'Выберите .sz файл для декомпрессии.';
        self.state.isDecoding = false;
        self.renderAll();
        return Promise.resolve();
      }

      if (!isKnownModeByte(bytes[0])) {
        self.state.error = formatInvalidModeError(bytes[0]);
        self.state.isDecoding = false;
        self.renderAll();
        return Promise.resolve();
      }

      if (c && typeof c.addLog === 'function') {
        c.addLog('Декомпрессия ' + (self.state.inputFormat === 'base64' ? 'base64' : ('"' + self.state.fileName + '"')) +
          ' (' + bytes.length + ' байт, режим ' + (detectMode(bytes) || '—') + ')...');
      }

      var start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return Promise.resolve().then(function () {
        var result = SZGC.decompress(bytes);
        var elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
        self.state.output = result;
        self.state.decodeMs = elapsed;
        self.state.fileInfo = { size: bytes.length, mode: detectMode(bytes) };
        self.state.isDecoding = false;
        if (c && typeof c.addLog === 'function') {
          c.addLog('✓ Декомпрессия завершена за ' + elapsed.toFixed(1) + 'мс → ' + result.length + ' символов', 'ok');
        }
        self.renderAll();
      }).catch(function (err) {
        var msg = (err && err.message) || String(err);
        self.state.error = 'Ошибка декомпрессии: ' + msg;
        self.state.isDecoding = false;
        if (c && typeof c.addLog === 'function') {
          c.addLog('✗ Ошибка декомпрессии: ' + msg, 'err');
        }
        self.renderAll();
      });
    },

    reset: function () {
      this.state.base64Input = '';
      this.state.fileName = '';
      this.state.fileBytes = null;
      this.state.fileInfo = null;
      this.state.output = '';
      this.state.error = null;
      this.state.decodeMs = null;
      if (this.el.base64Input) this.el.base64Input.value = '';
      if (this.el.fileInput) this.el.fileInput.value = '';
      this.renderAll();
    },

    copyOutput: function () {
      if (!this.state.output) return;
      var c = (global.SyllaZipUI || {}).Controller;
      if (c && typeof c.copyToClipboard === 'function') {
        c.copyToClipboard(this.state.output);
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this.state.output);
      }
      if (c && typeof c.addLog === 'function') {
        c.addLog('✓ Декомпрессированный текст скопирован в буфер обмена', 'ok');
      }
    },

    downloadOutput: function () {
      if (!this.state.output) return;
      var blob = new Blob([this.state.output], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'syllazip-decoded.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      var c = (global.SyllaZipUI || {}).Controller;
      if (c && typeof c.addLog === 'function') {
        c.addLog('✓ Файл сохранён как syllazip-decoded.txt', 'ok');
      }
    },

    maybeShowReset: function () {
      if (!this.el.btnReset) return;
      var hasAny = !!(this.state.base64Input || this.state.fileName || this.state.output);
      if (hasAny) this.el.btnReset.classList.remove('is-hidden');
      else this.el.btnReset.classList.add('is-hidden');
    },

    renderAll: function () {
      this.renderMode();
      this.maybeShowReset();

      var c = (global.SyllaZipUI || {}).Controller;
      var isReady = c && typeof c.isReady === 'function' && c.isReady();

      if (this.el.base64Input) this.el.base64Input.disabled = !isReady;
      if (this.el.fileInput) this.el.fileInput.disabled = !isReady;

      if (this.el.fileInfo) {
        if (this.state.fileName) {
          var html = '<span class="dropzone__text dropzone__text--filename">' + esc(this.state.fileName) + '</span>';
          if (this.state.fileInfo) {
            html += '<div class="dropzone__text dropzone__text--muted" style="margin-top:0.3rem;">' +
              this.state.fileInfo.size + ' байт' +
              (this.state.fileInfo.mode ? ' · режим: ' + esc(this.state.fileInfo.mode) : '') +
              '</div>';
          }
          this.el.fileInfo.innerHTML = html;
        } else {
          this.el.fileInfo.textContent = 'Перетащите .sz файл сюда или нажмите для выбора';
          this.el.fileInfo.className = 'dropzone__text';
        }
      }

      if (this.el.status) {
        var s;
        if (!isReady) s = 'Система ещё загружается…';
        else if (this.state.decodeMs !== null) s = 'Декомпрессия: ' + this.state.decodeMs.toFixed(1) + ' мс';
        else s = 'Готов к декомпрессии';
        this.el.status.textContent = s;
      }

      if (this.el.btnDecode) {
        this.el.btnDecode.disabled = !isReady || this.state.isDecoding;
      }

      if (this.el.errorBox) {
        if (this.state.error) {
          this.el.errorBox.classList.remove('is-hidden');
          this.el.errorBox.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg><span>' + esc(this.state.error) + '</span>';
        } else {
          this.el.errorBox.classList.add('is-hidden');
          this.el.errorBox.innerHTML = '';
        }
      }

      if (this.el.outputWrap) {
        if (this.state.output) {
          this.el.outputWrap.classList.remove('is-hidden');
          if (this.el.outputMeta) {
            this.el.outputMeta.textContent = 'Результат декомпрессии · ' + this.state.output.length + ' символов';
          }
          if (this.el.outputPre) {
            this.el.outputPre.textContent = this.state.output;
          }
        } else {
          this.el.outputWrap.classList.add('is-hidden');
        }
      }
    },
  };

  global.SyllaZipUI = global.SyllaZipUI || {};
  global.SyllaZipUI.Decoder = Decoder;
  global.SyllaZipUI.Decoder.detectMode = detectMode;
})(typeof window !== 'undefined' ? window : this);
