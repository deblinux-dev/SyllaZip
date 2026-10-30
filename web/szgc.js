/*
 * SZGC — морфографовый предиктивный кодек (браузерный порт Python-реализации).
 *
 * Поток: тег режима (0x02 токенный / 0x03..0x05 байтовые) + range-код LZMA-стиля.
 * Токенный режим: kind-биграммы -> LZP -> B2/B1/C/LEM -> O0 -> ESC_RANK(varint);
 *                 сырые байты через o3->o2->o1(hit-бит)->o0.
 * Байтовые режимы: varint-длина + поток байт (глубина цепочки 3+2+0 / 2+0 / 0).
 * (UMD: Node + браузер)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SZGC = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------ константы
  var M32 = 0xFFFFFFFF;
  var TOP = 1 << 24;
  var ADAPT = 24;
  var RESIZE = 32768;
  var CTX_CAP = 192;
  var ESC_RANK = -1;
  var ESC_LIT = -2;
  var W_MATCH = 4096, ESC_MATCH = 384;
  var PAIR_SHIFT = 21;
  var W_LZP_HIT = 4096, W_LZP_MISS = 128;
  var B_ESC = 12, B_ASTEP = 48;
  var W1_O0 = 64, W1_ROW = 192, W1_FORCE = 48;
  var WORD_RE = /[\u0410-\u042F\u0430-\u044F\u0401\u0451A-Za-z]+/g;

  // bit_length для неотрицательных целых (Number < 2^53)
  function bitLength(x) {
    if (x <= 0) return 0;
    if (x <= 0xFFFFFFFF) return 32 - Math.clz32(x);
    var n = 0;
    while (x > 0) { x = Math.floor(x / 2); n++; }
    return n;
  }

  // ------------------------------------------------------------ varint io
  function putVarint(buf, n) {
    var v = n;
    for (;;) {
      var b = v & 0x7F;
      v = Math.floor(v / 128);
      if (v) buf.push(b | 0x80);
      else { buf.push(b); return; }
    }
  }

  // ------------------------------------------------------------ range coder
  function RangeEncoder() {
    this.low = 0;            // < 2^33 (с переносом)
    this.range = 0xFFFFFFFF;
    this.cache = 0;
    this.cacheSize = 1;
    this.out = [];
  }

  RangeEncoder.prototype._shiftLow = function () {
    var low = this.low;
    if (((low % 4294967296) >>> 0) < 0xFF000000 || low > M32) {
      var carry = low > M32 ? 1 : 0;
      var temp = this.cache;
      for (;;) {
        this.out.push((temp + carry) & 0xFF);
        temp = 0xFF;
        this.cacheSize--;
        if (this.cacheSize === 0) break;
      }
      this.cache = Math.floor(low / 16777216) & 255;   // (low >> 24) & 0xFF
    }
    this.cacheSize++;
    this.low = (low * 256) % 4294967296;               // (low << 8) & M32, точно < 2^53
  };

  RangeEncoder.prototype.encode = function (cum, freq, tot) {
    var r = Math.floor(this.range / tot);
    this.low += cum * r;              // low < 2^32 + ~7e11 < 2^53 — точно
    this.range = freq * r;            // < 2^32
    while (this.range < TOP) {
      this._shiftLow();
      this.range = this.range * 256;  // range < 2^24*256 < 2^32
    }
  };

  RangeEncoder.prototype.flush = function () {
    for (var i = 0; i < 5; i++) this._shiftLow();
    var out = this.out;
    out.shift();                       // ведущий нулевой байт
    return out;
  };

  function RangeDecoder(data) {
    this.d = data;
    this.p = 0;
    this.range = 0xFFFFFFFF;
    this.code = 0;
    for (var i = 0; i < 4; i++) {
      // Python: (code << 8 | b) & M32 — беззнаково; в JS << даёт знаковый int32
      this.code = (((this.code * 256) + this._byte()) % 4294967296) >>> 0;
    }
    this.clamped = 0;
  }

  RangeDecoder.prototype._byte = function () {
    return this.p < this.d.length ? this.d[this.p++] : 0;
  };

  RangeDecoder.prototype.start = function (tot) {
    this._r = Math.floor(this.range / tot);
    var cum = Math.floor(this.code / this._r);
    if (cum >= tot) { cum = tot - 1; this.clamped++; }
    return cum;
  };

  RangeDecoder.prototype.finish = function (cum, freq) {
    this.code = (((this.code - cum * this._r) % 4294967296) + 4294967296) % 4294967296;
    this.range = freq * this._r;
    while (this.range < TOP) {
      this.range = this.range * 256;
      this.code = (this.code * 256 + this._byte()) % 4294967296;
    }
  };

  // ----------------------------------------------------- FT: base + delta
  function FT(syms, weights, esc, opts) {
    opts = opts || {};
    this.bs = syms ? syms.slice() : [];
    this.bw = weights ? weights.slice() : [];
    this.bset = new Set(this.bs);
    this.esc = esc;
    this.baseEsc = esc;
    var s = 0;
    for (var i = 0; i < this.bw.length; i++) s += this.bw[i];
    this.baseSum = s;
    this.isO0 = false;
    this.esc0 = null;
    this.astep = opts.astep !== undefined ? opts.astep : ADAPT;
    this.cap = opts.cap !== undefined ? opts.cap : null;
    this.resizeAt = opts.resizeAt !== undefined ? opts.resizeAt : RESIZE;
    this.delta = new Map();
    this._tot = this.baseSum + esc;
  }

  FT.prototype._cap = function () {
    return this.cap !== null ? this.cap : CTX_CAP + Math.floor(this.baseSum / 16);
  };

  FT.prototype.total = function () { return this._tot; };

  FT.prototype.totalExcl = function (excl) {
    if (!excl || excl.size === 0) return this._tot;
    var lo = 0, i, s;
    var bs = this.bs, bw = this.bw, delta = this.delta;
    for (i = 0; i < bs.length; i++) {
      s = bs[i];
      if (excl.has(s)) continue;
      lo += bw[i] + (delta.has(s) ? delta.get(s) : 0);
    }
    delta.forEach(function (dw, key) {
      if (!this.bset.has(key) && !excl.has(key)) lo += dw;
    }, this);
    return lo + this.esc;
  };

  FT.prototype.reset = function () {
    this.delta.clear();
    this.esc = this.baseEsc;
    this._tot = this.baseSum + this.esc;
  };

  FT.prototype.inTable = function (sym, excl) {
    if (this.bset.has(sym)) return !(excl && excl.has(sym));
    if (this.delta.has(sym)) return !(excl && excl.has(sym));
    return false;
  };

  FT.prototype.findEncode = function (sym, excl) {
    var lo = 0, found = false, freq = 0, cum = 0, i, s, w;
    var bs = this.bs, bw = this.bw, delta = this.delta;
    for (i = 0; i < bs.length; i++) {
      s = bs[i];
      if (excl && excl.has(s)) continue;
      w = bw[i] + (delta.has(s) ? delta.get(s) : 0);
      if (w && s === sym) { found = true; freq = w; cum = lo; }
      lo += w;
    }
    var keys = [];
    delta.forEach(function (dw, key) { keys.push(key); });
    for (i = 0; i < keys.length; i++) {
      s = keys[i];
      if (this.bset.has(s) || (excl && excl.has(s))) continue;
      var dw = delta.get(s);
      if (s === sym) { found = true; freq = dw; cum = lo; }
      lo += dw;
    }
    var tot = lo + this.esc;
    if (found) return [cum, freq, tot];
    return [tot - this.esc, this.esc, tot];
  };

  FT.prototype.decodeSym = function (cum, excl) {
    var lo = 0, i, s, w;
    var bs = this.bs, bw = this.bw, delta = this.delta;
    for (i = 0; i < bs.length; i++) {
      s = bs[i];
      if (excl && excl.has(s)) continue;
      w = bw[i] + (delta.has(s) ? delta.get(s) : 0);
      if (cum < lo + w) return [s, lo, w];
      lo += w;
    }
    var keys = [];
    delta.forEach(function (dw, key) { keys.push(key); });
    for (i = 0; i < keys.length; i++) {
      s = keys[i];
      if (this.bset.has(s) || (excl && excl.has(s))) continue;
      var dw = delta.get(s);
      if (cum < lo + dw) return [s, lo, dw];
      lo += dw;
    }
    return [null, lo, this.esc];
  };

  FT.prototype.adapt = function (sym, insert, insertSym) {
    if (sym === null || sym === undefined) {
      if (this.esc < 60000) { this.esc += this.astep; this._tot += this.astep; }
      if (insert && insertSym !== null && insertSym !== undefined) {
        if (this.delta.has(insertSym)) {
          var dv = this.delta.get(insertSym);
          if (dv < 60000) { this.delta.set(insertSym, dv + this.astep); this._tot += this.astep; }
        } else if (!this.bset.has(insertSym) &&
                   this.bs.length + this.delta.size < this._cap()) {
          this.delta.set(insertSym, this.astep);
          this._tot += this.astep;
        }
      }
    } else if (this.bset.has(sym)) {
      var old = this.delta.has(sym) ? this.delta.get(sym) : 0;
      if (old < 60000) { this.delta.set(sym, old + this.astep); this._tot += this.astep; }
    } else {
      if (this.delta.has(sym)) {
        var ov = this.delta.get(sym);
        if (ov < 60000) { this.delta.set(sym, ov + this.astep); this._tot += this.astep; }
      } else if (this.bs.length + this.delta.size < this._cap()) {
        this.delta.set(sym, this.astep);
        this._tot += this.astep;
      }
    }
    if (this._tot >= this.resizeAt && !this.isO0) this._resize();
    return this;
  };

  FT.prototype._resize = function () {
    var nd = new Map(), i, s;
    var bs = this.bs, bw = this.bw, delta = this.delta;
    for (i = 0; i < bs.length; i++) {
      s = bs[i];
      var eff = Math.floor((bw[i] + (delta.has(s) ? delta.get(s) : 0)) / 2);
      var d = eff - bw[i];
      if (d > 0) nd.set(s, d);
    }
    delta.forEach(function (dw, key) {
      if (this.bset.has(key)) return;
      var e = Math.floor(dw / 2);
      if (e > 0) nd.set(key, e);
    }, this);
    this.delta = nd;
    this.esc = Math.max(1, Math.floor(this.esc / 2));
    var tot = this.baseSum + this.esc;
    nd.forEach(function (v) { tot += v; });
    this._tot = tot;
  };

  // --------------------------------------------------------- FenwickO0
  function FenwickO0(syms, weights, escRank, escLit) {
    this.bs = syms.slice();
    this.bweight = weights.slice();
    this.pos = new Map();
    for (var i = 0; i < this.bs.length; i++) this.pos.set(this.bs[i], i);
    this.bset = new Set(this.bs);
    var n = this.bs.length;
    this.tree = new Float64Array(n + 1);   // суммы < 2^53, целые точно
    for (i = 0; i < this.bweight.length; i++) this._treeAdd(i + 1, this.bweight[i]);
    var raw = 0;
    for (i = 0; i < this.bweight.length; i++) raw += this.bweight[i];
    this.rawTot = raw;
    this.escRank = escRank;
    this.escLit = escLit;
    this.escRank0 = escRank;
    this.escLit0 = escLit;
    this.extra = new Map();
    this.adds = [];
    this.delta = new Map();          // совместимость с FT-API (пустая, как в Python)
  }

  FenwickO0.prototype._treeAdd = function (i, v) {
    var tree = this.tree, n = this.tree.length - 1;
    while (i <= n) { tree[i] += v; i += i & (-i); }
  };

  FenwickO0.prototype._prefix = function (i) {
    var s = 0, tree = this.tree;
    while (i > 0) { s += tree[i]; i -= i & (-i); }
    return s;
  };

  FenwickO0.prototype._wOf = function (s) {
    return this.bweight[this.pos.get(s)] + (this.extra.has(s) ? this.extra.get(s) : 0);
  };

  FenwickO0.prototype._exclSorted = function (excl) {
    var items = [];
    excl.forEach(function (s) {
      if (this.pos.has(s)) items.push([this.pos.get(s), this._wOf(s)]);
    }, this);
    items.sort(function (a, b) { return a[0] - b[0]; });
    return items;
  };

  FenwickO0.prototype._exclBelow = function (items, idx) {
    var s = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i][0] < idx) s += items[i][1];
      else break;
    }
    return s;
  };

  FenwickO0.prototype.total = function () {
    return this.rawTot + this.escRank + this.escLit;
  };

  FenwickO0.prototype.totalExcl = function (excl) {
    if (!excl || excl.size === 0) return this.total();
    var self = this, s = 0;
    excl.forEach(function (x) { if (self.pos.has(x)) s += self._wOf(x); });
    return this.total() - s;
  };

  FenwickO0.prototype.inTable = function (sym, excl) {
    if (this.bset.has(sym)) return !(excl && excl.has(sym));
    return false;
  };

  FenwickO0.prototype.reset = function () {
    for (var i = 0; i < this.adds.length; i++) {
      var idx = this.adds[i][0], v = this.adds[i][1];
      this._treeAdd(idx + 1, -v);
      this.rawTot -= v;
    }
    this.adds.length = 0;
    this.extra.clear();
    this.escRank = this.escRank0;
    this.escLit = this.escLit0;
  };

  FenwickO0.prototype.adapt = function (sym) {
    if (sym === ESC_RANK) {
      this.escRank = Math.min(60000, this.escRank + ADAPT);
    } else if (sym === ESC_LIT) {
      this.escLit = Math.min(60000, this.escLit + ADAPT);
    } else if (this.pos.has(sym)) {
      var w = this.extra.has(sym) ? this.extra.get(sym) : 0;
      if (w < 60000) {
        var idx = this.pos.get(sym);
        this._treeAdd(idx + 1, ADAPT);
        this.rawTot += ADAPT;
        this.adds.push([idx, ADAPT]);
        this.extra.set(sym, w + ADAPT);
      }
    }
    return this;
  };

  FenwickO0.prototype.findEncode = function (sym, excl) {
    var items = excl ? this._exclSorted(excl) : [];
    var exclSum = 0, i;
    for (i = 0; i < items.length; i++) exclSum += items[i][1];
    if (sym === ESC_RANK || sym === ESC_LIT) {
      var base = this.rawTot - exclSum;
      var tot = base + this.escRank + this.escLit;
      if (sym === ESC_RANK) return [base, this.escRank, tot];
      return [base + this.escRank, this.escLit, tot];
    }
    if (!this.pos.has(sym) || (excl && excl.has(sym))) {
      var b0 = this.rawTot - exclSum;
      return [b0, this.escRank, b0 + this.escRank + this.escLit];
    }
    var idx = this.pos.get(sym);
    var w = this._wOf(sym);
    var cum = this._prefix(idx) - this._exclBelow(items, idx);
    var t = this.rawTot - exclSum + this.escRank + this.escLit;
    return [cum, w, t];
  };

  FenwickO0.prototype.decodeSym = function (cum, excl) {
    var items = excl ? this._exclSorted(excl) : [];
    var exclSum = 0, i;
    for (i = 0; i < items.length; i++) exclSum += items[i][1];
    var baseTot = this.rawTot - exclSum;
    if (cum >= baseTot) {
      if (cum < baseTot + this.escRank) return [ESC_RANK, baseTot, this.escRank];
      return [ESC_LIT, baseTot + this.escRank, this.escLit];
    }
    var lo = 0, hi = this.bs.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var ap = this._prefix(mid + 1) - this._exclBelow(items, mid + 1);
      if (ap > cum) hi = mid;
      else lo = mid + 1;
    }
    var idx = lo;
    var s = this.bs[idx];
    var w = this._wOf(s);
    var loCum = this._prefix(idx) - this._exclBelow(items, idx);
    return [s, loCum, w];
  };

  // --------------------------------------------------------- utf8 helpers
  var TE = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var TD = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

  function utf8Encode(str) {
    if (TE) return TE.encode(str);
    // минимальный резервный путь
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (TD) return TD.decode(bytes);
    var out = "", i = 0;
    while (i < bytes.length) {
      var b = bytes[i], c;
      if (b < 0x80) { c = b; i += 1; }
      else if (b < 0xE0) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
      else if (b < 0xF0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
      else { c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
      out += String.fromCodePoint(c);
    }
    return out;
  }

  // --------------------------------------------------------- бинарный reader
  function Reader(data) {
    this.d = data;
    this.p = 0;
  }

  Reader.prototype.varint = function () {
    var v = 0, sh = 1;
    for (;;) {
      var b = this.d[this.p++];
      v += (b & 0x7F) * sh;
      if (!(b & 0x80)) return v;
      sh *= 128;
    }
  };

  Reader.prototype.blob = function () {
    var n = this.varint();
    var b = this.d.subarray(this.p, this.p + n);
    this.p += n;
    return b;
  };

  // --------------------------------------------------------- модель SZGM
  function Model(path_or_bytes, fetch_bytes) {
    var data = path_or_bytes;                 // Uint8Array
    if (typeof path_or_bytes === "string") throw new Error("use loadModelFromBytes");
    var magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== "SZGM" || data[4] !== 2) throw new Error("bad model");
    var r = new Reader(data);
    r.p = 5;
    this.D = r.varint();
    this.P = r.varint();
    this.L = r.varint();
    this.O0TOP = r.varint();
    this.B1ROWS = r.varint();
    this.B2ROWS = r.varint();
    this.LEMROWS = r.varint();
    var i;
    this.puncts = [];
    for (i = 0; i < this.P; i++) this.puncts.push(utf8Decode(r.blob()));
    this.words = new Array(this.D);
    for (i = 0; i < this.D; i++) this.words[i] = utf8Decode(r.blob());
    this.rank = new Map();
    for (i = 0; i < this.D; i++) this.rank.set(this.words[i], i);
    this.lemmaIds = new Array(this.D);
    for (i = 0; i < this.D; i++) this.lemmaIds[i] = r.varint();
    // order-0
    var n0 = r.varint();
    var syms = new Array(n0), ws = new Array(n0);
    for (i = 0; i < n0; i++) { syms[i] = r.varint(); ws[i] = r.varint(); }
    var escRank = r.varint(), escLit = r.varint();
    this.stO0 = new FenwickO0(syms, ws, escRank, escLit);
    this.b1 = this._rows(r);
    this.b2 = this._rows(r);
    this.lem = this._rows(r);
    this.A = this._rows(r);
    this.C = this._rows(r);
    var bw = new Array(256);
    for (i = 0; i < 256; i++) bw[i] = r.varint();
    this.stByte = new FT(range256(), bw, 0, { astep: 64, resizeAt: 10000 });
    this.byte1Rows = new Map();
    var nb1 = r.varint();
    for (i = 0; i < nb1; i++) {
      var pbi = r.varint(), k = r.varint();
      var ss = new Array(k), ww = new Array(k);
      for (var j = 0; j < k; j++) { ss[j] = r.varint(); ww[j] = r.varint(); }
      this.byte1Rows.set(pbi, [ss, ww]);
    }
    this.stCase = [];
    for (i = 0; i < 4; i++) {
      var row = [r.varint(), r.varint(), r.varint()];
      this.stCase.push(new FT([0, 1, 2], row, 0));
    }
    var lw = new Array(64);
    for (i = 0; i < 64; i++) lw[i] = r.varint();
    var idx64 = [];
    for (i = 0; i < 64; i++) idx64.push(i);
    this.stLen = new FT(idx64, lw, 0, { astep: 96 });
    this.touched = new Set();
  }

  Model.prototype._rows = function (r) {
    var d = new Map();
    var n = r.varint();
    for (var i = 0; i < n; i++) {
      var key = r.varint(), cnt = r.varint();
      var syms = new Array(cnt), ws = new Array(cnt);
      for (var j = 0; j < cnt; j++) { syms[j] = r.varint(); ws[j] = r.varint(); }
      d.set(key, new FT(syms, ws, 40));
    }
    return d;
  };

  function range256() {
    var a = new Array(256);
    for (var i = 0; i < 256; i++) a[i] = i;
    return a;
  }

  // --------------------------------------------------------- текстовые хелперы
  function isUpperC(c) {
    return (c >= "A" && c <= "Z") || (c >= "\u0410" && c <= "\u042F") || c === "\u0401";
  }
  function isLowerC(c) {
    return (c >= "a" && c <= "z") || (c >= "\u0430" && c <= "\u044F") || c === "\u0451";
  }
  function strIsLower(w) {
    var up = false, lo = false;
    for (var i = 0; i < w.length; i++) {
      if (isUpperC(w[i])) up = true;
      else if (isLowerC(w[i])) lo = true;
    }
    return lo && !up;
  }
  function strIsUpper(w) {
    var up = false, lo = false;
    for (var i = 0; i < w.length; i++) {
      if (isUpperC(w[i])) up = true;
      else if (isLowerC(w[i])) lo = true;
    }
    return up && !lo;
  }
  function getCase(w) {
    if (strIsLower(w)) return 0;
    if (isUpperC(w[0]) && (w.length === 1 || strIsLower(w.slice(1)))) return 1;
    if (w.length >= 2 && strIsUpper(w)) return 2;
    return 3;
  }
  function applyCase(w, f) {
    if (f === 0) return w;
    if (f === 1) return w[0].toUpperCase() + w.slice(1);
    return w.toUpperCase();
  }
  function tokenize(text) {
    var out = [], pos = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      if (m.index > pos) out.push(["lit", text.slice(pos, m.index)]);
      out.push(["word", m[0]]);
      pos = m.index + m[0].length;
    }
    if (pos < text.length) out.push(["lit", text.slice(pos)]);
    return out;
  }

  // --------------------------------------------------------- кодек
  function SZGC2(model) {
    this.m = model;
    this.match = new Map();
    this.b1c = new Map();
    this.b1hit = new Map();
    this.bctx = [null, new Map(), new Map(), new Map()];  // по order
    this.bhist = [];
    this.byteMode = null;
    this._bo0 = null;
    this.kindc = new Map();
    this.lastKind = 0;
    this.prev = null;
    this.prev2 = null;
    this.w1 = null;
    this.w2 = null;
    this.wlist = [];
    this.lzpPos = new Map();
    this.lzpFlag = new FT([1, 0], [W_LZP_HIT, W_LZP_MISS], 0);
    this.rawT = new FT([0, 1, 2], [64, 96, 40], 0);
  }

  SZGC2.prototype._fresh = function () {
    var self = this;
    this.m.touched.forEach(function (ft) { ft.reset(); });
    this.m.touched.clear();
    this.match.clear();
    this.b1c.clear();
    this.b1hit.clear();
    this.bctx[1].clear(); this.bctx[2].clear(); this.bctx[3].clear();
    this.bhist = [];
    if (this._bo0 !== null) this._bo0.reset();
    this.prev = this.prev2 = null;
    this.w1 = this.w2 = null;
    this.wlist = [];
    this.lzpPos.clear();
    this.lzpFlag.reset();
    this.kindc.clear();
    this.lastKind = 0;
    this.rawT.reset();
  };

  SZGC2.prototype._byte1Row = function (pb) {
    var ft = this.b1c.get(pb);
    if (ft === undefined) {
      var row = this.m.byte1Rows.get(pb);
      ft = row !== undefined
        ? new FT(row[0], row[1], 0, { astep: B_ASTEP })
        : new FT(null, null, 0, { astep: B_ASTEP });
      this.b1c.set(pb, ft);
    }
    return ft;
  };

  SZGC2.prototype._byte1HitFt = function (pb) {
    var ft = this.b1hit.get(pb);
    if (ft === undefined) {
      ft = new FT([0, 1, 2], [W1_O0, W1_ROW, W1_FORCE], 0);
      this.b1hit.set(pb, ft);
    }
    return ft;
  };

  SZGC2.prototype._byteCtxFt = function (order, key) {
    var d = this.bctx[order];
    var ft = d.get(key);
    if (ft === undefined) {
      ft = new FT(null, null, B_ESC, { astep: B_ASTEP, cap: 256 });
      d.set(key, ft);
    }
    return ft;
  };

  SZGC2.prototype._byteTables = function (hist) {
    var h = hist === undefined ? this.bhist : hist;
    var bm = this.byteMode;
    var tabs = [];
    if (bm !== 2) {
      if ((bm === null || bm === 0) && h.length >= 3)
        tabs.push(this._byteCtxFt(3, h[h.length - 3] * 65536 + h[h.length - 2] * 256 + h[h.length - 1]));
      if (h.length >= 2)
        tabs.push(this._byteCtxFt(2, h[h.length - 2] * 256 + h[h.length - 1]));
    }
    return tabs;
  };

  SZGC2.prototype._byteO0Ft = function () {
    if (this._bo0 === null) {
      var bw = this.m.stByte.bw;
      var scaled = new Array(256);
      for (var i = 0; i < 256; i++) scaled[i] = Math.max(1, bw[i] >> 4);
      this._bo0 = new FT(range256(), scaled, 0, { astep: 64, resizeAt: 3000 });
    }
    return this._bo0;
  };

  SZGC2.prototype._termO0 = function () {
    return this.byteMode === null ? this.m.stByte : this._byteO0Ft();
  };

  SZGC2.prototype._encByte = function (enc, b) {
    var excl = new Set();
    var escaped = [];
    var b1Miss = null;
    var done = false;
    var tabs = this._byteTables();
    var i, ft;
    for (i = 0; i < tabs.length; i++) {
      ft = tabs[i];
      if (ft.inTable(b, excl)) {
        var r1 = ft.findEncode(b, excl);
        enc.encode(r1[0], r1[1], r1[2]);
        ft.adapt(b, false);
        done = true;
        break;
      }
      var r0 = ft.findEncode(null, excl);
      enc.encode(r0[0], r0[1], r0[2]);
      escaped.push(ft);
      ft.bs.forEach(function (s) { excl.add(s); });
      ft.delta.forEach(function (dw, s) { excl.add(s); });
    }
    if (!done && this.bhist.length > 0 && this.byteMode === null) {
      var hitT = this._byte1HitFt(this.bhist[this.bhist.length - 1]);
      var row = this._byte1Row(this.bhist[this.bhist.length - 1]);
      var inrow = row.inTable(b, excl) && row.totalExcl(excl) > 0;
      var v;
      if (inrow) {
        var e1 = hitT.findEncode(1);
        var er = row.findEncode(b, excl);
        var e0 = hitT.findEncode(0);
        var eo = this._termO0().findEncode(b, excl);
        var costRow = (bitLength(e1[2]) - bitLength(e1[1])) + (bitLength(er[2]) - bitLength(er[1]));
        var costO0 = (bitLength(e0[2]) - bitLength(e0[1])) + (bitLength(eo[2]) - bitLength(eo[1]));
        v = costRow <= costO0 ? 1 : 0;
      } else {
        v = 2;
      }
      var ev = hitT.findEncode(v);
      enc.encode(ev[0], ev[1], ev[2]);
      hitT.adapt(v, false);
      if (v === 1) {
        var rr = row.findEncode(b, excl);
        enc.encode(rr[0], rr[1], rr[2]);
        row.adapt(b, false);
        done = true;
      } else if (v === 2) {
        b1Miss = row;
      }
    }
    if (!done) {
      var t = this._termO0();
      if (t.totalExcl(excl) === 0) excl = new Set();
      var rt = t.findEncode(b, excl);
      enc.encode(rt[0], rt[1], rt[2]);
      t.adapt(b, false);
      this.m.touched.add(t);
    }
    for (i = 0; i < escaped.length; i++) escaped[i].adapt(null, true, b);
    if (b1Miss !== null) b1Miss.adapt(null, true, b);
    this.bhist.push(b);
  };

  SZGC2.prototype._decByte = function (dec) {
    var excl = new Set();
    var escaped = [];
    var b1Miss = null;
    var sym = null;
    var tabs = this._byteTables();
    var i, ft;
    for (i = 0; i < tabs.length; i++) {
      ft = tabs[i];
      var cum = dec.start(ft.totalExcl(excl));
      var res = ft.decodeSym(cum, excl);
      dec.finish(res[1], res[2]);
      if (res[0] !== null) {
        ft.adapt(res[0], false);
        sym = res[0];
        break;
      }
      escaped.push(ft);
      ft.bs.forEach(function (s) { excl.add(s); });
      ft.delta.forEach(function (dw, s) { excl.add(s); });
    }
    if (sym === null && this.bhist.length > 0 && this.byteMode === null) {
      var hitT = this._byte1HitFt(this.bhist[this.bhist.length - 1]);
      var row = this._byte1Row(this.bhist[this.bhist.length - 1]);
      var cumH = dec.start(hitT.total());
      var resH = hitT.decodeSym(cumH);
      dec.finish(resH[1], resH[2]);
      hitT.adapt(resH[0], false);
      if (resH[0] === 1) {
        var cumR = dec.start(row.totalExcl(excl));
        var resR = row.decodeSym(cumR, excl);
        dec.finish(resR[1], resR[2]);
        row.adapt(resR[0], false);
        sym = resR[0];
      } else if (resH[0] === 2) {
        b1Miss = row;
      }
    }
    if (sym === null) {
      var t = this._termO0();
      if (t.totalExcl(excl) === 0) excl = new Set();
      var cumO = dec.start(t.totalExcl(excl));
      var resO = t.decodeSym(cumO, excl);
      dec.finish(resO[1], resO[2]);
      t.adapt(resO[0], false);
      this.m.touched.add(t);
      sym = resO[0];
    }
    for (i = 0; i < escaped.length; i++) escaped[i].adapt(null, true, sym);
    if (b1Miss !== null) b1Miss.adapt(null, true, sym);
    this.bhist.push(sym);
    return sym;
  };

  SZGC2.prototype._encVarint = function (enc, n) {
    var buf = [];
    putVarint(buf, n);
    for (var i = 0; i < buf.length; i++) this._encByte(enc, buf[i]);
  };

  SZGC2.prototype._decVarint = function (dec) {
    var v = 0, sh = 1;
    for (;;) {
      var b = this._decByte(dec);
      v += (b & 0x7F) * sh;
      if (!(b & 0x80)) return v;
      sh *= 128;
    }
  };

  SZGC2.prototype._encLit = function (enc, data) {
    var i = 0;
    while (i < data.length) {
      var k = data.length - i, chunk, s;
      if (k > 63) { chunk = data.subarray(i, i + 63); s = 62; }
      else if (k === 63) { chunk = data.subarray(i, i + 63); s = 63; }
      else { chunk = data.subarray(i, i + k); s = k - 1; }
      var t = this.m.stLen;
      var r = t.findEncode(s);
      enc.encode(r[0], r[1], r[2]);
      t.adapt(s, false);
      this.m.touched.add(t);
      for (var j = 0; j < chunk.length; j++) this._encByte(enc, chunk[j]);
      i += chunk.length;
    }
  };

  SZGC2.prototype._decLit = function (dec) {
    var out = [];
    for (;;) {
      var t = this.m.stLen;
      var cum = dec.start(t.total());
      var res = t.decodeSym(cum);
      dec.finish(res[1], res[2]);
      t.adapt(res[0], false);
      this.m.touched.add(t);
      var n = res[0] >= 62 ? 63 : res[0] + 1;
      for (var i = 0; i < n; i++) out.push(this._decByte(dec));
      if (res[0] !== 62) return new Uint8Array(out);
    }
  };

  SZGC2.prototype._encCase = function (enc, flag, ctx) {
    var t = this.m.stCase[ctx];
    var r = t.findEncode(flag);
    enc.encode(r[0], r[1], r[2]);
    t.adapt(flag, false);
    this.m.touched.add(t);
  };

  SZGC2.prototype._decCase = function (dec, ctx) {
    var t = this.m.stCase[ctx];
    var cum = dec.start(t.total());
    var res = t.decodeSym(cum);
    dec.finish(res[1], res[2]);
    t.adapt(res[0], false);
    this.m.touched.add(t);
    return res[0];
  };

  // --------------------------------------------- оценки стоимости (выбор пути)
  SZGC2.prototype._estBits = function (acc, cum, freq, tot) {
    if (freq > 0) acc[0] += (bitLength(tot) - bitLength(freq)) * 256;
  };

  SZGC2.prototype._estFt = function (acc, ft, sym, excl) {
    if (ft === null || ft === undefined) return false;
    if (ft.inTable(sym, excl)) {
      var r = ft.findEncode(sym, excl);
      this._estBits(acc, r[0], r[1], r[2]);
      return true;
    }
    var re = ft.findEncode(null, excl);
    this._estBits(acc, re[0], re[1], re[2]);
    if (excl) {
      var self = this;
      ft.bs.forEach(function (s) { excl.add(s); });
      ft.delta.forEach(function (dw, s) { excl.add(s); });
    }
    return false;
  };

  SZGC2.prototype._estByte = function (b, hist) {
    var acc = [0];
    var excl = new Set();
    var hit = false;
    var tabs = this._byteTables(hist);
    for (var i = 0; i < tabs.length; i++) {
      if (this._estFt(acc, tabs[i], b, excl)) { hit = true; break; }
    }
    if (!hit && hist.length > 0) {
      var hitT = this._byte1HitFt(hist[hist.length - 1]);
      var row = this._byte1Row(hist[hist.length - 1]);
      var inrow = row.inTable(b, excl) && row.totalExcl(excl) > 0;
      var t = this._termO0();
      if (t.totalExcl(excl) === 0) excl = new Set();
      var eo = t.findEncode(b, excl);
      var v;
      if (inrow) {
        var er = row.findEncode(b, excl);
        var e1 = hitT.findEncode(1);
        var e0 = hitT.findEncode(0);
        var costRow = (bitLength(e1[2]) - bitLength(e1[1])) + (bitLength(er[2]) - bitLength(er[1]));
        var costO0 = (bitLength(e0[2]) - bitLength(e0[1])) + (bitLength(eo[2]) - bitLength(eo[1]));
        v = costRow <= costO0 ? 1 : 0;
      } else {
        v = 2;
      }
      var ev = hitT.findEncode(v);
      this._estBits(acc, ev[0], ev[1], ev[2]);
      if (v === 1) this._estBits(acc, er[0], er[1], er[2]);
      else this._estBits(acc, eo[0], eo[1], eo[2]);
    } else if (!hit) {
      var t2 = this._termO0();
      if (t2.totalExcl(excl) === 0) excl = new Set();
      var r = t2.findEncode(b, excl);
      this._estBits(acc, r[0], r[1], r[2]);
    }
    return acc[0];
  };

  SZGC2.prototype._estVarint = function (n, hist) {
    var buf = [];
    putVarint(buf, n);
    var acc = 0;
    for (var i = 0; i < buf.length; i++) {
      acc += this._estByte(buf[i], hist);
      hist.push(buf[i]);
    }
    return acc;
  };

  SZGC2.prototype._wordTables = function () {
    var m = this.m;
    var tabs = [];
    var pair = null;
    if (this.w1 !== null && this.w2 !== null) {
      pair = this.w2 * 2097152 + this.w1;      // (w2 << 21) | w1
      var mft = this.match.get(pair);
      if (mft !== undefined) tabs.push([mft, "match"]);
      var b2 = m.b2.get(pair);
      if (b2 !== undefined) tabs.push([b2, "o2"]);
    }
    var prev = this.prev;
    if (prev !== null && prev[0] === "punct") {
      var p = m.puncts[prev[1]];
      if (p === " ") {
        if (this.w1 !== null && m.b1.has(this.w1)) tabs.push([m.b1.get(this.w1), "b1"]);
      } else {
        var c = m.C.get(prev[1]);
        if (c !== undefined) tabs.push([c, "c"]);
      }
    }
    if (this.w1 !== null) {
      var li = m.lemmaIds[this.w1 - m.P];
      var lem = m.lem.get(li);
      if (lem !== undefined) tabs.push([lem, "lem"]);
    }
    return tabs;
  };

  SZGC2.prototype._estChain = function (sym, flag, pred, r) {
    var acc = [0];
    var excl = new Set();
    if (pred !== null) {
      var t = this.lzpFlag;
      var e0 = t.findEncode(0);
      this._estBits(acc, e0[0], e0[1], e0[2]);
      excl.add(pred);
    }
    var tabs = this._wordTables();
    var hit = false;
    for (var i = 0; i < tabs.length; i++) {
      if (this._estFt(acc, tabs[i][0], sym, excl)) { hit = true; break; }
    }
    if (!hit) {
      var o0 = this.m.stO0;
      if (!this._estFt(acc, o0, sym, excl)) {
        var hist = this.bhist.slice();
        this._estVarint(r, hist);
      }
    }
    var t2 = this.m.stCase[this._caseCtx()];
    var ec = t2.findEncode(flag);
    this._estBits(acc, ec[0], ec[1], ec[2]);
    return acc[0];
  };

  SZGC2.prototype._estRaw = function (data) {
    if (data.length === 1) return this._estByte(data[0], this.bhist.slice());
    var acc = [0];
    var hist = this.bhist.slice();
    var i = 0;
    while (i < data.length) {
      var k = data.length - i, chunk, s;
      if (k > 63) { chunk = data.subarray(i, i + 63); s = 62; }
      else if (k === 63) { chunk = data.subarray(i, i + 63); s = 63; }
      else { chunk = data.subarray(i, i + k); s = k - 1; }
      var t = this.m.stLen;
      var r = t.findEncode(s);
      this._estBits(acc, r[0], r[1], r[2]);
      for (var j = 0; j < chunk.length; j++) {
        acc[0] += this._estByte(chunk[j], hist);
        hist.push(chunk[j]);
      }
      i += chunk.length;
    }
    return acc[0];
  };

  SZGC2.prototype._ctxAc = function () {
    var prev = this.prev;
    if (prev === null) return null;
    if (prev[0] === "word") return this.m.A.has(prev[1]) ? this.m.A.get(prev[1]) : null;
    if (prev[0] === "punct") return this.m.C.has(prev[1]) ? this.m.C.get(prev[1]) : null;
    return null;
  };

  SZGC2.prototype._caseCtx = function () {
    var prev = this.prev;
    if (prev === null) return 0;
    if (prev[0] === "punct") {
      var s = this.m.puncts[prev[1]];
      var last = s.length ? s.replace(/\s+$/, "").slice(-1) : "";
      return (last === "." || last === "!" || last === "?" || last === "\u2026") ? 1 : 2;
    }
    return 3;
  };

  SZGC2.prototype._lzpPredicted = function () {
    if (this.w1 === null || this.w2 === null) return null;
    var pair = this.w2 * 2097152 + this.w1;
    var j = this.lzpPos.get(pair);
    if (j === undefined || j >= this.wlist.length) return null;
    return this.wlist[j];
  };

  SZGC2.prototype._lzpRegister = function (sym) {
    if (this.w1 !== null && this.w2 !== null) {
      var pair = this.w2 * 2097152 + this.w1;
      this.lzpPos.set(pair, this.wlist.length);
    }
    this.wlist.push(sym);
  };

  SZGC2.prototype._afterWord = function (sym) {
    if (this.w1 !== null && this.w2 !== null) {
      var pair = this.w2 * 2097152 + this.w1;
      var mft = this.match.get(pair);
      if (mft === undefined) {
        this.match.set(pair, new FT([sym], [W_MATCH], ESC_MATCH));
      } else if (mft.bs.length > 0 && mft.bs[0] === sym) {
        mft.adapt(sym, false);
      } else {
        this.match.set(pair, new FT([sym], [W_MATCH], ESC_MATCH));
      }
    }
    this.w2 = this.w1;
    this.w1 = sym;
    this.prev2 = this.prev;
    this.prev = ["word", sym];
  };

  SZGC2.prototype._kindFt = function () {
    var t = this.kindc.get(this.lastKind);
    if (t === undefined) {
      t = new FT([0, 1, 2, 3, 4], [650, 260, 90, 24, 40], 0);
      this.kindc.set(this.lastKind, t);
    }
    return t;
  };

  SZGC2.prototype._encKind = function (enc, k) {
    var t = this._kindFt();
    var r = t.findEncode(k);
    enc.encode(r[0], r[1], r[2]);
    t.adapt(k, false);
    this.lastKind = k;
  };

  SZGC2.prototype._decKind = function (dec) {
    var t = this._kindFt();
    var cum = dec.start(t.total());
    var res = t.decodeSym(cum);
    dec.finish(res[1], res[2]);
    t.adapt(res[0], false);
    this.lastKind = res[0];
    return res[0];
  };

  SZGC2.prototype._encRawFlag = function (enc, v) {
    var t = this.rawT;
    var r = t.findEncode(v);
    enc.encode(r[0], r[1], r[2]);
    t.adapt(v, false);
  };

  SZGC2.prototype._decRawSym = function (dec) {
    var t = this.rawT;
    var cum = dec.start(t.total());
    var res = t.decodeSym(cum);
    dec.finish(res[1], res[2]);
    t.adapt(res[0], false);
    return res[0];
  };

  SZGC2.prototype._encLzpHit = function (enc) {
    var t = this.lzpFlag;
    var r = t.findEncode(1);
    enc.encode(r[0], r[1], r[2]);
    t.adapt(1, false);
  };

  SZGC2.prototype._encLzpMiss = function (enc) {
    var t = this.lzpFlag;
    var r = t.findEncode(0);
    enc.encode(r[0], r[1], r[2]);
    t.adapt(0, false);
  };

  SZGC2.prototype._decLzp = function (dec) {
    var t = this.lzpFlag;
    var cum = dec.start(t.total());
    var res = t.decodeSym(cum);
    dec.finish(res[1], res[2]);
    t.adapt(res[0], false);
    return res[0] === 1;
  };

  // ------------------------------------------------------------ encode
  SZGC2.prototype.encode = function (text) {
    var bestTag = 2, bestBuf = this._encodeTokens(text);
    for (var mode = 0; mode < 3; mode++) {
      var buf = this._encodeBytes(text, mode);
      if (buf.length < bestBuf.length) { bestTag = 3 + mode; bestBuf = buf; }
    }
    var out = new Uint8Array(bestBuf.length + 1);
    out[0] = bestTag;
    out.set(bestBuf, 1);
    return out;
  };

  SZGC2.prototype._encodeTokens = function (text) {
    var m = this.m;
    this._fresh();
    this.byteMode = null;
    var enc = new RangeEncoder();
    var toks = tokenize(text);
    var punctIdx = new Map();
    for (var pi = 0; pi < m.puncts.length; pi++) punctIdx.set(m.puncts[pi], pi);
    for (var ti = 0; ti < toks.length; ti++) {
      var kind = toks[ti][0], tok = toks[ti][1];
      if (kind === "word") {
        var low = tok.toLowerCase();
        var r = m.rank.has(low) ? m.rank.get(low) : null;
        var flag = getCase(tok);
        var ok = r !== null && flag !== 3 && applyCase(m.words[r], flag) === tok;
        if (ok) {
          this._encKind(enc, 0);
          var sym = m.P + r;
          var pred = this._lzpPredicted();
          var hit = pred !== null && sym === pred;
          if (pred !== null) {
            if (hit) this._encLzpHit(enc);
            else this._encLzpMiss(enc);
          }
          if (hit) {
            this._encCase(enc, flag, this._caseCtx());
            this._lzpRegister(sym);
            this._afterWord(sym);
            var wb = utf8Encode(tok);
            for (var wi = 0; wi < wb.length; wi++) this.bhist.push(wb[wi]);
            continue;
          }
          // выбор: словарная цепочка или сырые байты
          var tb = utf8Encode(tok);
          var useChain = this._estChain(sym, flag, pred, r) <= this._estRaw(tb);
          if (!useChain) {
            // сырые байты; состояние синхронизируется (декодер восстановит sym)
            if (tb.length === 1) {
              this._encRawFlag(enc, 0);
              this._encByte(enc, tb[0]);
            } else {
              this._encRawFlag(enc, 2);
              this._encLit(enc, tb);
            }
            this._lzpRegister(sym);
            this._afterWord(sym);
            continue;
          }
          this._encRawFlag(enc, 1);
          var excl = new Set();
          if (pred !== null) excl.add(pred);
          var escaped = [];
          var done = false;
          var tabs = this._wordTables();
          var i, ft, rr;
          for (i = 0; i < tabs.length; i++) {
            ft = tabs[i][0];
            if (ft.inTable(sym, excl)) {
              rr = ft.findEncode(sym, excl);
              enc.encode(rr[0], rr[1], rr[2]);
              ft.adapt(sym, false);
              this.m.touched.add(ft);
              done = true;
              break;
            }
            rr = ft.findEncode(null, excl);
            enc.encode(rr[0], rr[1], rr[2]);
            escaped.push(ft);
            this.m.touched.add(ft);
            (function (f, ex) {
              f.bs.forEach(function (s) { ex.add(s); });
              f.delta.forEach(function (dw, s) { ex.add(s); });
            })(ft, excl);
          }
          if (!done) {
            var o0 = m.stO0;
            if (o0.inTable(sym, excl)) {
              rr = o0.findEncode(sym, excl);
              enc.encode(rr[0], rr[1], rr[2]);
              o0.adapt(sym);
            } else {
              rr = o0.findEncode(ESC_RANK, excl);
              enc.encode(rr[0], rr[1], rr[2]);
              o0.adapt(ESC_RANK);
              this._encVarint(enc, r);
            }
            this.m.touched.add(o0);
          }
          for (i = 0; i < escaped.length; i++) escaped[i].adapt(null, true, sym);
          this._encCase(enc, flag, this._caseCtx());
          this._lzpRegister(sym);
          this._afterWord(sym);
          for (wi = 0; wi < tb.length; wi++) this.bhist.push(tb[wi]);
        } else {
          var ob = utf8Encode(tok);
          if (ob.length === 1) {
            this._encKind(enc, 2);
            this._encByte(enc, ob[0]);
          } else {
            this._encKind(enc, 4);
            this._encLit(enc, ob);
          }
          this.prev2 = this.prev;
          this.prev = ["lit"];
        }
      } else {  // lit
        var pidx = punctIdx.has(tok) ? punctIdx.get(tok) : null;
        if (pidx !== null) {
          this._encKind(enc, 1);
          var ptb = utf8Encode(tok);
          var useSt = this._estPunct(pidx) <= this._estRaw(ptb);
          if (!useSt) {
            if (ptb.length === 1) {
              this._encRawFlag(enc, 0);
              this._encByte(enc, ptb[0]);
            } else {
              this._encRawFlag(enc, 2);
              this._encLit(enc, ptb);
            }
            this.prev2 = this.prev;
            this.prev = ["punct", pidx];
            continue;
          }
          this._encRawFlag(enc, 1);
          var doneP = false;
          var ftP = this._ctxAc();
          if (ftP !== null) {
            if (ftP.inTable(pidx)) {
              var rp = ftP.findEncode(pidx);
              enc.encode(rp[0], rp[1], rp[2]);
              ftP.adapt(pidx, false);
              doneP = true;
            } else {
              var rp0 = ftP.findEncode(null);
              enc.encode(rp0[0], rp0[1], rp0[2]);
              ftP.adapt(null, false);
            }
            this.m.touched.add(ftP);
          }
          if (!doneP) {
            var o0p = m.stO0;
            var ro = o0p.findEncode(pidx);
            enc.encode(ro[0], ro[1], ro[2]);
            o0p.adapt(pidx);
            this.m.touched.add(o0p);
          }
          this.prev2 = this.prev;
          this.prev = ["punct", pidx];
          for (var pb2 = 0; pb2 < ptb.length; pb2++) this.bhist.push(ptb[pb2]);
        } else {
          var lb = utf8Encode(tok);
          if (lb.length === 1) {
            this._encKind(enc, 2);
            this._encByte(enc, lb[0]);
          } else {
            this._encKind(enc, 4);
            this._encLit(enc, lb);
          }
          this.prev2 = this.prev;
          this.prev = ["lit"];
        }
      }
    }
    this._encKind(enc, 3);      // EOS
    var out = enc.flush();
    return new Uint8Array(out);
  };

  SZGC2.prototype._estPunct = function (pidx) {
    var acc = [0];
    var ft = this._ctxAc();
    var hit = false;
    if (ft !== null) hit = this._estFt(acc, ft, pidx, null);
    if (!hit) {
      var o0 = this.m.stO0;
      var r = o0.findEncode(pidx, null);
      this._estBits(acc, r[0], r[1], r[2]);
    }
    return acc[0];
  };

  SZGC2.prototype._encodeBytes = function (text, mode) {
    this._fresh();
    this.byteMode = mode;
    var enc = new RangeEncoder();
    var data = utf8Encode(text);
    this._encVarint(enc, data.length);
    for (var i = 0; i < data.length; i++) this._encByte(enc, data[i]);
    return new Uint8Array(enc.flush());
  };

  // ------------------------------------------------------------ decode
  SZGC2.prototype.decode = function (data) {
    if (data[0] >= 3 && data[0] <= 5) return this._decodeBytes(data.subarray(1), data[0] - 3);
    if (data[0] !== 2) throw new Error("bad header");
    return this._decodeTokens(data.subarray(1));
  };

  SZGC2.prototype._decodeTokens = function (data) {
    var m = this.m;
    this._fresh();
    this.byteMode = null;
    var dec = new RangeDecoder(data);
    var out = [];
    var punctIdx = new Map();
    for (var pi = 0; pi < m.puncts.length; pi++) punctIdx.set(m.puncts[pi], pi);
    for (;;) {
      if (dec.p > dec.d.length + 16) throw new Error("stream exhausted");
      var k = this._decKind(dec);
      if (k === 3) break;
      if (k === 0) {
        var pred = this._lzpPredicted();
        var excl = new Set();
        var escaped = [];
        var sym = null;
        var hit = false;
        if (pred !== null) {
          hit = this._decLzp(dec);
          if (hit) {
            sym = pred;
            var flag0 = this._decCase(dec, this._caseCtx());
            var w0 = applyCase(m.words[sym - m.P], flag0);
            out.push(w0);
            var hb0 = utf8Encode(w0);
            for (var z0 = 0; z0 < hb0.length; z0++) this.bhist.push(hb0[z0]);
            this._lzpRegister(sym);
            this._afterWord(sym);
            continue;
          }
          excl.add(pred);
        }
        var v = this._decRawSym(dec);
        if (v !== 1) {
          var s0;
          if (v === 0) s0 = utf8Decode(new Uint8Array([this._decByte(dec)]));
          else s0 = utf8Decode(this._decLit(dec));
          out.push(s0);
          var r2 = m.rank.has(s0.toLowerCase()) ? m.rank.get(s0.toLowerCase()) : null;
          if (r2 !== null) {
            var sym2 = m.P + r2;
            this._lzpRegister(sym2);
            this._afterWord(sym2);
          }
          continue;
        }
        var tabs = this._wordTables();
        var i, ft;
        for (i = 0; i < tabs.length; i++) {
          ft = tabs[i][0];
          var cum = dec.start(ft.totalExcl(excl));
          var res = ft.decodeSym(cum, excl);
          dec.finish(res[1], res[2]);
          this.m.touched.add(ft);
          if (res[0] !== null) {
            ft.adapt(res[0], false);
            sym = res[0];
            break;
          }
          escaped.push(ft);
          (function (f, ex) {
            f.bs.forEach(function (s) { ex.add(s); });
            f.delta.forEach(function (dw, s) { ex.add(s); });
          })(ft, excl);
        }
        var r = null;
        if (sym === null) {
          var o0 = m.stO0;
          var cumO = dec.start(o0.totalExcl(excl));
          var resO = o0.decodeSym(cumO, excl);
          dec.finish(resO[1], resO[2]);
          this.m.touched.add(o0);
          if (resO[0] === ESC_RANK) {
            o0.adapt(ESC_RANK);
            r = this._decVarint(dec);
            sym = m.P + r;
          } else {
            o0.adapt(resO[0]);
            sym = resO[0];
          }
        }
        for (i = 0; i < escaped.length; i++) escaped[i].adapt(null, true, sym);
        this._lzpRegister(sym);
        var flag = this._decCase(dec, this._caseCtx());
        var base = r !== null ? m.words[r] : m.words[sym - m.P];
        var w = applyCase(base, flag);
        out.push(w);
        var hb = utf8Encode(w);
        for (var z = 0; z < hb.length; z++) this.bhist.push(hb[z]);
        this._afterWord(sym);
      } else if (k === 1) {
        var v1 = this._decRawSym(dec);
        if (v1 !== 1) {
          var s1;
          if (v1 === 0) s1 = utf8Decode(new Uint8Array([this._decByte(dec)]));
          else s1 = utf8Decode(this._decLit(dec));
          out.push(s1);
          var pidx2 = punctIdx.has(s1) ? punctIdx.get(s1) : null;
          this.prev2 = this.prev;
          this.prev = pidx2 !== null ? ["punct", pidx2] : ["lit"];
          continue;
        }
        var ftP = this._ctxAc();
        var symP = null;
        if (ftP !== null) {
          var cumP = dec.start(ftP.total());
          var resP = ftP.decodeSym(cumP);
          dec.finish(resP[1], resP[2]);
          this.m.touched.add(ftP);
          if (resP[0] !== null) {
            ftP.adapt(resP[0], false);
            symP = resP[0];
          } else {
            ftP.adapt(null, false);
          }
        }
        if (symP === null) {
          var o0p = m.stO0;
          var cumO = dec.start(o0p.total());
          var resO = o0p.decodeSym(cumO);
          dec.finish(resO[1], resO[2]);
          o0p.adapt(resO[0]);
          this.m.touched.add(o0p);
          symP = resO[0];
        }
        out.push(m.puncts[symP]);
        this.prev2 = this.prev;
        this.prev = ["punct", symP];
        var pxb = utf8Encode(m.puncts[symP]);
        for (var z1 = 0; z1 < pxb.length; z1++) this.bhist.push(pxb[z1]);
      } else if (k === 2) {
        var b0 = this._decByte(dec);
        out.push(utf8Decode(new Uint8Array([b0])));
        this.prev2 = this.prev;
        this.prev = ["lit"];
      } else {
        var lit = this._decLit(dec);
        out.push(utf8Decode(lit));
        this.prev2 = this.prev;
        this.prev = ["lit"];
      }
    }
    return out.join("");
  };

  SZGC2.prototype._decodeBytes = function (data, mode) {
    this._fresh();
    this.byteMode = mode;
    var dec = new RangeDecoder(data);
    var n = this._decVarint(dec);
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = this._decByte(dec);
    return utf8Decode(out);
  };

  // ------------------------------------------------------------ API
  var _model = null;

  var internals = {
    bitLength: bitLength,
    putVarint: putVarint,
    RangeEncoder: RangeEncoder,
    RangeDecoder: RangeDecoder,
    FT: FT,
    FenwickO0: FenwickO0,
    Reader: Reader,
    Model: Model,
    SZGC2: SZGC2,
    tokenize: tokenize,
    getCase: getCase,
    applyCase: applyCase,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    ESC_RANK: ESC_RANK,
    ESC_LIT: ESC_LIT
  };

  function loadModel(bytes) {
    _model = new Model(bytes);
    return _model;
  }

  function getModel() {
    if (_model === null) throw new Error("модель не загружена: вызовите loadModel(bytes)");
    return _model;
  }

  function compress(text) {
    return new SZGC2(getModel()).encode(text);
  }

  function decompress(data) {
    return new SZGC2(getModel()).decode(data);
  }

  var api = {
    loadModel: loadModel,
    compress: compress,
    decompress: decompress,
    SZGC2: SZGC2,
    Model: Model,
    internals: internals
  };
  return api;
});
