# -*- coding: utf-8 -*-
"""
SZGC: сборка графовой модели сжатия SZGM.

Три потоковых прохода по корпусу (память ~1 ГБ, корпус до 800 МБ):
  P1: униграммы слов + byte0/byte1 статистики
      -> словарь D словоформ (blended: OpenSubtitles ru/en + корпус), леммы pymorphy3
  P2: биграммные пары (w2,w1) -> топ-B2_ROWS контекстов 2-го порядка
  P3: контексты (зеркало кодека): B1 (слово->слово), B2-продолжения,
      LEM (лемма->слово, согласование), A (слово->пунктуация), C (после punct),
      case/len статистики.

Модель SZGM: формат v2.
Выход: download/syllazip/graph-model.bin (+ stats json).
"""
import glob
import json
import os
import pickle
import re
import sys
import time
from collections import Counter, defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from szgc_core import get_case, tokenize

BASE = os.environ.get("SZGC_BASE", os.path.dirname(os.path.abspath(__file__)))
CORP = os.path.join(BASE, "data/corpus")
OUT = os.path.join(BASE, "download/syllazip/graph-model.bin")
STATS = os.path.join(BASE, "download/syllazip/model-stats.json")
FREQ_RU = os.path.join(BASE, "scripts/ru_50k.txt")
FREQ_EN = os.path.join(BASE, "scripts/en_50k.txt")

def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# ---- модельные ёмкости ----
PUNCT_TOP = 48
O0_TOP = _env_int("SZGC_O0_TOP", 131072)
DICT_CAP = _env_int("SZGC_DICT_CAP", 600000)
CTX_B1_ROWS = _env_int("SZGC_B1_ROWS", 65536)
B2_ROWS = _env_int("SZGC_B2_ROWS", 65536)
LEM_ROWS = _env_int("SZGC_LEM_ROWS", 16384)
A_ROWS = _env_int("SZGC_A_ROWS", 16384)
B1_KEEP, B2_KEEP, LEM_KEEP, A_KEEP, C_KEEP = 14, 9, 12, 4, 8
B1_MIN_CNT, B2_MIN_CNT, LEM_MIN_CNT, A_MIN_CNT = 40, 20, 30, 40
TOTAL_CAP = 3_000_000_000   # корпус до ~3 ГБ (RU+EN)
PAIR_SUBSAMPLE = 2          # брать каждую 2-ю пару (по счётчику)
ROW_TARGET = 1500           # суммарный вес статической строки контекста

# ---- английский контур: строки добавляются СВЕРХ русских квот ----
# (0 отключает соответствующую ручку; дефолты включены)
B2_EN_ADD = _env_int("SZGC_B2_EN_ADD", 32768)     # доп. en-en пары B2 сверх топа
B2_EN_MIN = _env_int("SZGC_B2_EN_MIN", 4)         # минимальный счёт доп. пары
B1_EN_ADD = _env_int("SZGC_B1_EN_ADD", 16384)     # доп. EN-слова в B1 сверх топа
A_EN_ADD = _env_int("SZGC_A_EN_ADD", 8192)        # доп. EN-слова в A сверх топа
LEM_EN_OFF = _env_int("SZGC_LEM_EN_OFF", 2)       # 2=убрать латинские леммы без дозаполнения, 1=с дозаполнением, 0=выкл
B1_KEEP_EN = _env_int("SZGC_B1_KEEP_EN", 32)      # глубина EN-строк B1
B2_KEEP_EN = _env_int("SZGC_B2_KEEP_EN", 16)      # глубина EN-строк B2
OUT = os.environ.get("SZGC_OUT", OUT)
STATS = os.environ.get("SZGC_STATS", STATS)

_LAT_W = re.compile(r"^[a-z]+$")


def is_latin(w):
    return _LAT_W.match(w) is not None


def read_freq_lists():
    ru, en = {}, {}
    for path, dst in ((FREQ_RU, ru), (FREQ_EN, en)):
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= 50000:
                    break
                parts = line.strip().split(" ")
                if not parts or not parts[0]:
                    continue
                w = parts[0].strip().lower().replace("ё", "е").replace("Ё", "Е")
                n = int(parts[1].split()[0]) if len(parts) > 1 and parts[1].split()[0].isdigit() else 1
                if w:
                    dst[w] = dst.get(w, 0) + n
    return ru, en


