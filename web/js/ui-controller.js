/**
 * window.SyllaZipUI.Controller — инициализация модели SZGM и общее состояние UI.
 */
(function (global) {
  'use strict';

  var U = (global.SyllaZipUI || {}).Utils || {};
  var Stats = (global.SyllaZipUI || {}).StatsRenderer || {};
  var Comp = (global.SyllaZipUI || {}).CompressionHandler || {};
  var Tabs = (global.SyllaZipUI || {}).Tabs || {};
  var Decoder = (global.SyllaZipUI || {}).Decoder || {};

  var SAMPLE_TEXTS = [
    {
      name: 'Краткий текст',
      text: 'Привет! Как дела? Сегодня прекрасная погода для прогулки в парке.',
    },
    {
      name: 'Новости',
      text: 'В Москве сегодня ожидается переменная облачность, температура воздуха составит плюс двадцать два градуса Цельсия. Ветер юго-западный, скорость три-пять метров в секунду. Атмосферное давление семьсот сорок миллиметров ртутного столба.',
    },
    {
      name: 'Литература',
      text: 'Утром, когда я проснулся, в комнате было ещё темно. Сквозь щели в ставнях пробивались тонкие лучи солнца. Я подошёл к окну и распахнул ставни. Передо мной расстилалась широкая долина, покрытая изумрудной зеленью. Вдали виднелись горы, их вершины были покрыты белыми облаками.',
    },
    {
      name: 'Технический',
      text: 'Серверная архитектура приложения построена на микросервисном подходе. Каждый сервис развёрнут в отдельном контейнере Docker и управляется через Kubernetes. Для хранения данных используется PostgreSQL с репликацией master-slave. Кэширование реализовано через Redis Sentinel. Взаимодействие между сервисами осуществляется по протоколу gRPC с использованием Protocol Buffers.',
    },
    {
      name: 'Смешанный (ру/лат)',
      text: 'Рабочий процесс: утром standup meeting, затем продолжаем разработку нового API эндпоинта для пользовательского интерфейса. В обед перейду в кафе на углу улицы, закажу кофе и бутерброд. После обеда вечером запланирован code review sprint backlog.',
    },
  ];

  var INIT_PHASES = { IDLE: 'idle', MODEL: 'model', READY: 'ready', ERROR: 'error' };

  var Controller = {
    state: {
      initPhase: INIT_PHASES.IDLE,
      statusMsg: '',
      inputText: SAMPLE_TEXTS[0].text,
      compressedData: null,
      decompressedText: '',
      stats: null,
      compressTime: 0,
      decompressTime: 0,
      verificationOk: null,
      selectedSample: '0',
      hexDump: '',
      base64Output: '',
      wordTable: [],
      model: null,
    },

    el: {},

    isReady: function () { return this.state.initPhase === INIT_PHASES.READY; },
    isLoading: function () { return this.state.initPhase === INIT_PHASES.MODEL; },

    init: function () {
      this.el.statusBadge = U.$('#status-badge');
      this.el.statusText = U.$('#status-text');
      this.el.statusIcon = U.$('#status-icon');
      this.el.loadingCard = U.$('#loading-card');
      this.el.loadingText = U.$('#loading-text');
      this.el.loadingSub = U.$('#loading-sub');
      this.el.inputText = U.$('#input-text');
      this.el.sampleSelect = U.$('#sample-select');
      this.el.charCount = U.$('#char-count');
      this.el.byteCount = U.$('#byte-count');
      this.el.btnCompress = U.$('#btn-compress');
      this.el.btnFullCycle = U.$('#btn-full-cycle');
      this.el.statsPanel = U.$('#stats-panel');
      this.el.tabsContainer = U.$('#tabs-container');
      this.el.hexPre = U.$('#hex-pre');
      this.el.hexMeta = U.$('#hex-meta');
      this.el.base64Pre = U.$('#base64-pre');
      this.el.decompressedPre = U.$('#decompressed-pre');
      this.el.wordTableInner = U.$('#word-table-inner');
      this.el.lemmaWrap = U.$('#lemma-wrap');
      this.el.leanMapCard = U.$('#lean-map-card');
      this.el.lemmaCount = U.$('#lemma-count');
      this.el.globalLemmaCount = U.$('#global-lemma-count');
      this.el.console = U.$('#console');
      this.el.resultsSection = U.$('#results-section');
      this.el.dividerResults = U.$('#divider-results');
      this.el.dividerLean = U.$('#divider-lean');
      this.el.dividerConsole = U.$('#divider-console');

      if (Decoder && typeof Decoder.init === 'function') {
        Decoder.init();
      }

      if (this.el.inputText) this.el.inputText.value = this.state.inputText;
      this.bindEvents();
      this.renderAll();
      this.startInit();
    },

    bindEvents: function () {
      var self = this;
      if (this.el.inputText) {
        this.el.inputText.addEventListener('input', function (e) {
          self.state.inputText = e.target.value;
          self.updateCharCount();
        });
      }
      if (this.el.sampleSelect) {
        this.el.sampleSelect.addEventListener('change', function (e) {
          self.handleSampleSelect(e.target.value);
        });
      }
      document.addEventListener('click', function (e) {
        var target = e.target.closest('[data-action]');
        if (!target) return;
        var action = target.getAttribute('data-action');
        switch (action) {
          case 'compress': Comp.compress(self); break;
          case 'full-cycle': Comp.fullCycle(self); break;
          case 'decompress': Comp.decompress(self); break;
          case 'copy-hex': self.handleCopyHex(); break;
          case 'copy-base64': self.handleCopyBase64(); break;
          case 'decoder-decode': Decoder.decode(self); break;
          case 'decoder-reset': Decoder.reset(); break;
          case 'decoder-copy': Decoder.copyOutput(); break;
          case 'decoder-download': Decoder.downloadOutput(); break;
        }
      });
      if (this.el.console && typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(function () {
          self.updateDividers();
        });
        mo.observe(this.el.console, { childList: true, subtree: false });
      }
    },

    /* ------------------- Logging ------------------- */
    addLog: function (msg, kind) {
      var time = U.timeNow();
      var msgCls = 'console__msg';
      if (kind === 'ok') msgCls += ' console__msg--ok';
      else if (kind === 'err') msgCls += ' console__msg--err';
      else if (kind === 'warn') msgCls += ' console__msg--warn';
      else if (kind === 'muted') msgCls += ' console__msg--muted';
      var line = '<div class="console__line"><span class="console__time">[' + time + ']</span>'
        + '<span class="' + msgCls + '">' + U.escapeHTML(msg) + '</span></div>';
      if (this.el.console) {
        this.el.console.insertAdjacentHTML('beforeend', line);
        this.el.console.scrollTop = this.el.console.scrollHeight;
      }
    },

    /* ------------------- Status / progress ------------------- */
    setStatus: function (phase, msg) {
      this.state.initPhase = phase;
      this.state.statusMsg = msg;
      this.renderStatus();
    },

    renderStatus: function () {
      if (!this.el.statusBadge) return;
      var cls = 'status-badge';
      var iconHtml = '';
      if (this.isReady()) {
        cls += ' status-badge--ready';
        iconHtml = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
      } else if (this.state.initPhase === INIT_PHASES.ERROR) {
        cls += ' status-badge--error';
        iconHtml = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
      } else {
        cls += ' status-badge--loading';
        iconHtml = '<span class="status-badge__spinner"></span>';
      }
      this.el.statusBadge.className = cls;
      this.el.statusIcon.innerHTML = iconHtml;
      this.el.statusText.textContent = this.state.statusMsg || (this.isReady() ? 'Готово' : '');

      if (this.el.loadingCard) {
        this.el.loadingCard.style.display = this.isLoading() ? 'block' : 'none';
      }
      if (this.el.loadingText && this.state.statusMsg) this.el.loadingText.textContent = this.state.statusMsg;
      if (this.el.loadingSub) {
        this.el.loadingSub.textContent = 'Загрузка графовой модели SZGM (~17 МБ, один раз)...';
      }

      var ready = this.isReady();
      if (this.el.inputText) this.el.inputText.disabled = !ready;
      if (this.el.sampleSelect) this.el.sampleSelect.disabled = !ready;
      if (this.el.btnCompress) this.el.btnCompress.disabled = !ready || !this.state.inputText.trim();
      if (this.el.btnFullCycle) this.el.btnFullCycle.disabled = !ready || !this.state.inputText.trim();
    },

    /* ------------------- Initialization flow ------------------- */
    startInit: function () {
      var self = this;
      self.setStatus(INIT_PHASES.MODEL, 'Загрузка модели...');
      self.addLog('Загрузка графовой модели SZGM...');

      var urls = ['./model/graph-model.bin', '../graph-model.bin', './graph-model.bin'];

      function tryFetch(i) {
        if (i >= urls.length) {
          throw new Error('graph-model.bin не найден (запустите http-сервер из корня проекта: python3 -m http.server)');
        }
        return fetch(urls[i]).then(function (r) {
          if (!r.ok) throw new Error(r.status);
          var total = Number(r.headers.get('Content-Length')) || 0;
          if (!r.body || typeof r.body.getReader !== 'function') return r.arrayBuffer();
          var reader = r.body.getReader();
          var chunks = [], received = 0;
          function pump(chunk) {
            if (chunk.done) {
              var buf = new Uint8Array(received);
              var off = 0;
              for (var j = 0; j < chunks.length; j++) {
                buf.set(chunks[j], off);
                off += chunks[j].length;
              }
              return buf;
            }
            chunks.push(chunk.value);
            received += chunk.value.length;
            if (total) {
              var pct = Math.min(100, Math.round(received / total * 100));
              self.setStatus(INIT_PHASES.MODEL, 'Загрузка модели ' + pct + '%');
            }
            return reader.read().then(pump);
          }
          return reader.read().then(pump);
        }).catch(function (e) {
          return tryFetch(i + 1);
        });
      }

      tryFetch(0).then(function (bytes) {
        var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var model = global.SZGC.loadModel(bytes);
        var parseMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        self.state.model = model;
        self.addLog('✓ Модель SZGM: ' + bytes.length + ' байт, разбор ' + parseMs.toFixed(0) + 'мс', 'ok');
        self.addLog('  Словоформ: ' + model.D.toLocaleString('ru-RU') + ', лемм: ' + model.L.toLocaleString('ru-RU')
          + ', пунктуации: ' + model.P);
        self.setStatus(INIT_PHASES.READY, 'Готово');
        self.addLog('Система готова к сжатию — всё считается локально, офлайн', 'ok');
        self.renderAll();
      }).catch(function (err) {
        self.setStatus(INIT_PHASES.ERROR, 'Ошибка: ' + (err && err.message || err));
        self.addLog('✗ Ошибка: ' + (err && err.message || err), 'err');
      });
    },

    /* ------------------- Sample select ------------------- */
    handleSampleSelect: function (value) {
      var idx = Number(value);
      this.state.selectedSample = value;
      this.state.inputText = SAMPLE_TEXTS[idx].text;
      if (this.el.inputText) this.el.inputText.value = this.state.inputText;
      this.state.compressedData = null;
      this.state.decompressedText = '';
      this.state.stats = null;
      this.state.verificationOk = null;
      this.state.hexDump = '';
      this.state.base64Output = '';
      this.state.wordTable = [];
      this.renderAll();
    },

    /* ------------------- Copy handlers ------------------- */
    handleCopyHex: function () {
      if (!this.state.hexDump) return;
      this.copyToClipboard(this.state.hexDump);
      this.addLog('✓ Hex-дамп скопирован в буфер обмена', 'ok');
    },
    handleCopyBase64: function () {
      if (!this.state.base64Output) return;
      this.copyToClipboard(this.state.base64Output);
      this.addLog('✓ Base64 скопирован в буфер обмена', 'ok');
    },
    copyToClipboard: function (text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          return;
        }
      } catch (e) { /* fall through */ }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    },

    /* ------------------- Char / byte count ------------------- */
    updateCharCount: function () {
      var text = this.state.inputText || '';
      if (this.el.charCount) this.el.charCount.textContent = String(text.length);
      if (this.el.byteCount) this.el.byteCount.textContent = String(U.utf8ByteLength(text));
      var ready = this.isReady();
      if (this.el.btnCompress) this.el.btnCompress.disabled = !ready || !text.trim();
      if (this.el.btnFullCycle) this.el.btnFullCycle.disabled = !ready || !text.trim();
    },

    /* ------------------- Render ------------------- */
    renderAll: function () {
      this.renderStatus();
      this.updateCharCount();
      this.renderStats();
      this.renderResults();
      this.renderLeanMap();
      this.updateDividers();
      if (Decoder && typeof Decoder.renderAll === 'function') {
        Decoder.renderAll();
      }
    },

    updateDividers: function () {
      var hasResults = !!(this.state.compressedData || this.state.decompressedText || (this.state.stats && this.state.stats.compressedBytes));
      var hasLean = !!(this.state.stats && this.state.stats.leanMap && this.state.stats.leanMap.length > 0);
      var hasLogs = !!(this.el.console && this.el.console.children && this.el.console.children.length > 0);
      if (this.el.dividerResults) this.el.dividerResults.classList.toggle('is-hidden', !hasResults);
      if (this.el.dividerLean)    this.el.dividerLean.classList.toggle('is-hidden', !hasLean);
      if (this.el.dividerConsole) this.el.dividerConsole.classList.toggle('is-hidden', !hasLogs);
    },

    renderStats: function () {
      if (!this.el.statsPanel) return;
      this.el.statsPanel.innerHTML = Stats.renderStats(this.state);
    },

    renderResults: function () {
      var hasData = !!(this.state.compressedData || this.state.decompressedText);
      if (this.el.resultsSection) {
        this.el.resultsSection.style.display = hasData ? 'block' : 'none';
      }
      if (!hasData) return;

      if (this.el.decompressedPre) {
        if (this.state.decompressedText) {
          this.el.decompressedPre.innerHTML = Stats.renderPreBlock(this.state.decompressedText, 'code-block code-block--break');
        } else {
          this.el.decompressedPre.innerHTML = '<div class="empty-state"><div class="empty-state__text">Нажмите «Декомпрессировать» или «Сжать и проверить»</div></div>';
        }
      }
      if (this.el.hexPre) {
        this.el.hexPre.textContent = this.state.hexDump || '';
      }
      if (this.el.hexMeta) {
        this.el.hexMeta.textContent = this.state.compressedData
          ? (this.state.compressedData.length + ' байт всего' +
             (this.state.stats ? ' · режим: ' + Stats.modeLabel(this.state.stats.modeUsed) : ''))
          : '0 байт всего';
      }
      if (this.el.base64Pre) {
        this.el.base64Pre.textContent = this.state.base64Output || '';
      }
      if (this.el.wordTableInner) {
        this.el.wordTableInner.innerHTML = Stats.renderWordTable(this.state.wordTable);
      }

      if (this.el.tabsContainer && !this.el.tabsContainer.dataset.inited) {
        Tabs.init(this.el.tabsContainer, 'decompressed');
        this.el.tabsContainer.dataset.inited = '1';
      }
    },

    renderLeanMap: function () {
      var s = this.state.stats;
      var hasLean = s && s.leanMap && s.leanMap.length > 0;
      if (this.el.leanMapCard) {
        this.el.leanMapCard.style.display = hasLean ? 'block' : 'none';
      }
      if (!hasLean) return;
      if (this.el.lemmaWrap) this.el.lemmaWrap.innerHTML = Stats.renderLeanMap(s);
      if (this.el.lemmaCount) this.el.lemmaCount.textContent = String(s.lemmaCount);
      if (this.el.globalLemmaCount) {
        this.el.globalLemmaCount.textContent = s.globalLemmaCount
          ? Number(s.globalLemmaCount).toLocaleString('ru-RU') : '?';
      }
    },

    getSampleTexts: function () { return SAMPLE_TEXTS; },
  };

  global.SyllaZipUI = global.SyllaZipUI || {};
  global.SyllaZipUI.Controller = Controller;
})(typeof window !== 'undefined' ? window : this);
