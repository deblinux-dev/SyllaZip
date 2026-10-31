# -*- coding: utf-8 -*-
"""SZGC ядро: range-кодер, частотные таблицы base+delta, загрузчик модели SZGM.

Состояние: адаптация в течение одного вызова encode/decode накапливается в
delta-слое затронутых таблиц; откат = сброс delta/esc к base (touched-set).
encode и decode всегда стартуют с чистого снимка модели.
"""
import os
import re

M32 = 0xFFFFFFFF
TOP = 1 << 24
ADAPT = 24
RESIZE = 32768
CTX_CAP = 192
ESC_RANK = -1
ESC_LIT = -2
O0_SPLIT = int(os.environ.get("SZGC_O0_SPLIT", "32"))   # контекстный буст языка (0=выкл)
W_MATCH, ESC_MATCH = 4096, 384
PAIR_SHIFT = 21
W_LZP_HIT, W_LZP_MISS = 4096, 128      # флаг попытки LZP (адаптируется)
B_ESC = 12                              # стартовый вес escape байтовых строк
B_ASTEP = 48                            # шаг адаптации байтовых строк
W1_O0, W1_ROW, W1_FORCE = 64, 192, 48    # ternary-флаг order-1 (адаптируется)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "graph-model.bin")

ABSENT = object()

_LAT = frozenset("abcdefghijklmnopqrstuvwxyz")
_CYR = frozenset("абвгдеёжзийклмнопрстуфхцчшщъыьэюя")


def word_lang(w):
    """0=смешанный/прочий, 1=кириллица, 2=латиница (по алфавиту словоформы)."""
    if not w:
        return 0
    s = set(w)
    if s <= _LAT:
        return 2
    if s <= _CYR:
        return 1
    return 0


def apply_case(w, f):
    if f == 0:
        return w
    if f == 1:
        return w[:1].upper() + w[1:]
    return w.upper()


# ------------------------------------------------------------- токенизация
WORD_RE = re.compile(r"[А-Яа-яЁёA-Za-z]+")


def tokenize(text):
    """Единственный токенизатор (зеркалится во всех реализациях кодека):
    чередование word/lit до конца строки."""
    out, pos = [], 0
    for m in WORD_RE.finditer(text):
        if m.start() > pos:
            out.append(("lit", text[pos:m.start()]))
        out.append(("word", m.group()))
        pos = m.end()
    if pos < len(text):
        out.append(("lit", text[pos:]))
    return out


def get_case(w):
    if w.islower():
        return 0
    if w[0].isupper() and (len(w) == 1 or w[1:].islower()):
        return 1
    if len(w) >= 2 and w.isupper():
        return 2
    return 3


# ------------------------------------------------------------- varint io
def put_varint(buf, n):
    v = n & 0xFFFFFFFFFFFFFFFF
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def varint(self):
        v, sh = 0, 0
        while True:
            b = self.d[self.p]
            self.p += 1
            v |= (b & 0x7F) << sh
            sh += 7
            if not (b & 0x80):
                return v

    def blob(self):
        n = self.varint()
        b = self.d[self.p:self.p + n]
        self.p += n
        return b


# ------------------------------------------------------------ range coder
class RangeEncoder:
    """LZMA-стиль: кэш-байт + учёт переносов."""

    def __init__(self):
        self.low = 0
        self.range = 0xFFFFFFFF
        self.cache = 0
        self.cache_size = 1
        self.out = bytearray()

    def _shift_low(self):
        if (self.low & M32) < 0xFF000000 or (self.low >> 32) != 0:
            carry = (self.low >> 32) & 0xFF
            temp = self.cache
            while True:
                self.out.append((temp + carry) & 0xFF)
                temp = 0xFF
                self.cache_size -= 1
                if self.cache_size == 0:
                    break
            self.cache = (self.low >> 24) & 0xFF
        self.cache_size += 1
        self.low = (self.low << 8) & M32

    def encode(self, cum, freq, tot):
        assert freq > 0 and tot > 0 and cum + freq <= tot, (cum, freq, tot)
        r = self.range // tot
        self.low += cum * r
        self.range = freq * r
        while self.range < TOP:
            self._shift_low()
            self.range <<= 8

    def flush(self):
        for _ in range(5):
            self._shift_low()
        assert not self.out or self.out[0] == 0
        return bytes(self.out[1:])


