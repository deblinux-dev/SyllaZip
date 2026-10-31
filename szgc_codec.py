# -*- coding: utf-8 -*-
"""
SZGC — морфографовый предиктивный кодек (SyllaZip Graph Coder).

Поток: [kind-флаг: слово|punct|литерал] для каждого токена.
  слово : MATCH -> O2 (биграмма w2,w1) -> B1 (w1->слово, gap " ") -> C (после punct)
          -> LEM (лемма w1: согласование) -> O0 -> ESC_RANK (varint-ранг)
  punct : A (слово->punct) / C (после punct) -> O0
  литерал: escape контекста -> чанки len-модели -> байты (order-1 по потоку вывода)

PPMC-семантика: escape из таблицы -> её символы исключаются (exclusions) из
младших порядков; вес escape и вставка символа применяются ПОСЛЕ того, как
символ стал известен
"""
import glob
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from szgc_core import (ADAPT, B_ASTEP, B_ESC, CTX_CAP, ESC_LIT,
                        ESC_RANK, FT, M32, MODEL_PATH, Model, PAIR_SHIFT,
                        RangeDecoder, RangeEncoder, TOP, W1_O0, W1_ROW,
                        W1_FORCE, W_MATCH, ESC_MATCH, W_LZP_HIT, W_LZP_MISS,
                        apply_case, get_case, put_varint, tokenize)

_FMT_TAG = 2        # формат-тег потока (первый байт)