def corpus_files():
    total, kept = 0, []
    for p in sorted(glob.glob(os.path.join(CORP, "*.txt"))):
        s = os.path.getsize(p)
        if total + s > TOTAL_CAP:
            break
        kept.append(p)
        total += s
    return kept, total


def iter_text(path, chunk=8 << 20):
    """Потоковое чтение файла кусками с безопасными границами (по \\n).
    Кусок без \\n накапливается. Статистический шум на ~75 стыках/файл."""
    with open(path, encoding="utf-8", errors="replace") as f:
        tail = ""
        while True:
            piece = f.read(chunk)
            if not piece:
                if tail:
                    yield tail
                return
            piece = tail + piece
            cut = piece.rfind("\n")
            if cut == -1:
                tail = piece
                continue
            tail = piece[cut:]
            yield piece[:cut]


def scale_weights(raw, target=ROW_TARGET):
    """Масштабирование весов: сумма ~target, предел 60000."""
    s = sum(raw.values())
    if s == 0 or target <= 0:
        return {}
    out = {}
    for k, v in raw.items():
        out[k] = max(1, min(60000, round(v * target / s)))
    budget = 2 * target + 64
    total = sum(out.values())
    if total > budget:
        # слишком много символов: сохраняем самых частых, редкие вылетают в ESC
        items = sorted(out.items(), key=lambda kv: (-kv[1], kv[0]))
        keep = {}
        acc = 0
        for k, w in items:
            if acc + w > budget and w == 1:
                break
            if acc + w > budget:
                out[k] = max(1, budget - acc)
                acc = budget
                break
            keep[k] = w
            acc += w
        if len(keep) < len(out):
            keep.update({k: out[k] for k in list(out)[len(keep):] if k in keep})
            out = keep
    return out


def varint(n):
    v = n & 0xFFFFFFFFFFFFFFFF
    bs = []
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            bs.append(b | 0x80)
        else:
            bs.append(b)
            return bytes(bs)


def build_puncts_from(counter_of_lits):
    ranked = [p for p, _ in counter_of_lits.most_common(PUNCT_TOP)]
    if " " not in ranked:
        ranked.insert(0, " ")
        ranked = ranked[:PUNCT_TOP]
    return ranked


# ============================================================== PASS 1
def pass1(files):
    t0 = time.time()
    cnt = Counter()
    byte0 = Counter()
    byte1 = [Counter() for _ in range(256)]
    lit_counter = Counter()
    prev_b = -1
    for fi, p in enumerate(files):
        for text in iter_text(p):
            for kind, tok in tokenize(text):
                if kind == "word":
                    cnt[tok.lower()] += 1
                    b = tok.encode("utf-8")
                    # байты слов участвуют в byte1-контексте (зеркалит поток вывода)
                    for x in b:
                        byte0[x] += 1
                        if prev_b >= 0:
                            byte1[prev_b][x] += 1
                        prev_b = x
                else:
                    if len(tok.encode("utf-8")) <= 16:
                        lit_counter[tok] += 1
                    lb = tok.encode("utf-8")
                    for x in lb:
                        byte0[x] += 1
                        if prev_b >= 0:
                            byte1[prev_b][x] += 1
                        prev_b = x
        if len(cnt) > 4_000_000:
            cnt = Counter({w: c for w, c in cnt.items() if c >= 2})
        print("  P1 %d/%d %s: слов-форм %d (%.0fs)" %
              (fi + 1, len(files), os.path.basename(p)[:24], len(cnt), time.time() - t0), flush=True)
    return cnt, byte0, byte1, lit_counter


def build_dictionary(cnt, ru_freq, en_freq):
    """Ранг словоформы -> sym. Blended-скор: частотники + корпус."""
    words = set(ru_freq) | set(en_freq)
    words.update(cnt.keys())
    latin = re.compile(r"^[a-z]+$")

    def score(w):
        s = cnt.get(w, 0) * 8 + (1 if cnt.get(w) else 0)
        s += ru_freq.get(w, 0)
        if latin.match(w):
            s += en_freq.get(w, 0)
        else:
            s += ru_freq.get(w.replace("ё", "е"), 0) if "ё" in w else 0
        return s

    ranked = sorted(words, key=lambda w: (-score(w), w))[:DICT_CAP]
    return ranked