class RangeDecoder:
    """PPMd/7-zip стиль: без low, нормализация вычитанием."""

    def __init__(self, data):
        self.d = data
        self.p = 0
        self.range = 0xFFFFFFFF
        self.code = 0
        for _ in range(4):
            self.code = ((self.code << 8) | self._byte()) & M32
        self.clamped = 0

    def _byte(self):
        b = self.d[self.p] if self.p < len(self.d) else 0
        self.p += 1
        return b

    def start(self, tot):
        self._r = self.range // tot
        cum = self.code // self._r
        if cum >= tot:
            cum = tot - 1
            self.clamped += 1
        return cum

    def finish(self, cum, freq):
        self.code = (self.code - cum * self._r) & M32
        self.range = freq * self._r
        while self.range < TOP:
            self.range <<= 8
            self.code = ((self.code << 8) | self._byte()) & M32


# --------------------------------------------------- таблица частот base+delta
class FT:
    """Частотная таблица: неизменяемая base + адаптивный delta-слой.

    static (o0): веса символов не адаптируются, esc-псевдосимволы живут
    в delta и восстанавливаются при reset().
    astep: шаг адаптации (по умолчанию ADAPT); cap: жёсткий лимит символов
    (для чисто адаптивных байтовых строк нужен 256 вместо формулы CTX_CAP)."""

    __slots__ = ("bs", "bw", "bset", "delta", "esc", "base_esc",
                 "base_sum", "is_o0", "esc0", "_tot", "astep", "cap", "resize_at")

    def __init__(self, syms=None, weights=None, esc=40, is_o0=False, esc0=(0, 0),
                 astep=None, cap=None, resize_at=None):
        self.bs = list(syms) if syms else []
        self.bw = list(weights) if weights else []
        self.bset = set(self.bs)
        self.esc = esc
        self.base_esc = esc
        self.base_sum = sum(self.bw)
        self.is_o0 = is_o0
        self.esc0 = esc0
        self.astep = ADAPT if astep is None else astep
        self.cap = cap
        self.resize_at = RESIZE if resize_at is None else resize_at
        if is_o0:
            self.delta = {ESC_RANK: esc0[0], ESC_LIT: esc0[1]}
            self._tot = self.base_sum + esc0[0] + esc0[1]
        else:
            self.delta = {}
            self._tot = self.base_sum + esc

    def _cap(self):
        return self.cap if self.cap is not None else CTX_CAP + self.base_sum // 16

    def total(self):
        return self._tot

    def total_excl(self, excl):
        """Сумма весов без исключённых символов (для dec.start зеркально enc)."""
        if not excl:
            return self._tot
        lo = 0
        delta = self.delta
        for i in range(len(self.bs)):
            s = self.bs[i]
            if s in excl:
                continue
            lo += self.bw[i] + delta.get(s, 0)
        for s, dw in delta.items():
            if s in self.bset or s in excl:
                continue
            lo += dw
        return lo + self.esc

    def reset(self):
        if self.is_o0:
            self.delta = {ESC_RANK: self.esc0[0], ESC_LIT: self.esc0[1]}
            self.esc = 0
            self._tot = self.base_sum + self.esc0[0] + self.esc0[1]
        else:
            self.delta = {}
            self.esc = self.base_esc
            self._tot = self.base_sum + self.esc

    def in_table(self, sym, excl=None):
        """Есть ли символ в таблице (и не исключён ли он)."""
        if sym in self.bset:
            return not (excl and sym in excl)
        if sym in self.delta and not (excl and sym in excl):
            return True
        return False

    def find_encode(self, sym, excl=None, ctx=0):
        """(cum, freq, tot) с учётом исключений; ESC-интервал, если sym нет."""
        lo = 0
        found = False
        freq = 0
        cum = 0
        delta = self.delta
        bs = self.bs
        bw = self.bw
        for i in range(len(bs)):
            s = bs[i]
            if excl is not None and s in excl:
                continue
            w = bw[i] + delta.get(s, 0)
            if w and s == sym:
                found = True
                freq = w
                cum = lo
            lo += w
        for s, dw in delta.items():
            if s in self.bset or (excl is not None and s in excl):
                continue
            if s == sym:
                found = True
                freq = dw
                cum = lo
            lo += dw
        tot = lo + self.esc
        if found:
            return cum, freq, tot
        return tot - self.esc, self.esc, tot

    def decode_sym(self, cum, excl=None):
        """(sym|None, lo, freq); None = escape."""
        lo = 0
        delta = self.delta
        bs = self.bs
        bw = self.bw
        for i in range(len(bs)):
            s = bs[i]
            if excl is not None and s in excl:
                continue
            w = bw[i] + delta.get(s, 0)
            if cum < lo + w:
                return s, lo, w
            lo += w
        for s, dw in delta.items():
            if s in self.bset or (excl is not None and s in excl):
                continue
            if cum < lo + dw:
                return s, lo, dw
            lo += dw
        return None, lo, self.esc

    def adapt(self, sym, insert=True, insert_sym=None):
        """sym=None -> escape (esc++ и, при insert, вставка insert_sym).
        sym=s -> вес символа +ADAPT (или вставка). Возвращает self."""
        if sym is None:
            if self.esc < 60000:
                self.esc += self.astep
                self._tot += self.astep
            if insert and insert_sym is not None:
                if insert_sym in self.delta:
                    if self.delta[insert_sym] < 60000:
                        self.delta[insert_sym] += self.astep
                        self._tot += self.astep
                elif insert_sym not in self.bset and \
                        len(self.bs) + len(self.delta) < self._cap():
                    self.delta[insert_sym] = self.astep
                    self._tot += self.astep
        elif sym in self.bset:
            old = self.delta.get(sym, 0)
            if old < 60000:
                self.delta[sym] = old + self.astep
                self._tot += self.astep
        else:
            old = self.delta.get(sym)
            if old is None:
                if len(self.bs) + len(self.delta) < self._cap():
                    self.delta[sym] = self.astep
                    self._tot += self.astep
            elif old < 60000:
                self.delta[sym] = old + self.astep
                self._tot += self.astep
        if self._tot >= self.resize_at and not self.is_o0:
            self._resize()
        return self

    def _resize(self):
        nd = {}
        bs = self.bs
        bw = self.bw
        delta = self.delta
        for i in range(len(bs)):
            s = bs[i]
            eff = (bw[i] + delta.get(s, 0)) >> 1
            d = eff - bw[i]
            if d > 0:
                nd[s] = d
        for s, dw in delta.items():
            if s in self.bset:
                continue
            eff = dw >> 1
            if eff > 0:
                nd[s] = eff
        self.delta = nd
        if self.is_o0:
            nd.setdefault(ESC_RANK, 0)
            nd[ESC_RANK] = max(1, nd[ESC_RANK])
            nd[ESC_LIT] = max(1, self.delta.get(ESC_LIT, 0) >> 1)
        self.esc = max(1, self.esc >> 1) if not self.is_o0 else self.esc
        self._tot = self.base_sum + sum(nd.values()) + self.esc


