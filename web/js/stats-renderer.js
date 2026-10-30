/**
  window.SyllaZipUI.StatsRenderer — панель статистики SZGC.
 */
(function (global) {
  'use strict';

  var U = (global.SyllaZipUI || {}).Utils || {};
  var esc = U.escapeHTML || function (s) { return s; };

  var StatsRenderer = {
    compressionRatio: function (stats) {
      if (!stats || !stats.originalBytes) return '—';
      return ((1 - stats.compressedBytes / stats.originalBytes) * 100).toFixed(1);
    },

    compressionFactor: function (stats) {
      if (!stats || !stats.originalBytes || !stats.compressedBytes) return '—';
      return (stats.originalBytes / stats.compressedBytes).toFixed(2);
    },

    modeLabel: function (tag) {
      return U.modeLabel(tag);
    },

    modeHint: function (tag) {
      var m = U.modeInfo(tag);
      return m ? m.hint : '';
    },

    renderStats: function (state) {
      var s = state.stats;
      if (!s) {
        return StatsRenderer.renderEmptyState(state.isLoading);
      }

      var ratio = StatsRenderer.compressionRatio(s);
      var factor = StatsRenderer.compressionFactor(s);
      var ratioPositive = Number(ratio) > 0;

      var html = '';

      html += '<div class="mb-2">'
        + '<div class="stat-row mb-1">'
        + '  <span class="label">Сжатие</span>'
        + '  <span class="value value--accent" style="font-size:1.4rem;">' + esc(ratio) + '%</span>'
        + '</div>'
        + '<div class="progress">'
        + '  <div class="progress__bar' + (ratioPositive ? '' : ' progress__bar--crimson') + '" style="width:' + Math.max(0, Number(ratio)) + '%"></div>'
        + '</div>'
        + '<p class="field-meta mt-1">Коэффициент сжатия: ' + esc(factor) + 'x</p>'
        + '</div>';

      html += '<hr class="stat-sep" />';

      html += '<div class="stats-grid-2">'
        + '  <div class="stat-block">'
        + '    <div class="stat-block__num">' + esc(s.originalBytes) + '</div>'
        + '    <div class="stat-block__label">оригинал, байт</div>'
        + '  </div>'
        + '  <div class="stat-block">'
        + '    <div class="stat-block__num">' + esc(s.compressedBytes) + '</div>'
        + '    <div class="stat-block__label">сжатый, байт</div>'
        + '  </div>'
        + '</div>';

      html += '<hr class="stat-sep" />';

      html += '<div class="mb-2">'
        + '  <div class="field-label" style="margin-bottom:0.4rem;">Режим</div>'
        + '  <div class="flex-wrap">'
        + '    <span class="badge badge--outline" title="' + esc(StatsRenderer.modeHint(s.modeUsed)) + '">' + esc(StatsRenderer.modeLabel(s.modeUsed)) + '</span>'
        + '  </div>'
        + (StatsRenderer.modeHint(s.modeUsed)
          ? '<p class="field-meta mt-1">' + esc(StatsRenderer.modeHint(s.modeUsed)) + '</p>'
          : '')
        + '</div>';

      html += '<hr class="stat-sep" />';

      if (s.candidateSizes) {
        html += StatsRenderer.renderCandidateSizes(s);
        html += '<hr class="stat-sep" />';
      }

      html += '<div class="mb-2">'
        + '  <div class="field-label" style="margin-bottom:0.4rem;">Морфология</div>'
        + '  <div class="stats-grid-2">'
        + '    <div class="stat-block">'
        + '      <div class="stat-block__num">' + esc(s.dictHits) + '</div>'
        + '      <div class="stat-block__label">найдено</div>'
        + '    </div>'
        + '    <div class="stat-block">'
        + '      <div class="stat-block__num stat-block__num--crimson">' + esc(s.dictMisses) + '</div>'
        + '      <div class="stat-block__label">не найдено</div>'
        + '    </div>'
        + '  </div>'
        + (s.totalWords > 0
            ? '<p class="field-meta mt-1">Покрытие: ' + ((s.dictHits / s.totalWords) * 100).toFixed(1) + '%</p>'
            : '')
        + '</div>';

      html += '<hr class="stat-sep" />';

      html += '<div class="mb-2">'
        + '  <div class="field-label" style="margin-bottom:0.4rem;">Леммы</div>'
        + '  <div class="stat-block">'
        + '    <div class="stat-block__num">' + esc(s.lemmaCount || 0) + '</div>'
        + '    <div class="stat-block__label">лемм в тексте</div>'
        + '  </div>'
        + (s.globalLemmaCount
            ? '<p class="field-meta mt-1">В модели: ' + esc(Number(s.globalLemmaCount).toLocaleString('ru-RU')) + ' лемм</p>'
            : '')
        + '</div>';

      html += '<hr class="stat-sep" />';

      html += '<div class="mb-2">'
        + '  <div class="field-label" style="margin-bottom:0.4rem;">Время</div>'
        + '  <div class="stat-row mb-1"><span class="label">Сжатие</span><span class="value">' + (state.compressTime || 0).toFixed(1) + ' мс</span></div>'
        + (state.decompressTime > 0 ? '<div class="stat-row"><span class="label">Декомпрессия</span><span class="value">' + state.decompressTime.toFixed(1) + ' мс</span></div>' : '')
        + '</div>';

      if (state.verificationOk !== null && state.verificationOk !== undefined) {
        html += '<hr class="stat-sep" />';
        html += StatsRenderer.renderVerification(state.verificationOk);
      }

      if (state.compressedData && !state.decompressedText) {
        html += '<hr class="stat-sep" />';
        html += '<button class="btn btn--secondary btn--block" data-action="decompress">'
          + '  Декомпрессировать'
          + '</button>';
      }

      return html;
    },

    renderEmptyState: function (isLoading) {
      var sub = isLoading
        ? 'Загрузка модели SZGM...'
        : 'Готов к работе. Введите текст и нажмите «Сжать».';
      var icon = isLoading
        ? '<div class="status-badge__spinner"></div>'
        : '<svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>';
      return '<div class="empty-state">' + icon + '<div class="empty-state__text">' + esc(sub) + '</div></div>';
    },

    renderCandidateSizes: function (stats) {
      var cs = stats.candidateSizes;
      var mode = stats.modeUsed;
      var rows = '';
      rows += StatsRenderer.candRow(2, cs.tokens, mode === 2);
      rows += StatsRenderer.candRow(3, cs.bytes0, mode === 3);
      rows += StatsRenderer.candRow(4, cs.bytes1, mode === 4);
      rows += StatsRenderer.candRow(5, cs.bytes2, mode === 5);
      return '<div>'
        + '<div class="field-label" style="margin-bottom:0.4rem;">Сравнение вариантов</div>'
        + '<div class="candidates">' + rows + '</div>'
        + '<p class="field-meta mt-1">Кодек сжимает текст всеми способами и берёт самый компактный. '
        + 'Варианты «Байты…» — резервы для текста, которого нет в словаре (шум, другие алфавиты).</p>'
        + '</div>';
    },

    candRow: function (tag, size, chosen) {
      var info = U.modeInfo(tag);
      var label = info ? info.label : String(tag);
      var title = info ? ' title="' + esc(info.hint) + '"' : '';
      return '<div class="candidate' + (chosen ? ' is-chosen' : '') + '"' + title + '>'
        + '<span class="candidate__label">' + esc(label) + '</span>'
        + '<span class="candidate__value">' + esc(size) + ' б</span>'
        + '</div>';
    },

    renderVerification: function (ok) {
      if (ok) {
        return '<div class="verification verification--ok">'
          + '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
          + '<span>Верификация пройдена</span>'
          + '</div>';
      }
      return '<div class="verification verification--err">'
        + '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
        + '<span>Ошибка верификации!</span>'
        + '</div>';
    },

    renderWordTable: function (wordTable) {
      if (!wordTable || !wordTable.length) {
        return '<div class="empty-state"><div class="empty-state__text">Нет записей в таблице токенов.</div></div>';
      }
      var rows = '';
      for (var i = 0; i < wordTable.length; i++) {
        var e = wordTable[i];
        var rowClass = '', badge = '', text = '';
        if (e.type === 0) {
          rowClass = 'word-row--morph';
          badge = '<span class="badge badge--brass">МОРФ</span>';
          text = '<span class="word-row__text word-row__text--morph">rank=' + esc(e.rank)
            + (e.lemmaId !== null && e.lemmaId !== undefined ? ' lemma=' + esc(e.lemmaId) : '')
            + ' &laquo;' + esc(e.wordText) + '&raquo;</span>';
        } else if (e.type === 1) {
          rowClass = 'word-row--literal';
          badge = '<span class="badge badge--amber">ЛИТ</span>';
          text = '<span class="word-row__text word-row__text--literal">"' + esc(e.wordText) + '"</span>';
        } else if (e.type === 2) {
          rowClass = 'word-row--literal';
          badge = '<span class="badge badge--outline">СИМВ</span>';
          text = '<span class="word-row__text word-row__text--literal">"' + esc(e.wordText) + '"</span>';
        } else {
          rowClass = 'word-row--literal';
          badge = '<span class="badge badge--amber">ЛИТ</span>';
          text = '<span class="word-row__text word-row__text--literal">"' + esc(e.wordText) + '"</span>';
        }
        rows += '<div class="word-row ' + rowClass + '">'
          + '<span class="word-row__idx">#' + i + '</span>'
          + badge
          + text
          + '</div>';
      }
      return '<div class="word-list">' + rows + '</div>';
    },

    renderLeanMap: function (stats) {
      if (!stats || !stats.leanMap || !stats.leanMap.length) return '';
      var chips = '';
      for (var i = 0; i < stats.leanMap.length; i++) {
        var e = stats.leanMap[i];
        chips += '<span class="lemma-chip">'
          + '<span class="lemma-chip__id">' + esc(e.rank) + '</span>' + esc(e.word)
          + '</span>';
      }
      return chips;
    },

    renderPreBlock: function (text, classes) {
      classes = classes || 'code-block';
      return '<pre class="' + classes + '">' + esc(text || '') + '</pre>';
    },
  };

  global.SyllaZipUI = global.SyllaZipUI || {};
  global.SyllaZipUI.StatsRenderer = StatsRenderer;
})(typeof window !== 'undefined' ? window : this);