def build_lemmas(ranked):
    """word -> lemma_idx; лемма-таблица только по словарю."""
    from pymorphy3 import MorphAnalyzer
    morph = MorphAnalyzer()
    latin = re.compile(r"^[a-z]+$")
    lemma_idx_of = {}
    lemma_ids = []
    lemmas = {}
    t0 = time.time()
    for i, w in enumerate(ranked):
        if w in lemma_idx_of:
            lemma_ids.append(lemma_idx_of[w])
            continue
        if latin.match(w):
            lem = w
        else:
            try:
                lem = morph.parse(w)[0].normal_form
            except Exception:
                lem = w
        if lem not in lemmas:
            lemmas[lem] = len(lemmas)
        lemma_idx_of[w] = lemmas[lem]
        lemma_ids.append(lemmas[lem])
        if i % 100000 == 0 and i:
            print("  леммы %d/%d (%.0fs)" % (i, len(ranked), time.time() - t0), flush=True)
    return lemma_ids, len(lemmas)


# ============================================================== PASS 2
def pass2(files, word_cnt, rank_of, P, lang_by_rank=None):
    """Пары (w2,w1) SYM-ов слов (как в кодеке); parity-субсэмпл."""
    t0 = time.time()
    buf = np.empty(1 << 23, dtype=np.int64)
    chunks = []
    bi = 0
    w1 = w2 = None
    gcnt = 0
    for p in files:
        for text in iter_text(p):
            for kind, tok in tokenize(text):
                if kind != "word":
                    continue
                low = tok.lower()
                r = rank_of.get(low, -1)
                if r >= 0 and w1 is not None and w2 is not None:
                    c1 = word_cnt.get(low, 0)
                    # фильтр частотности текущего слова (порог по униграммам)
                    if c1 >= B2_MIN_CNT:
                        if gcnt % PAIR_SUBSAMPLE == 0:
                            if bi >= buf.shape[0]:
                                chunks.append(buf[:bi])
                                buf = np.empty(1 << 23, dtype=np.int64)
                                bi = 0
                            buf[bi] = (w2 << 21) | w1
                            bi += 1
                if r >= 0:
                    w2, w1 = w1, P + r  # внесловарные слова не сбрасывают контекст
                gcnt += 1
        print("  P2 %s (%.0fs, пар %d)" % (os.path.basename(p)[:24], time.time() - t0, bi), flush=True)
    if bi:
        chunks.append(buf[:bi])
    del buf
    if not chunks:
        return set()
    allp = np.concatenate(chunks)
    del chunks
    uniq, counts = np.unique(allp, return_counts=True)
    del allp
    order = np.argsort(-counts, kind="stable")[:B2_ROWS]
    pairs = set(int(uniq[i]) for i in order)
    print("  P2: уникальных пар %d, отобрано %d (порог счёта >= %d)" %
          (len(uniq), len(pairs), int(counts[order[-1]]) if len(order) else 0), flush=True)
    # аддитивные en-en пары: сверх топа, русские строки не затрагиваются
    if B2_EN_ADD and lang_by_rank is not None:
        w1s = (uniq & ((1 << 21) - 1)).astype(np.int64)
        w2s = (uniq >> 21).astype(np.int64)
        en1 = lang_by_rank[w1s - P] == 2
        en2 = lang_by_rank[w2s - P] == 2
        cand = np.nonzero(en1 & en2 & (counts >= B2_EN_MIN))[0]
        top = set(int(x) for x in uniq[order])
        cand = np.array([i for i in cand if int(uniq[i]) not in top], dtype=np.int64)
        if len(cand) > B2_EN_ADD:
            # сортировка: счёт по убыванию, при равенстве — меньший ключ пары
            cand = cand[np.lexsort((uniq[cand], -counts[cand]))[:B2_EN_ADD]]
        added = set(int(uniq[i]) for i in cand)
        pairs |= added
        print("  P2: доп. en-en пар %d (счёт >= %d)" % (len(added), B2_EN_MIN), flush=True)
    return pairs