# ------------------------------------------------------------- модель
class FenwickO0:
    """Order-0 таблица (тысячи символов) на дереве Фенвика.

    API совместим с FT для ролей, нужных кодеку: find_encode/decode_sym/
    total/total_excl/in_table/adapt/reset + bset. ESC_RANK/ESC_LIT живут
    вне дерева (два хвостовых интервала).

    Контекстное взвешивание (split): если язык кодируемого символа совпадает
    с языком предыдущего слова (ctx=1 кириллица / 2 латиница / 0 прочее),
    вес символа умножается на split. ESC-интервалы масштабируются так, чтобы
    их вероятность не зависела от контекста. Два доп. дерева Фенвика по
    языкам дают префиксные суммы с множителем за O(log n). Только целые
    числа — байт-в-байт во всех реализациях."""

    __slots__ = ("bs", "bweight", "pos", "bset", "tree", "raw_tot",
                 "esc_rank", "esc_lit", "esc_rank0", "esc_lit0",
                 "extra", "adds", "delta", "lang", "split",
                 "tree_cyr", "tree_lat")

    def __init__(self, syms, weights, esc_rank=0, esc_lit=0, langs=None, split=0):
        self.bs = list(syms)
        self.bweight = list(weights)
        self.pos = {s: i for i, s in enumerate(self.bs)}
        self.bset = set(self.bs)
        n = len(self.bs)
        self.tree = [0] * (n + 1)
        for i, w in enumerate(self.bweight):
            self._tadd(self.tree, i + 1, w)
        self.raw_tot = sum(self.bweight)
        self.esc_rank = esc_rank
        self.esc_lit = esc_lit
        self.esc_rank0 = esc_rank
        self.esc_lit0 = esc_lit
        self.extra = {}
        self.adds = []
        self.delta = {}          # совместимость (не используется)
        self.lang = list(langs) if langs else [0] * n
        self.split = split if (split and len(self.lang) == n) else 0
        self.tree_cyr = [0] * (n + 1)
        self.tree_lat = [0] * (n + 1)
        if self.split:
            for i, lg in enumerate(self.lang):
                if lg == 1:
                    self._tadd(self.tree_cyr, i + 1, self.bweight[i])
                elif lg == 2:
                    self._tadd(self.tree_lat, i + 1, self.bweight[i])

    @staticmethod
    def _tadd(tree, i, v):
        n = len(tree) - 1
        while i <= n:
            tree[i] += v
            i += i & (-i)

    @staticmethod
    def _tpref(tree, i):
        """Сумма весов позиций 1..i (i — 1-based)."""
        s = 0
        while i > 0:
            s += tree[i]
            i -= i & (-i)
        return s

    def _tree_add(self, i, v):
        self._tadd(self.tree, i, v)

    def _prefix(self, i):
        return self._tpref(self.tree, i)

    # --- служебные ---
    def _w_of(self, s):
        return self.bweight[self.pos[s]] + self.extra.get(s, 0)

    def _excl_sorted(self, excl):
        """[(idx, weight)] отсортированно + префиксы."""
        items = sorted((self.pos[s], self._w_of(s)) for s in excl if s in self.pos)
        return items

    def _excl_below(self, items, idx):
        """Сумма исключённых весов с индексом позиции < idx."""
        # items отсортированы по idx; линейный проход (|excl| мал)
        s = 0
        for pi, w in items:
            if pi < idx:
                s += w
            else:
                break
        return s

    def _w(self, s):
        return self.bweight[self.pos[s]] + self.extra.get(s, 0)

    # --- контекстное взвешивание ---
    def _eff(self, ctx):
        """(тело, esc_rank, esc_lit) с множителем языка ctx."""
        if not self.split or ctx == 0:
            return self.raw_tot, self.esc_rank, self.esc_lit
        t = self.tree_cyr if ctx == 1 else self.tree_lat
        body = self.raw_tot + (self.split - 1) * self._tpref(t, len(self.bs))
        k = body // self.raw_tot
        return body, self.esc_rank * k, self.esc_lit * k

    def _we(self, idx, w, ctx):
        """Эффективный вес позиции idx в контексте ctx."""
        if ctx and self.split and self.lang[idx] == ctx:
            return w * self.split
        return w

    def _prefix_eff(self, i, ctx):
        p = self._tpref(self.tree, i)
        if not self.split or ctx == 0:
            return p
        t = self.tree_cyr if ctx == 1 else self.tree_lat
        return p + (self.split - 1) * self._tpref(t, i)

    def _excl_eff_sum(self, items, ctx):
        if not self.split or ctx == 0 or not items:
            return sum(w for _, w in items)
        s = 0
        for idx, w in items:
            s += w * self.split if self.lang[idx] == ctx else w
        return s

    def _excl_eff_below(self, items, idx, ctx):
        """Сумма эффективных весов исключённых с позицией < idx (idx 1-based)."""
        s = 0
        if not self.split or ctx == 0:
            for pi, w in items:
                if pi < idx:
                    s += w
                else:
                    break
            return s
        for pi, w in items:
            if pi < idx:
                s += w * self.split if self.lang[pi] == ctx else w
            else:
                break
        return s

    # --- API ---
    def total(self, ctx=0):
        body, escr, escl = self._eff(ctx)
        return body + escr + escl

    def total_excl(self, excl, ctx=0):
        body, escr, escl = self._eff(ctx)
        if not excl:
            return body + escr + escl
        s = self._excl_eff_sum(self._excl_sorted(excl), ctx)
        return body + escr + escl - s

    def in_table(self, sym, excl=None):
        if sym in self.bset:
            return not (excl and sym in excl)
        return False

    def reset(self):
        for idx, v in self.adds:
            self._tadd(self.tree, idx + 1, -v)
            if self.split:
                lg = self.lang[idx]
                if lg == 1:
                    self._tadd(self.tree_cyr, idx + 1, -v)
                elif lg == 2:
                    self._tadd(self.tree_lat, idx + 1, -v)
            self.raw_tot -= v
        self.adds.clear()
        self.extra.clear()
        self.esc_rank = self.esc_rank0
        self.esc_lit = self.esc_lit0

    def adapt(self, sym, insert=True, insert_sym=None):
        if sym == ESC_RANK:
            self.esc_rank = min(60000, self.esc_rank + ADAPT)
        elif sym == ESC_LIT:
            self.esc_lit = min(60000, self.esc_lit + ADAPT)
        elif sym in self.pos:
            w = self.extra.get(sym, 0)
            if w < 60000:
                idx = self.pos[sym]
                self._tadd(self.tree, idx + 1, ADAPT)
                if self.split:
                    lg = self.lang[idx]
                    if lg == 1:
                        self._tadd(self.tree_cyr, idx + 1, ADAPT)
                    elif lg == 2:
                        self._tadd(self.tree_lat, idx + 1, ADAPT)
                self.raw_tot += ADAPT
                self.adds.append((idx, ADAPT))
                self.extra[sym] = w + ADAPT
        return self

    def find_encode(self, sym, excl=None, ctx=0):
        """(cum, freq, tot); для ESC_RANK/ESC_LIT — хвостовые интервалы."""
        items = self._excl_sorted(excl) if excl else ()
        body, escr, escl = self._eff(ctx)
        base = body - self._excl_eff_sum(items, ctx)
        tot = base + escr + escl
        if sym == ESC_RANK:
            return base, escr, tot
        if sym == ESC_LIT:
            return base + escr, escl, tot
        if sym not in self.pos or (excl and sym in excl):
            # в кодеке не встречается (проверяется in_table/bset заранее);
            # деградируем в ESC-интервал, как линейный FT
            return base, escr, tot
        idx = self.pos[sym]
        w = self._w_of(sym)
        freq = self._we(idx, w, ctx)
        cum = self._prefix_eff(idx, ctx) - self._excl_eff_below(items, idx, ctx)
        return cum, freq, tot

    def decode_sym(self, cum, excl=None, ctx=0):
        """(sym|None, lo, freq); None = escape (ESC_RANK/ESC_LIT как None-
        ветка: возвращаем псевдосимвол)."""
        items = self._excl_sorted(excl) if excl else ()
        body, escr, escl = self._eff(ctx)
        base_tot = body - self._excl_eff_sum(items, ctx)
        if cum >= base_tot:
            if cum < base_tot + escr:
                return ESC_RANK, base_tot, escr
            return ESC_LIT, base_tot + escr, escl
        # бинарный поиск позиции: adj_prefix(p) > cum,
        # adj_prefix(p) = сумма весов позиций 0..p минус исключённые 0..p
        lo, hi = 0, len(self.bs) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            ap = self._prefix_eff(mid + 1, ctx) - self._excl_eff_below(items, mid + 1, ctx)
            if ap > cum:
                hi = mid
            else:
                lo = mid + 1
        idx = lo
        s = self.bs[idx]
        w = self._w_of(s)
        freq = self._we(idx, w, ctx)
        lo_cum = self._prefix_eff(idx, ctx) - self._excl_eff_below(items, idx, ctx)
        return s, lo_cum, freq