class SZGC2:
    def __init__(self, model):
        self.m = model
        if not hasattr(model, "touched"):
            model.touched = set()     # общее для всех инстансов: мутирует общая модель
        self.match = {}
        self.b1c = {}                 # order-1 строки: prev_byte -> FT (esc=0)
        self.b1hit = {}               # order-1 ternary-флаги: prev_byte -> FT
        self.bctx = {}                # order -> {ключ-байты: FT} (чисто адаптивные)
        self.bhist = []               # история байт выходного потока (контексты order-1..3)
        self.byte_mode = None         # None: токенный; 0/1/2: байтовый (глубина)
        self._bo0 = None              # масштабированная o0 для байтовых режимов
        self.kindc = {}               # kind-таблицы по предыдущему kind (биграммы)
        self.last_kind = 0
        self.prev = None              # ("word", sym) | ("punct", idx) | ("lit",)
        self.prev2 = None
        self.w1 = None                # последний sym слова
        self.w2 = None                # предпоследний sym слова
        self.wlist = []               # история sym-ов слов (для LZP)
        self.lzp_pos = {}             # pair -> индекс прошлого продолжения в wlist
        self.lzp_flag = FT([1, 0], [W_LZP_HIT, W_LZP_MISS], 0)
        self.raw_t = FT([0, 1, 2], [64, 96, 40], 0)
        # 0=сырой 1 байт 1=структурный 2=сырой прогон

    # ------------------------------------------------------------ state
    def _fresh(self):
        for ft in self.m.touched:
            ft.reset()
        self.m.touched.clear()
        self.match.clear()
        self.b1c.clear()
        self.b1hit.clear()
        self.bctx.clear()
        self.bhist = []
        if self._bo0 is not None:
            self._bo0.reset()
        self.prev = self.prev2 = None
        self.w1 = self.w2 = None
        self.wlist = []
        self.lzp_pos = {}
        self.lzp_flag.reset()
        self.kindc.clear()
        self.last_kind = 0
        self.raw_t.reset()

    @staticmethod
    def _t(ft):
        return ft

    def _byte1_row(self, pb):
        """Статическая строка order-1 без escape (esc=0); hit решается отдельным битом."""
        ft = self.b1c.get(pb)
        if ft is None:
            row = self.m.byte1_rows.get(pb)
            if row is not None:
                ft = FT(row[0], row[1], 0, astep=B_ASTEP)
            else:
                ft = FT(None, None, 0, astep=B_ASTEP)
            self.b1c[pb] = ft
        return ft

    def _byte1_hit_ft(self, pb):
        """Адаптивный ternary-флаг order-1: 0=мимо строки в o0, 1=строка, 2=строка не знает."""
        ft = self.b1hit.get(pb)
        if ft is None:
            ft = FT([0, 1, 2], [W1_O0, W1_ROW, W1_FORCE], 0)
            self.b1hit[pb] = ft
        return ft

    def _byte_ctx_ft(self, order, key):
        """Чисто адаптивная строка контекста order-2/3 (создаётся на лету)."""
        d = self.bctx.setdefault(order, {})
        ft = d.get(key)
        if ft is None:
            ft = FT(None, None, B_ESC, astep=B_ASTEP, cap=256)
            d[key] = ft
        return ft

    def _byte_tables(self, hist=None):
        """Цепочка чисто адаптивных байтовых контекстов; глубина по режиму:
        None/0 — order-3 -> order-2; 1 — order-2; 2 — без цепочки.
        order-1 (только токенный режим) обрабатывается отдельно, терминал — st_byte.
        hist=None — рабочая история; иначе оценка на копии (без мутаций)."""
        h = self.bhist if hist is None else hist
        bm = self.byte_mode
        tabs = []
        if bm != 2:
            if (bm is None or bm == 0) and len(h) >= 3:
                tabs.append(self._byte_ctx_ft(3, (h[-3], h[-2], h[-1])))
            if len(h) >= 2:
                tabs.append(self._byte_ctx_ft(2, (h[-2], h[-1])))
        return tabs

    def _byte_o0_ft(self):
        """o0 для байтовых режимов: base>>4 (слабый приор ~6 псевдосчётов),
        быстрая адаптация — алфавит мусора выучивается за цикл."""
        ft = self._bo0
        if ft is None:
            bw = [max(1, w >> 4) for w in self.m.st_byte.bw]
            ft = FT(list(range(256)), bw, 0, astep=64, resize_at=3000)
            self._bo0 = ft
        return ft

    def _term_o0(self):
        """Терминальная o0: статическая в токенном режиме, масштабированная в байтовых."""
        return self.m.st_byte if self.byte_mode is None else self._byte_o0_ft()

    def _enc_byte(self, enc, b):
        excl = set()
        escaped = []
        b1_miss = [None]
        done = False
        for ft in self._byte_tables():
            if ft.in_table(b, excl):
                cum, freq, tot = ft.find_encode(b, excl)
                enc.encode(cum, freq, tot)
                ft.adapt(b, insert=False)
                done = True
                break
            cum, freq, tot = ft.find_encode(None, excl)
            enc.encode(cum, freq, tot)
            escaped.append(ft)
            excl.update(ft.bs)
            excl.update(ft.delta.keys())
        if not done and self.bhist and self.byte_mode is None:
            # order-1: ternary-флаг + строка без escape; выбор строка/o0
            hit_t = self._byte1_hit_ft(self.bhist[-1])
            row = self._byte1_row(self.bhist[-1])
            inrow = row.in_table(b, excl) and row.total_excl(excl) > 0
            if inrow:
                # сравнение: строка (флаг 1 + sym) против o0 (флаг 0 + sym)
                c1, f1, t1 = hit_t.find_encode(1)
                cr, fr, tr = row.find_encode(b, excl)
                c0, f0, t0 = hit_t.find_encode(0)
                co, fo, to = self._term_o0().find_encode(b, excl)
                cost_row = ((t1.bit_length() - f1.bit_length()) +
                            (tr.bit_length() - fr.bit_length()))
                cost_o0 = ((t0.bit_length() - f0.bit_length()) +
                           (to.bit_length() - fo.bit_length()))
                v = 1 if cost_row <= cost_o0 else 0
            else:
                v = 2
            cum, freq, tot = hit_t.find_encode(v)
            enc.encode(cum, freq, tot)
            hit_t.adapt(v, insert=False)
            if v == 1:
                cum, freq, tot = row.find_encode(b, excl)
                enc.encode(cum, freq, tot)
                row.adapt(b, insert=False)
                done = True
            else:
                if v == 2:
                    b1_miss[0] = row
        if not done:
            t = self._term_o0()
            if not t.total_excl(excl):
                excl = set()          # все 256 исключены — терминал без исключений
            cum, freq, tot = t.find_encode(b, excl)
            enc.encode(cum, freq, tot)
            t.adapt(b, insert=False)
            self.m.touched.add(t)
        for ft in escaped:
            ft.adapt(None, insert=True, insert_sym=b)
        if b1_miss[0] is not None:
            b1_miss[0].adapt(None, insert=True, insert_sym=b)
        self.bhist.append(b)

    def _dec_byte(self, dec):
        excl = set()
        escaped = []
        b1_miss = [None]
        sym = None
        for ft in self._byte_tables():
            cum = dec.start(ft.total_excl(excl))
            s, lo, freq = ft.decode_sym(cum, excl)
            dec.finish(lo, freq)
            if s is not None:
                ft.adapt(s, insert=False)
                sym = s
                break
            escaped.append(ft)
            excl.update(ft.bs)
            excl.update(ft.delta.keys())
        if sym is None and self.bhist and self.byte_mode is None:
            hit_t = self._byte1_hit_ft(self.bhist[-1])
            row = self._byte1_row(self.bhist[-1])
            cum = dec.start(hit_t.total())
            v, lo, freq = hit_t.decode_sym(cum)
            dec.finish(lo, freq)
            hit_t.adapt(v, insert=False)
            if v == 1:
                cum = dec.start(row.total_excl(excl))
                s2, lo, freq = row.decode_sym(cum, excl)
                dec.finish(lo, freq)
                row.adapt(s2, insert=False)
                sym = s2
            elif v == 2:
                b1_miss[0] = row
        if sym is None:
            t = self._term_o0()
            if not t.total_excl(excl):
                excl = set()
            cum = dec.start(t.total_excl(excl))
            s, lo, freq = t.decode_sym(cum, excl)
            dec.finish(lo, freq)
            t.adapt(s, insert=False)
            self.m.touched.add(t)
            sym = s
        for ft in escaped:
            ft.adapt(None, insert=True, insert_sym=sym)
        if b1_miss[0] is not None:
            b1_miss[0].adapt(None, insert=True, insert_sym=sym)
        self.bhist.append(sym)
        return sym

    # ------------------------------------------------- контекст punct/lit
    def _ctx_ac(self):
        """Таблица A/C для punct-прогноза и escape литералов (v1-семантика)."""
        prev = self.prev
        if prev is None:
            return None
        if prev[0] == "word":
            return self.m.A.get(prev[1])
        if prev[0] == "punct":
            return self.m.C.get(prev[1])
        return None

    def _case_ctx(self):
        prev = self.prev
        if prev is None:
            return 0
        if prev[0] == "punct":
            s = self.m.puncts[prev[1]]
            return 1 if (s and s.rstrip()[-1:] in (".", "!", "?", "…")) else 2
        return 3

    def _enc_varint(self, enc, n):
        buf = bytearray()
        put_varint(buf, n)
        for b in buf:
            self._enc_byte(enc, b)

    def _dec_varint(self, dec):
        v, sh = 0, 0
        while True:
            b = self._dec_byte(dec)
            v |= (b & 0x7F) << sh
            sh += 7
            if not (b & 0x80):
                return v

    def _enc_lit(self, enc, data):
        i = 0
        while i < len(data):
            k = len(data) - i
            if k > 63:
                chunk, s = data[i:i + 63], 62
            elif k == 63:
                chunk, s = data[i:i + 63], 63
            else:
                chunk, s = data[i:i + k], k - 1
            t = self.m.st_len
            cum, freq, tot = t.find_encode(s)
            enc.encode(cum, freq, tot)
            t.adapt(s, insert=False)
            self.m.touched.add(t)
            for b in chunk:
                self._enc_byte(enc, b)
            i += len(chunk)

    def _dec_lit(self, dec):
        out = bytearray()
        while True:
            t = self.m.st_len
            cum = dec.start(t.total())
            s, lo, freq = t.decode_sym(cum)
            dec.finish(lo, freq)
            t.adapt(s, insert=False)
            self.m.touched.add(t)
            n = 63 if s >= 62 else s + 1
            for _ in range(n):
                out.append(self._dec_byte(dec))
            if s != 62:
                return bytes(out)

    def _enc_case(self, enc, flag, ctx):
        t = self.m.st_case[ctx]
        cum, freq, tot = t.find_encode(flag)
        enc.encode(cum, freq, tot)
        t.adapt(flag, insert=False)
        self.m.touched.add(t)

    def _dec_case(self, dec, ctx):
        t = self.m.st_case[ctx]
        cum = dec.start(t.total())
        s, lo, freq = t.decode_sym(cum)
        dec.finish(lo, freq)
        t.adapt(s, insert=False)
        self.m.touched.add(t)
        return s

    # --------------------------------------------- оценки стоимости (выбор пути)
    # Стоимость шага кодера в 1/256 бита: bit_length(tot)-bit_length(freq).

    def _est_bits(self, acc, cum, freq, tot):
        if freq > 0:
            acc[0] += (tot.bit_length() - freq.bit_length()) * 256

    def _est_ft(self, acc, ft, sym, excl, ctx=0):
        """Оценка кодирования sym в ft; False = escape (excl пополняется)."""
        if ft is None:
            return False
        if ft.in_table(sym, excl):
            cum, freq, tot = ft.find_encode(sym, excl, ctx)
            self._est_bits(acc, cum, freq, tot)
            return True
        cum, freq, tot = ft.find_encode(None, excl, ctx)
        self._est_bits(acc, cum, freq, tot)
        if excl is not None:
            excl.update(ft.bs)
            excl.update(ft.delta.keys())
        return False

    def _est_byte(self, b, hist):
        """Оценка стоимости байта: o3 -> o2 -> o1(hit-бит) -> st_byte.
        hist — локальная копия истории"""
        acc = [0]
        excl = set()
        hit = False
        for ft in self._byte_tables(hist):
            if self._est_ft(acc, ft, b, excl):
                hit = True
                break
        if not hit and hist:
            hit_t = self._byte1_hit_ft(hist[-1])
            row = self._byte1_row(hist[-1])
            inrow = row.in_table(b, excl) and row.total_excl(excl) > 0
            t = self._term_o0()
            if not t.total_excl(excl):
                excl = set()
            co, fo, to = t.find_encode(b, excl)
            if inrow:
                cr, fr, tr = row.find_encode(b, excl)
                c1, f1, t1 = hit_t.find_encode(1)
                c0, f0, t0 = hit_t.find_encode(0)
                cost_row = ((t1.bit_length() - f1.bit_length()) +
                            (tr.bit_length() - fr.bit_length()))
                cost_o0 = ((t0.bit_length() - f0.bit_length()) +
                           (to.bit_length() - fo.bit_length()))
                v = 1 if cost_row <= cost_o0 else 0
            else:
                v = 2
            cv, fv, tv = hit_t.find_encode(v)
            self._est_bits(acc, cv, fv, tv)
            if v == 1:
                self._est_bits(acc, cr, fr, tr)
            else:
                self._est_bits(acc, co, fo, to)
        elif not hit:
            t = self._term_o0()
            if not t.total_excl(excl):
                excl = set()
            cum, freq, tot = t.find_encode(b, excl)
            self._est_bits(acc, cum, freq, tot)
        return acc[0]

    def _est_varint(self, n, hist):
        buf = bytearray()
        put_varint(buf, n)
        acc = 0
        for b in buf:
            acc += self._est_byte(b, hist)
            hist.append(b)
        return acc

    def _est_chain(self, sym, flag, pred, r):
        """Оценка словарной цепочки для слова (escape-каскад + case)."""
        acc = [0]
        excl = set()
        ctx = self._o0_ctx()
        if pred is not None:
            t = self.lzp_flag
            cum, freq, tot = t.find_encode(0)
            self._est_bits(acc, cum, freq, tot)
            excl.add(pred)
        hit = False
        for ft, tag in self._word_tables():
            if self._est_ft(acc, ft, sym, excl, ctx):
                hit = True
                break
        if not hit:
            o0 = self.m.st_o0
            if not self._est_ft(acc, o0, sym, excl, ctx):
                self._est_varint(r, list(self.bhist))
        t = self.m.st_case[self._case_ctx()]
        cum, freq, tot = t.find_encode(flag)
        self._est_bits(acc, cum, freq, tot)
        return acc[0]

    def _est_raw(self, data):
        """Оценка сырого литерала; одиночный байт кодируется без st_len."""
        if len(data) == 1:
            return self._est_byte(data[0], list(self.bhist))
        acc = [0]
        hist = list(self.bhist)
        i = 0
        while i < len(data):
            k = len(data) - i
            if k > 63:
                chunk, s = data[i:i + 63], 62
            elif k == 63:
                chunk, s = data[i:i + 63], 63
            else:
                chunk, s = data[i:i + k], k - 1
            t = self.m.st_len
            cum, freq, tot = t.find_encode(s)
            self._est_bits(acc, cum, freq, tot)
            for b in chunk:
                acc[0] += self._est_byte(b, hist)
                hist.append(b)
            i += len(chunk)
        return acc[0]

    def _est_punct(self, pidx):
        """Оценка структурного punct-пути (A/C при попадании, иначе O0)."""
        acc = [0]
        ft = self._ctx_ac()
        hit = False
        if ft is not None:
            hit = self._est_ft(acc, ft, pidx, None)
        if not hit:
            o0 = self.m.st_o0
            cum, freq, tot = o0.find_encode(pidx, None)
            self._est_bits(acc, cum, freq, tot)
        return acc[0]

    # ------------------------------------------------------- word chain
    def _o0_ctx(self):
        """Язык предыдущего слова: 1 кириллица / 2 латиница / 0 прочее."""
        if self.w1 is None:
            return 0
        return self.m.word_lang[self.w1 - self.m.P]

    def _word_tables(self):
        """Упорядоченный список (ft, tag) попыток для слова."""
        m = self.m
        tabs = []
        pair = None
        if self.w1 is not None and self.w2 is not None:
            pair = (self.w2 << PAIR_SHIFT) | self.w1
            mft = self.match.get(pair)
            if mft is not None:
                tabs.append((mft, "match"))
            ft = m.b2.get(pair)
            if ft is not None:
                tabs.append((ft, "o2"))
        prev = self.prev
        if prev is not None and prev[0] == "punct":
            p = m.puncts[prev[1]]
            if p == " ":
                if self.w1 in m.b1:
                    tabs.append((m.b1[self.w1], "b1"))
            else:
                ft = m.C.get(prev[1])
                if ft is not None:
                    tabs.append((ft, "c"))
        if self.w1 is not None:
            li = m.lemma_ids[self.w1 - m.P]
            ft = m.lem.get(li)
            if ft is not None:
                tabs.append((ft, "lem"))
        return tabs

    def _lzp_predicted(self):
        """Предсказанный sym по паре (w2,w1) из истории, либо None."""
        if self.w1 is None or self.w2 is None:
            return None
        pair = (self.w2 << PAIR_SHIFT) | self.w1
        j = self.lzp_pos.get(pair)
        if j is None or j >= len(self.wlist):
            return None
        return self.wlist[j]

    def _lzp_register(self, sym):
        """Регистрация текущей позиции в LZP-памяти (вызывается для каждого слова)."""
        if self.w1 is not None and self.w2 is not None:
            pair = (self.w2 << PAIR_SHIFT) | self.w1
            self.lzp_pos[pair] = len(self.wlist)
        self.wlist.append(sym)

    def _enc_lzp_hit(self, enc):
        t = self.lzp_flag
        cum, freq, tot = t.find_encode(1)
        enc.encode(cum, freq, tot)
        t.adapt(1, insert=False)

    def _enc_lzp_miss(self, enc):
        t = self.lzp_flag
        cum, freq, tot = t.find_encode(0)
        enc.encode(cum, freq, tot)
        t.adapt(0, insert=False)

    def _dec_lzp(self, dec):
        t = self.lzp_flag
        cum = dec.start(t.total())
        s, lo, freq = t.decode_sym(cum)
        dec.finish(lo, freq)
        t.adapt(s, insert=False)
        return s == 1

    def _after_word(self, sym):
        """Обновление match-памяти и состояния (общее для enc/dec)."""
        if self.w1 is not None and self.w2 is not None:
            pair = (self.w2 << PAIR_SHIFT) | self.w1
            mft = self.match.get(pair)
            if mft is None:
                self.match[pair] = FT([sym], [W_MATCH], ESC_MATCH)
            elif mft.bs and mft.bs[0] == sym:
                mft.adapt(sym, insert=False)
            else:
                self.match[pair] = FT([sym], [W_MATCH], ESC_MATCH)
        self.w2, self.w1 = self.w1, sym
        self.prev2, self.prev = self.prev, ("word", sym)

    # ------------------------------------------------------------ encode
    def encode(self, text):
        """Конверт: токенный (0x02) или байтовый (0x03/0x04/0x05 — глубина цепочки
        o3+o2+o0 / o2+o0 / o0). Кодируем всеми, отдаём меньший; режим — по тегу."""
        best_tag, best_buf = 2, self._encode_tokens(text)
        for mode in (0, 1, 2):
            buf = self._encode_bytes(text, mode)
            if len(buf) < len(best_buf):
                best_tag, best_buf = 3 + mode, buf
        return bytes([best_tag]) + best_buf

    def _encode_tokens(self, text):
        m = self.m
        self._fresh()
        self.byte_mode = None
        enc = RangeEncoder()
        toks = tokenize(text)
        punct_idx = {p: i for i, p in enumerate(m.puncts)}
        for kind, tok in toks:
            if kind == "word":
                low = tok.lower()
                r = m.rank.get(low)
                flag = get_case(tok)
                ok = r is not None and flag != 3 and apply_case(m.words[r], flag) == tok
                if ok:
                    self._enc_kind(enc, 0)
                    sym = m.P + r
                    pred = self._lzp_predicted()
                    hit = pred is not None and sym == pred
                    if pred is not None:
                        if hit:
                            self._enc_lzp_hit(enc)
                        else:
                            self._enc_lzp_miss(enc)
                    if hit:
                        self._enc_case(enc, flag, self._case_ctx())
                        self._lzp_register(sym)
                        self._after_word(sym)
                        self.bhist.extend(tok.encode("utf-8"))
                        continue
                    # выбор: словарная цепочка или сырые байты
                    tb = tok.encode("utf-8")
                    use_chain = self._est_chain(sym, flag, pred, r) <= self._est_raw(tb)
                    if not use_chain:
                        # сырые байты; состояние синхронизируется (декодер восстановит sym)
                        if len(tb) == 1:
                            self._enc_raw_flag(enc, 0)
                            self._enc_byte(enc, tb[0])
                        else:
                            self._enc_raw_flag(enc, 2)
                            self._enc_lit(enc, tb)
                        self._lzp_register(sym)
                        self._after_word(sym)
                        continue
                    self._enc_raw_flag(enc, 1)
                    excl = set()
                    if pred is not None:
                        excl.add(pred)      # LZP-промах: предсказанное исключается
                    escaped = []
                    done = False
                    for ft, tag in self._word_tables():
                        if ft.in_table(sym, excl):
                            cum, freq, tot = ft.find_encode(sym, excl)
                            enc.encode(cum, freq, tot)
                            ft.adapt(sym, insert=False)
                            self.m.touched.add(ft)
                            done = True
                            break
                        cum, freq, tot = ft.find_encode(None, excl)
                        enc.encode(cum, freq, tot)
                        escaped.append(ft)
                        self.m.touched.add(ft)
                        excl.update(ft.bs)
                        excl.update(ft.delta.keys())
                    if not done:
                        o0 = m.st_o0
                        ctx = self._o0_ctx()
                        if sym in o0.bset and sym not in excl:
                            cum, freq, tot = o0.find_encode(sym, excl, ctx)
                            enc.encode(cum, freq, tot)
                            o0.adapt(sym, insert=False)
                        else:
                            cum, freq, tot = o0.find_encode(ESC_RANK, excl, ctx)
                            enc.encode(cum, freq, tot)
                            o0.adapt(ESC_RANK, insert=False)
                            self._enc_varint(enc, r)
                        self.m.touched.add(o0)
                    for ft in escaped:
                        ft.adapt(None, insert=True, insert_sym=sym)
                    self._enc_case(enc, flag, self._case_ctx())
                    self._lzp_register(sym)
                    self._after_word(sym)
                    self.bhist.extend(tok.encode("utf-8"))
                else:
                    tb = tok.encode("utf-8")
                    if len(tb) == 1:
                        self._enc_kind(enc, 2)
                        self._enc_byte(enc, tb[0])
                    else:
                        self._enc_kind(enc, 4)
                        self._enc_lit(enc, tb)
                    self.prev2, self.prev = self.prev, ("lit",)
            elif kind == "lit":
                pidx = punct_idx.get(tok)
                if pidx is not None:
                    self._enc_kind(enc, 1)
                    tb = tok.encode("utf-8")
                    use_st = self._est_punct(pidx) <= self._est_raw(tb)
                    if not use_st:
                        if len(tb) == 1:
                            self._enc_raw_flag(enc, 0)
                            self._enc_byte(enc, tb[0])
                        else:
                            self._enc_raw_flag(enc, 2)
                            self._enc_lit(enc, tb)
                        self.prev2, self.prev = self.prev, ("punct", pidx)
                        continue
                    self._enc_raw_flag(enc, 1)
                    done = False
                    ft = self._ctx_ac()
                    if ft is not None:
                        if ft.in_table(pidx):
                            cum, freq, tot = ft.find_encode(pidx)
                            enc.encode(cum, freq, tot)
                            ft.adapt(pidx, insert=False)
                            done = True
                        else:
                            cum, freq, tot = ft.find_encode(None)
                            enc.encode(cum, freq, tot)
                            ft.adapt(None, insert=False)
                        self.m.touched.add(ft)
                    if not done:
                        o0 = m.st_o0
                        cum, freq, tot = o0.find_encode(pidx)
                        enc.encode(cum, freq, tot)
                        o0.adapt(pidx, insert=False)
                        self.m.touched.add(o0)
                    self.prev2, self.prev = self.prev, ("punct", pidx)
                    self.bhist.extend(tok.encode("utf-8"))
                else:
                    tb = tok.encode("utf-8")
                    if len(tb) == 1:
                        self._enc_kind(enc, 2)
                        self._enc_byte(enc, tb[0])
                    else:
                        self._enc_kind(enc, 4)
                        self._enc_lit(enc, tb)
                    self.prev2, self.prev = self.prev, ("lit",)
        self._enc_kind(enc, 3)      # EOS
        return enc.flush()

    def _encode_bytes(self, text, mode):
        """Чисто байтовый режим глубины mode: varint-длина + поток байт."""
        self._fresh()
        self.byte_mode = mode
        enc = RangeEncoder()
        data = text.encode("utf-8")
        self._enc_varint(enc, len(data))
        for b in data:
            self._enc_byte(enc, b)
        return enc.flush()

    def _enc_raw_flag(self, enc, v):
        t = self.raw_t
        cum, freq, tot = t.find_encode(v)
        enc.encode(cum, freq, tot)
        t.adapt(v, insert=False)

    def _enc_kind(self, enc, k):
        t = self._kind_ft()
        cum, freq, tot = t.find_encode(k)
        enc.encode(cum, freq, tot)
        t.adapt(k, insert=False)
        self.last_kind = k

    def _kind_ft(self):
        t = self.kindc.get(self.last_kind)
        if t is None:
            t = FT([0, 1, 2, 3, 4], [650, 260, 90, 24, 40], 0)
            self.kindc[self.last_kind] = t
        return t

    # ------------------------------------------------------------ decode
    def decode(self, data):
        if 3 <= data[0] <= 5:
            return self._decode_bytes(data[1:], data[0] - 3)
        assert data[0] == _FMT_TAG, "bad header"
        m = self.m
        self._fresh()
        self.byte_mode = None
        dec = RangeDecoder(data[1:])
        out = []
        punct_idx = {p: i for i, p in enumerate(m.puncts)}
        while True:
            if dec.p > len(dec.d) + 16:
                raise ValueError("stream exhausted (рассинхронизация)")
            k = self._dec_kind(dec)
            if k == 3:
                break
            if k == 0:
                pred = self._lzp_predicted()
                excl = set()
                escaped = []
                sym = None
                hit = False
                if pred is not None:
                    hit = self._dec_lzp(dec)
                    if hit:
                        sym = pred           # попадание LZP: цепочка не нужна
                        flag = self._dec_case(dec, self._case_ctx())
                        w = apply_case(m.words[sym - m.P], flag)
                        out.append(w)
                        self.bhist.extend(w.encode("utf-8"))
                        self._lzp_register(sym)
                        self._after_word(sym)
                        continue
                    excl.add(pred)
                v = self._dec_raw_sym(dec)
                if v != 1:
                    if v == 0:                     # одиночный байт
                        s = bytes([self._dec_byte(dec)]).decode("utf-8")
                    else:                          # прогон (v == 2)
                        s = self._dec_lit(dec).decode("utf-8")
                    out.append(s)
                    # синхронизация состояния: декодер восстановит sym из словаря
                    r2 = m.rank.get(s.lower())
                    if r2 is not None:
                        sym2 = m.P + r2
                        self._lzp_register(sym2)
                        self._after_word(sym2)
                    continue
                for ft, tag in self._word_tables():
                    cum = dec.start(ft.total_excl(excl))
                    s, lo, freq = ft.decode_sym(cum, excl)
                    dec.finish(lo, freq)
                    self.m.touched.add(ft)
                    if s is not None:
                        ft.adapt(s, insert=False)
                        sym = s
                        break
                    escaped.append(ft)
                    excl.update(ft.bs)
                    excl.update(ft.delta.keys())
                r = None
                if sym is None:
                    o0 = m.st_o0
                    ctx = self._o0_ctx()
                    cum = dec.start(o0.total_excl(excl, ctx))
                    s, lo, freq = o0.decode_sym(cum, excl, ctx)
                    dec.finish(lo, freq)
                    self.m.touched.add(o0)
                    if s == ESC_RANK:
                        o0.adapt(ESC_RANK, insert=False)
                        r = self._dec_varint(dec)
                        sym = m.P + r
                    else:
                        o0.adapt(s, insert=False)
                        sym = s
                for ft in escaped:
                    ft.adapt(None, insert=True, insert_sym=sym)
                self._lzp_register(sym)
                if r is not None:
                    flag = self._dec_case(dec, self._case_ctx())
                    w = apply_case(m.words[r], flag)
                    out.append(w)
                    self.bhist.extend(w.encode("utf-8"))
                else:
                    w = m.words[sym - m.P]
                    flag = self._dec_case(dec, self._case_ctx())
                    w = apply_case(w, flag)
                    out.append(w)
                    self.bhist.extend(w.encode("utf-8"))
                self._after_word(sym)
            elif k == 1:
                v = self._dec_raw_sym(dec)
                if v != 1:
                    if v == 0:
                        s = bytes([self._dec_byte(dec)]).decode("utf-8")
                    else:
                        s = self._dec_lit(dec).decode("utf-8")
                    out.append(s)
                    pidx2 = punct_idx.get(s)
                    if pidx2 is not None:
                        self.prev2, self.prev = self.prev, ("punct", pidx2)
                    else:
                        self.prev2, self.prev = self.prev, ("lit",)
                    continue
                ft = self._ctx_ac()
                sym = None
                if ft is not None:
                    cum = dec.start(ft.total())
                    s, lo, freq = ft.decode_sym(cum)
                    dec.finish(lo, freq)
                    self.m.touched.add(ft)
                    if s is not None:
                        ft.adapt(s, insert=False)
                        sym = s
                    else:
                        ft.adapt(None, insert=False)
                if sym is None:
                    o0 = m.st_o0
                    cum = dec.start(o0.total())
                    s, lo, freq = o0.decode_sym(cum)
                    dec.finish(lo, freq)
                    o0.adapt(s, insert=False)
                    self.m.touched.add(o0)
                    sym = s
                out.append(m.puncts[sym])
                self.prev2, self.prev = self.prev, ("punct", sym)
                self.bhist.extend(m.puncts[sym].encode("utf-8"))
            elif k == 2:
                b = self._dec_byte(dec)          # одиночный байт литерала (ASCII)
                out.append(bytes([b]).decode("utf-8"))
                self.prev2, self.prev = self.prev, ("lit",)
            else:
                lit = self._dec_lit(dec)
                out.append(lit.decode("utf-8"))
                self.prev2, self.prev = self.prev, ("lit",)
        return "".join(out)

    def _decode_bytes(self, data, mode):
        """Чисто байтовый режим глубины mode: varint-длина + поток байт."""
        self._fresh()
        self.byte_mode = mode
        dec = RangeDecoder(data)
        n = self._dec_varint(dec)
        out = bytearray()
        for _ in range(n):
            out.append(self._dec_byte(dec))
        return out.decode("utf-8")

    def _dec_raw_sym(self, dec):
        """Значение флага пути: 0=сырой 1 байт, 1=структурный, 2=сырой прогон."""
        t = self.raw_t
        cum = dec.start(t.total())
        s, lo, freq = t.decode_sym(cum)
        dec.finish(lo, freq)
        t.adapt(s, insert=False)
        return s

    def _dec_raw_flag(self, dec):
        t = self.raw_t
        cum = dec.start(t.total())
        s, lo, freq = t.decode_sym(cum)
        dec.finish(lo, freq)
        t.adapt(s, insert=False)
        return s == 1

    def _dec_kind(self, dec):
        t = self._kind_ft()
        cum = dec.start(t.total())
        s, lo, freq = t.decode_sym(cum)
        dec.finish(lo, freq)
        t.adapt(s, insert=False)
        self.last_kind = s
        return s