# ============================================================== PASS 3
def pass3(files, rank_of, puncts, pairs, b1_ctx, lem_ctx, lemma_ids, P):
    """Все контекстные счётчики (зеркало состояния кодека)."""
    t0 = time.time()
    b2 = defaultdict(Counter)
    b1 = defaultdict(Counter)
    lem = defaultdict(Counter)
    A = defaultdict(Counter)
    C = defaultdict(Counter)
    case_cnt = [[0, 0, 0] for _ in range(4)]
    len_cnt = Counter()
    lit_cnt = Counter()
    punct_set = set(puncts)
    punct_idx = {p: i for i, p in enumerate(puncts)}
    prev = None                  # ("word", sym) | ("punct", idx) | ("lit",)
    w1 = w2 = None               # последние два sym слов (через файлы и куски)

    for p in files:
        for text in iter_text(p):
            for kind, tok in tokenize(text):
                if kind == "word":
                    low = tok.lower()
                    r = rank_of.get(low)
                    flag = get_case(tok)
                    if r is not None and flag != 3:
                        sym = P + r
                        # --- прогноз этого слова доступными контекстами ---
                        if w1 is not None and w2 is not None:
                            pr = (w2 << 21) | w1
                            if pr in pairs:
                                b2[pr][sym] += 1
                        if w1 is not None:
                            li = lemma_ids[w1 - P]
                            if li in lem_ctx:
                                lem[li][sym] += 1
                            if prev is not None and prev[0] == "punct":
                                if puncts[prev[1]] == " ":
                                    if w1 in b1_ctx:
                                        b1[w1][sym] += 1
                                else:
                                    C[prev[1]][sym] += 1
                        # --- регистр ---
                        cctx = 0
                        if prev is None:
                            cctx = 0
                        elif prev[0] == "punct":
                            s = puncts[prev[1]]
                            cctx = 1 if (s and s.rstrip()[-1:] in (".", "!", "?", "…")) else 2
                        else:
                            cctx = 3
                        case_cnt[cctx][flag] += 1
                        w2, w1 = w1, sym
                        prev = ("word", sym)
                    else:
                        # слово вне словаря -> литеральный прогон
                        lit_cnt[tok.encode("utf-8")] += 1
                        lb = tok.encode("utf-8")
                        i = 0
                        while i < len(lb):
                            k = len(lb) - i
                            ln = 63 if k > 63 else k
                            len_cnt[min(ln, 63)] += 1
                            i += ln
                        prev = ("lit",)
                        # w1/w2 НЕ сбрасываем (зеркало кодека)
                else:
                    if tok in punct_set:
                        pidx = punct_idx[tok]
                        if prev is not None and prev[0] == "word":
                            # A: пунктуация после слова
                            if w1 is not None:
                                A[w1][pidx] += 1
                        elif prev is not None and prev[0] == "punct":
                            C[prev[1]][pidx] += 1
                        prev = ("punct", pidx)
                    else:
                        lit_cnt[tok.encode("utf-8")] += 1
                        lb = tok.encode("utf-8")
                        i = 0
                        while i < len(lb):
                            k = len(lb) - i
                            ln = 63 if k > 63 else k
                            len_cnt[min(ln, 63)] += 1
                            i += ln
                        prev = ("lit",)
        print("  P3 %s (%.0fs)" % (os.path.basename(p)[:24], time.time() - t0), flush=True)

    return b2, b1, lem, A, C, case_cnt, len_cnt, lit_cnt


STAGE_DIR = os.path.join(BASE, "data/stage2")


def stage1():
    """P1: униграммы + байты + лит-токены."""
    os.makedirs(STAGE_DIR, exist_ok=True)
    t00 = time.time()
    files, total_bytes = corpus_files()
    print("файлов: %d, корпус: %.1f МБ" % (len(files), total_bytes / 1048576))
    cnt, byte0, byte1, lit_counter = pass1(files)
    with open(os.path.join(STAGE_DIR, "stage1.pkl"), "wb") as f:
        pickle.dump({"cnt": cnt, "byte0": byte0, "byte1": byte1,
                     "lit_counter": lit_counter, "total_bytes": total_bytes},
                    f, protocol=4)
    print("stage1 OK (%.0fs): словоформ %d" % (time.time() - t00, len(cnt)))