class Model:
    def __init__(self, path=MODEL_PATH):
        with open(path, "rb") as f:
            data = f.read()
        assert data[:4] == b"SZGM" and data[4] == 2, "bad model (нужен SZGM)"
        r = Reader(data)
        r.p = 5
        self.D = r.varint()
        self.P = r.varint()
        self.L = r.varint()
        self.O0_TOP = r.varint()
        self.B1_ROWS = r.varint()
        self.B2_ROWS = r.varint()
        self.LEM_ROWS = r.varint()
        self.puncts = [r.blob().decode("utf-8") for _ in range(self.P)]
        self.words = [r.blob().decode("utf-8") for _ in range(self.D)]
        self.rank = {w: i for i, w in enumerate(self.words)}
        self.word_lang = [word_lang(w) for w in self.words]
        self.lemma_ids = [r.varint() for _ in range(self.D)]
        n0 = r.varint()
        syms, ws = [], []
        for _ in range(n0):
            syms.append(r.varint())
            ws.append(r.varint())
        esc_rank = r.varint()
        esc_lit = r.varint()
        o0_langs = [0 if s < self.P else self.word_lang[s - self.P] for s in syms]
        self.st_o0 = FenwickO0(syms, ws, esc_rank, esc_lit, o0_langs, O0_SPLIT)
        self.b1 = self._rows(r)
        self.b2 = self._rows(r)
        self.lem = self._rows(r)
        self.A = self._rows(r)
        self.C = self._rows(r)
        bw = [r.varint() for _ in range(256)]
        self.st_byte = FT(list(range(256)), bw, 0, astep=64, resize_at=10000)
        self.byte1_rows = {}
        for _ in range(r.varint()):
            pbi = r.varint()
            k = r.varint()
            syms, ws = [], []
            for _ in range(k):
                syms.append(r.varint())
                ws.append(r.varint())
            self.byte1_rows[pbi] = (syms, ws)
        self.st_case = []
        for _ in range(4):
            row = [r.varint() for _ in range(3)]
            self.st_case.append(FT([0, 1, 2], row, 0))
        lw = [r.varint() for _ in range(64)]
        self.st_len = FT(list(range(64)), lw, 0, astep=96)

    @staticmethod
    def _rows(r):
        d = {}
        for _ in range(r.varint()):
            k = r.varint()
            n = r.varint()
            syms, ws = [], []
            for _ in range(n):
                syms.append(r.varint())
                ws.append(r.varint())
            d[k] = FT(syms, ws, 40)
        return d
