/**
 * window.SyllaZipUI.CompressionHandler — сжатие/декомпрессия через SZGC.
 */
(function (global) {
  'use strict';

  var U = (global.SyllaZipUI || {}).Utils || {};

  /** Токен-таблица: зеркало решения кодека (словарь vs литерал), без правок кодека. */
  function analyzeTokens(model, text) {
    var toks = global.SZGC.internals.tokenize(text);
    var rankMap = model.rank;
    var entries = [];
    var hits = 0, misses = 0, totalWords = 0;
    var lemmaSet = new Set();
    for (var i = 0; i < toks.length; i++) {
      var kind = toks[i][0], tok = toks[i][1];
      if (kind === 'word') {
        totalWords++;
        var low = tok.toLowerCase();
        var r = rankMap.has(low) ? rankMap.get(low) : null;
        var flag = global.SZGC.internals.getCase(tok);
        var ok = r !== null && flag !== 3 && global.SZGC.internals.applyCase(model.words[r], flag) === tok;
        if (ok) {
          hits++;
          if (model.lemmaIds) lemmaSet.add(model.lemmaIds[r]);
          entries.push({ type: 0, rank: r, wordText: tok, lemmaId: model.lemmaIds ? model.lemmaIds[r] : null });
        } else {
          misses++;
          entries.push({ type: 1, wordText: tok });
        }
      } else if (tok.length && tok.trim().length === tok.length && tok.trim().length > 0) {
        entries.push({ type: 2, wordText: tok });
      } else {
        entries.push({ type: 3, wordText: tok });
      }
    }
    return { entries: entries, hits: hits, misses: misses, totalWords: totalWords, lemmaSet: lemmaSet };
  }

  var CompressionHandler = {
    compress: function (ctx) {
      if (!ctx.isReady() || !ctx.state.inputText || !ctx.state.inputText.trim()) {
        return Promise.resolve();
      }
      var text = ctx.state.inputText;
      ctx.addLog('Сжатие текста (' + text.length + ' символов)...');
      var startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());

      return Promise.resolve().then(function () {
        var SZGC = global.SZGC;
        var model = ctx.state.model;
        var result = SZGC.compress(text);

        // Кандидаты: графовый + три байтовых (те же вызовы, что внутри encode).
        var coder = new SZGC.SZGC2(model);
        var candTok = coder._encodeTokens(text).length;
        var candB0 = coder._encodeBytes(text, 0).length;
        var candB1 = coder._encodeBytes(text, 1).length;
        var candB2 = coder._encodeBytes(text, 2).length;

        var elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
        var analysis = analyzeTokens(model, text);
        var raw = U.utf8ByteLength(text);

        ctx.state.compressedData = result;
        ctx.state.compressTime = elapsed;
        ctx.state.stats = {
          originalBytes: raw,
          compressedBytes: result.length,
          modeUsed: result[0],
          candidateSizes: { tokens: candTok, bytes0: candB0, bytes1: candB1, bytes2: candB2 },
          dictHits: analysis.hits,
          dictMisses: analysis.misses,
          totalWords: analysis.totalWords,
          lemmaCount: analysis.lemmaSet.size,
          globalLemmaCount: model.L || null,
          wordTable: analysis.entries,
          leanMap: analysis.entries.filter(function (e) { return e.type === 0; })
            .map(function (e) { return { rank: e.rank, word: e.wordText, lemmaId: e.lemmaId }; }),
        };
        ctx.state.hexDump = U.hexDump(result, 256);
        ctx.state.base64Output = U.toBase64(result);
        ctx.state.wordTable = analysis.entries;
        ctx.state.verificationOk = null;
        ctx.state.decompressedText = '';

        ctx.addLog('✓ Сжатие завершено за ' + elapsed.toFixed(1) + 'мс');
        ctx.addLog('  Оригинал: ' + raw + ' байт → Сжатый: ' + result.length + ' байт');
        ctx.addLog('  Слов в словаре: ' + analysis.hits + ', не найдено: ' + analysis.misses);
        ctx.addLog('  Режим: ' + CompressionHandler.modeLabel(result[0]));
        ctx.renderAll();
      }).catch(function (err) {
        ctx.addLog('✗ Ошибка сжатия: ' + (err && err.message || err), 'err');
      });
    },

    modeLabel: function (tag) {
      return U.modeLabel(tag);
    },

    decompress: function (ctx) {
      if (!ctx.isReady() || !ctx.state.compressedData) return Promise.resolve();
      ctx.addLog('Декомпрессия...');
      var startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());

      return Promise.resolve().then(function () {
        var result = global.SZGC.decompress(ctx.state.compressedData);
        var elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
        ctx.state.decompressedText = result;
        ctx.state.decompressTime = elapsed;
        var verified = result === ctx.state.inputText;
        ctx.state.verificationOk = verified;
        ctx.addLog('✓ Декомпрессия за ' + elapsed.toFixed(1) + 'мс — '
          + (verified ? 'верификация пройдена' : 'ОШИБКА: текст не совпадает!'),
          verified ? 'ok' : 'err');
        ctx.renderAll();
      }).catch(function (err) {
        ctx.addLog('✗ Ошибка декомпрессии: ' + (err && err.message || err), 'err');
      });
    },

    fullCycle: function (ctx) {
      var self = this;
      if (!ctx.isReady() || !ctx.state.inputText || !ctx.state.inputText.trim()) return Promise.resolve();
      return self.compress(ctx).then(function () {
        if (!ctx.state.compressedData) return;
        return self.decompress(ctx);
      });
    },
  };

  global.SyllaZipUI = global.SyllaZipUI || {};
  global.SyllaZipUI.CompressionHandler = CompressionHandler;
})(typeof window !== 'undefined' ? window : this);