def stage2():
    """Словарь + леммы + puncts + контекстные множества."""
    os.makedirs(STAGE_DIR, exist_ok=True)
    t00 = time.time()
    with open(os.path.join(STAGE_DIR, "stage1.pkl"), "rb") as f:
        s1 = pickle.load(f)
    cnt, byte0, byte1, lit_counter = s1["cnt"], s1["byte0"], s1["byte1"], s1["lit_counter"]
    ru_freq, en_freq = read_freq_lists()
    ranked = build_dictionary(cnt, ru_freq, en_freq)
    D = len(ranked)
    rank_of = {w: i for i, w in enumerate(ranked)}
    puncts = build_puncts_from(lit_counter)
    P = len(puncts)
    print("словарь D=%d, puncts P=%d" % (D, P))
    lemma_ids, L = build_lemmas(ranked)
    print("лемм L=%d (%.0fs)" % (L, time.time() - t00))
    lemma_agg = Counter()
    latin_lem = set()
    for i, li in enumerate(lemma_ids):
        lemma_agg[li] += cnt.get(ranked[i], 0)
        if is_latin(ranked[i]):
            latin_lem.add(li)
    if LEM_EN_OFF == 2:
        # убрать латинские леммы без дозаполнения: русский набор строк
        # в точности как в смешанном топе, глубокие леммы не подмешиваются
        cand = [li for li, c in lemma_agg.items() if c >= LEM_MIN_CNT]
        sel = sorted(cand, key=lambda x: (-lemma_agg[x], x))[:LEM_ROWS]
        lem_ctx = set(li for li in sel if li not in latin_lem)
    else:
        if LEM_EN_OFF:
            for li in list(lemma_agg):
                if li in latin_lem:
                    del lemma_agg[li]
        lem_ctx = set(li for li, c in lemma_agg.items() if c >= LEM_MIN_CNT)
        lem_ctx = set(sorted(lem_ctx, key=lambda x: -lemma_agg[x])[:LEM_ROWS])
    freq_words = [(w, c) for w, c in cnt.items() if c >= B1_MIN_CNT]
    freq_words.sort(key=lambda t: (-t[1], t[0]))
    b1_ctx = set(P + rank_of[w] for w, _ in freq_words[:CTX_B1_ROWS] if w in rank_of)
    a_ctx = set(P + rank_of[w] for w, _ in freq_words[:A_ROWS] if w in rank_of)
    # аддитивные EN-контексты: сверх топа, русские строки не затрагиваются
    if B1_EN_ADD:
        add = [w for w, _ in freq_words[CTX_B1_ROWS:] if is_latin(w)][:B1_EN_ADD]
        b1_ctx |= set(P + rank_of[w] for w in add if w in rank_of)
    if A_EN_ADD:
        add = [w for w, _ in freq_words[A_ROWS:] if is_latin(w)][:A_EN_ADD]
        a_ctx |= set(P + rank_of[w] for w in add if w in rank_of)
    print("контекстов: b1=%d lem=%d a=%d" % (len(b1_ctx), len(lem_ctx), len(a_ctx)))
    with open(os.path.join(STAGE_DIR, "stage2.pkl"), "wb") as f:
        pickle.dump({"ranked": ranked, "puncts": puncts, "lemma_ids": lemma_ids,
                     "L": L, "lem_ctx": lem_ctx, "b1_ctx": b1_ctx,
                     "a_ctx": a_ctx, "byte0": byte0, "byte1": byte1}, f, protocol=4)
    print("stage2 OK (%.0fs)" % (time.time() - t00))


def stage3():
    """P2: отбор биграммных контекстов."""
    t00 = time.time()
    with open(os.path.join(STAGE_DIR, "stage2.pkl"), "rb") as f:
        s2 = pickle.load(f)
    ranked = s2["ranked"]
    rank_of = {w: i for i, w in enumerate(ranked)}
    with open(os.path.join(STAGE_DIR, "stage1.pkl"), "rb") as f:
        cnt = pickle.load(f)["cnt"]
    files, _ = corpus_files()
    with open(os.path.join(STAGE_DIR, "stage2.pkl"), "rb") as f:
        P = len(pickle.load(f)["puncts"])
    lang_by_rank = np.array([2 if is_latin(w) else 0 for w in ranked], dtype=np.int8)
    pairs = pass2(files, cnt, rank_of, P, lang_by_rank)
    import numpy as _np
    arr = _np.array(sorted(pairs), dtype=_np.int64)
    _np.save(os.path.join(STAGE_DIR, "pairs.npy"), arr)
    print("stage3 OK (%.0fs): пар %d" % (time.time() - t00, len(pairs)))