# ------------------------------------------------------------- API
_MODEL = None


def get_model():
    global _MODEL
    if _MODEL is None:
        _MODEL = Model(MODEL_PATH)
    return _MODEL


def compress(text):
    return SZGC2(get_model()).encode(text)


def decompress(data):
    return SZGC2(get_model()).decode(data)


# -------------------------------------------------------------
def selftest():
    ok = 0
    texts = []
    for p in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                            "data", "corpus", "wiki_00.txt"))):
        with open(p, encoding="utf-8") as f:
            first = f.read(6000)
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size // 2))
            mid = f.read(6000)
        texts += [first, mid]
    texts += [
        "Привет! Как дела?",
        "Спасибо большое, выручил!",
        "Не забудь купить хлеб и молоко.",
        "Ок, до связи!",
        "",
        " ",
        "Я",
        "ЁЖик и ёлка, APPLE iPhone 15 Про \U0001f600",
        "Числа: 12345 и 67890, дата 2026-10-26.",
        "СМЕШАННЫЙ ЁЖ и Крош",
        "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
        "Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.",
    ]
    rnd = random.Random(20261026)
    alphabets = [
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя ",
        "abc XYZ .,!?\n",
        "😀😃🌍中文日本語",
        "ёЁ ёлка ЁЛКА",
        "\x00\x01\x02\xff",
    ]
    for _ in range(200):
        a = rnd.choice(alphabets)
        nn = rnd.randint(0, 120)
        texts.append("".join(rnd.choice(a) for _ in range(nn)))
    fails = []
    t0 = time.time()
    for i, t in enumerate(texts):
        try:
            c = compress(t)
            d = decompress(c)
        except Exception as e:
            fails.append((i, "EXC %r" % e, t[:60]))
            continue
        if d != t:
            fails.append((i, len(t), t[:60]))
        else:
            ok += 1
        c2 = compress(t)
        if c2 != c:
            fails.append((i, -1, "NONDET " + t[:40]))
        if i % 40 == 0:
            print("  ... %d/%d (%.1fs)" % (i, len(texts), time.time() - t0), flush=True)
    print("round-trip: %d/%d OK (%.1fs)" % (ok, len(texts), time.time() - t0))
    if fails:
        for f in fails[:10]:
            print("FAIL:", f)
        sys.exit(1)
    print("детерминизм кодировщика: OK")
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    selftest()