def stage4():
    """P3 + упаковка модели SZGM."""
    t00 = time.time()
    with open(os.path.join(STAGE_DIR, "stage2.pkl"), "rb") as f:
        s2 = pickle.load(f)
    ranked, puncts = s2["ranked"], s2["puncts"]
    lemma_ids, L = s2["lemma_ids"], s2["L"]
    lem_ctx, b1_ctx, a_ctx = s2["lem_ctx"], s2["b1_ctx"], s2["a_ctx"]
    byte0, byte1 = s2["byte0"], s2["byte1"]
    rank_of = {w: i for i, w in enumerate(ranked)}
    D = len(ranked)
    P = len(puncts)
    import numpy as _np
    pairs = set(int(x) for x in _np.load(os.path.join(STAGE_DIR, "pairs.npy")))
    files, total_bytes = corpus_files()
    print("== P3: контексты ==")
    b2, b1, lem, A, C, case_cnt, len_cnt, lit_cnt = pass3(
        files, rank_of, puncts, pairs, b1_ctx, lem_ctx, lemma_ids, P)
    with open(os.path.join(STAGE_DIR, "stage1.pkl"), "rb") as f:
        cnt = pickle.load(f)["cnt"]
    ru_freq, en_freq = read_freq_lists()
    pack_model(cnt, ru_freq, ranked, puncts, lemma_ids, L, lem_ctx, b1_ctx, a_ctx,
               pairs, b2, b1, lem, A, C, case_cnt, len_cnt, byte0, byte1,
               total_bytes, len(files), t00, en_freq=en_freq)


def pack_model(cnt, ru_freq, ranked, puncts, lemma_ids, L, lem_ctx, b1_ctx, a_ctx,
               pairs, b2, b1, lem, A, C, case_cnt, len_cnt, byte0, byte1,
               total_bytes, nfiles, t00, en_freq=None):
    D = len(ranked)
    P = len(puncts)
    rank_of = {w: i for i, w in enumerate(ranked)}
    latin_rank = set(i for i, w in enumerate(ranked) if is_latin(w))
    print("== упаковка модели ==")
    out = bytearray()
    out += b"SZGM"
    out.append(2)
    wv = lambda n: out.extend(varint(n))
    wv(D); wv(P); wv(L); wv(O0_TOP); wv(CTX_B1_ROWS); wv(B2_ROWS); wv(LEM_ROWS)
    for p in puncts:
        b = p.encode("utf-8")
        wv(len(b)); out += b
    for w in ranked:
        b = w.encode("utf-8")
        wv(len(b)); out += b
    for li in lemma_ids:
        wv(li)

    # order-0
    o0_raw = Counter()
    for w, c in cnt.items():
        r = rank_of.get(w)
        if r is not None:
            o0_raw[P + r] += c
    for w, c in ru_freq.items():
        r = rank_of.get(w) or rank_of.get(w.replace("ё", "е"))
        if r is not None:
            o0_raw[P + r] += 1
    if en_freq:
        for w, c in en_freq.items():
            r = rank_of.get(w)
            if r is not None:
                o0_raw[P + r] += max(1, min(60, c // 500))
    o0_syms = sorted(s for s in o0_raw if s < O0_TOP)
    o0_syms = sorted(set(o0_syms) | set(range(P)))[:O0_TOP]
    o0_w = scale_weights({s: max(o0_raw.get(s, 0), 1) for s in o0_syms},
                        max(16000, len(o0_syms)))
    wv(len(o0_w))
    for s in sorted(o0_w):
        wv(s); wv(o0_w[s])
    wv(120); wv(60)      # esc_rank, esc_lit (адаптируются кодеком)

    # B1
    rows = []
    for ctx in sorted(b1_ctx):
        c = b1.get(ctx)
        if c and len(c) >= 2:
            keep = B1_KEEP_EN if (ctx - P) in latin_rank else B1_KEEP
            rows.append((ctx, scale_weights(dict(c.most_common(keep)))))
    wv(len(rows))
    for ctx, w in rows:
        wv(ctx); wv(len(w))
        for s in sorted(w):
            wv(s); wv(w[s])
    print("B1 строк: %d" % len(rows))

    # B2 (однозначные продолжения — самый ценный случай, не выбрасывать)
    rows = []
    for pr in sorted(pairs):
        c = b2.get(pr)
        if c and (len(c) >= 2 or sum(c.values()) >= 3):
            keep = B2_KEEP_EN if ((pr & ((1 << 21) - 1)) - P) in latin_rank else B2_KEEP
            rows.append((pr, scale_weights(dict(c.most_common(keep)))))
    wv(len(rows))
    for pr, w in rows:
        wv(pr); wv(len(w))
        for s in sorted(w):
            wv(s); wv(w[s])
    print("B2 строк: %d" % len(rows))

    # LEM
    rows = []
    for li in sorted(lem_ctx):
        c = lem.get(li)
        if c and len(c) >= 2:
            rows.append((li, scale_weights(dict(c.most_common(LEM_KEEP)))))
    wv(len(rows))
    for li, w in rows:
        wv(li); wv(len(w))
        for s in sorted(w):
            wv(s); wv(w[s])
    print("LEM строк: %d" % len(rows))

    # A
    rows = []
    for ctx in sorted(a_ctx):
        c = A.get(ctx)
        if c:
            rows.append((ctx, scale_weights(dict(c.most_common(A_KEEP)))))
    wv(len(rows))
    for ctx, w in rows:
        wv(ctx); wv(len(w))
        for s in sorted(w):
            wv(s); wv(w[s])
    print("A строк: %d" % len(rows))

    # C
    rows = []
    for pidx in range(P):
        c = C.get(pidx)
        if c:
            rows.append((pidx, scale_weights(dict(c.most_common(C_KEEP)))))
    wv(len(rows))
    for pidx, w in rows:
        wv(pidx); wv(len(w))
        for s in sorted(w):
            wv(s); wv(w[s])

    # byte0 / byte1
    bw = [max(1, min(600, byte0.get(b, 0))) for b in range(256)]
    s = sum(bw)
    bw = [max(1, w * 6000 // s) for w in bw]
    for b in bw:
        wv(b)
    n_b1 = 0
    rows = []
    for pbi in range(256):
        c = byte1[pbi]
        if c:
            rows.append((pbi, scale_weights(dict(c.most_common(16)), 900)))
    wv(len(rows))
    for pbi, w in rows:
        wv(pbi); wv(len(w))
        for x in sorted(w):
            wv(x); wv(w[x])

    # case / len
    for row in case_cnt:
        ssum = max(1, sum(row))
        for x in row:
            wv(max(1, min(60000, x * 1000 // ssum)))
    lw = [max(1, 4000 >> min(i, 20)) for i in range(64)]
    lw[0] = 900
    ssum = sum(len_cnt.values())
    if ssum:
        lw = [max(1, min(60000, len_cnt.get(i, 0) * 4000 // ssum)) for i in range(64)]
    for x in lw:
        wv(x)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(bytes(out))
    print("модель: %s (%.2f МБ, всего %.0fs)" % (OUT, len(out) / 1048576, time.time() - t00))

    stats = {
        "corpus_bytes": total_bytes,
        "files": nfiles,
        "dict_D": D,
        "puncts": P,
        "lemmas": L,
        "o0": len(o0_w),
        "b1_rows": len(b1_ctx),
        "b2_pairs": len(pairs),
        "lem_rows": len(lem_ctx),
        "model_bytes": len(out),
        "top_words": ranked[:30],
    }
    with open(STATS, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    print("stats ->", STATS)


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    if arg == "stage1":
        stage1()
    elif arg == "stage2":
        stage2()
    elif arg == "stage3":
        stage3()
    elif arg == "stage4":
        stage4()
    else:
        t0 = time.time()
        stage1()
        stage2()
        stage3()
        stage4()
        print("ВСЕГО: %.0fs" % (time.time() - t0))
