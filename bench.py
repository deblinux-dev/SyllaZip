# -*- coding: utf-8 -*-
"""Бенчмарк SZGC против gzip / bzip2 / xz / brotli / zstd.

Набор текстов фиксирован и лежит в репозитории:
  5 базовых (чат, новость, панграмма, ЦБ РФ) +
  5 отложенных статей Википедии (tests/holdout/, скачаны после даты обучения) +
  20 псевдослучайных «шумовых» строк (seed 42).
Пропусков быть не может: если файлов нет, скрипт падает, а не считает неполный итог.

Запуск: python bench.py
Результаты: tests/bench_rows.json (по строкам) и tests/bench_texts.json (тексты).
"""
import bz2
import glob
import gzip
import json
import lzma
import os
import random
import sys
import time

import brotli
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import szgc_codec as S

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_ROWS = os.path.join(HERE, "tests", "bench_rows.json")
OUT_TEXTS = os.path.join(HERE, "tests", "bench_texts.json")
HOLDOUT = os.path.join(HERE, "tests", "holdout")

BASE_TEXTS = [
    "Привет! Как дела?",
    "Не забудь купить хлеб и молоко.",
    "Сегодня мы пошли в кино. Завтра мы пошли в театр.",
    "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.",
    "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
]


def holdout_texts():
    """Все отложенные тексты. Нет файлов — это ошибка, а не повод пропустить строку."""
    files = sorted(glob.glob(os.path.join(HOLDOUT, "*.txt")))
    if not files:
        sys.exit("нет отложенных текстов в %s — бенчмарк без них неполный" % HOLDOUT)
    out = []
    for path in files:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if not text.strip():
            sys.exit("пустой отложенный текст: %s" % path)
        out.append((os.path.splitext(os.path.basename(path))[0], text))
    return out


def noise_texts(n=20, seed=42):
    rnd = random.Random(seed)
    alphabets = ["абвгдеёжзийклмнопрстуфхцчшщъыьэюя ", "abc XYZ .,!?\n", "😀😃🌍中文日本語"]
    out = []
    for _ in range(n):
        a = rnd.choice(alphabets)
        out.append("".join(rnd.choice(a) for _ in range(rnd.randint(0, 120))))
    return out


def build_texts():
    texts = [(("base%02d" % (i + 1)), t) for i, t in enumerate(BASE_TEXTS)]
    texts += holdout_texts()
    texts += [("noise%02d" % (i + 1), t) for i, t in enumerate(noise_texts())]
    return texts


def bench_row(b):
    return {
        "raw": len(b),
        "gzip9": len(gzip.compress(b, 9)),
        "bz2": len(bz2.compress(b, 9)),
        "xz9e": len(lzma.compress(b, preset=9 | lzma.PRESET_EXTREME)),
        "br11": len(brotli.compress(b, quality=11)),
        "zstd19": len(zstandard.ZstdCompressor(level=19).compress(b)),
    }


def main():
    texts = build_texts()
    with open(OUT_TEXTS, "w", encoding="utf-8") as f:
        json.dump([{"name": n, "text": t} for n, t in texts], f, ensure_ascii=False)
    S.get_model()
    print("%-12s %7s %7s %7s %6s %6s %6s %7s" %
          ("text", "raw", "SZGC", "gzip9", "bz2", "xz9e", "br11", "zstd19"))
    rows = []
    wins = checked = 0
    for name, t in texts:
        t0 = time.time()
        c = S.compress(t)
        rt = S.decompress(c) == t
        det = S.compress(t) == c
        r = bench_row(t.encode("utf-8"))
        r["szgc"] = len(c)
        r["name"] = name
        r["rt"] = rt and det
        rows.append(r)
        best = min(r[k] for k in ("gzip9", "bz2", "xz9e", "br11", "zstd19"))
        win = r["szgc"] <= best and rt and det
        wins += win
        checked += 1
        print("%-12s %7d %7d %7d %6d %6d %6d %7d  %s%s (%.1fs)" %
              (name, r["raw"], r["szgc"], r["gzip9"], r["bz2"], r["xz9e"],
               r["br11"], r["zstd19"], "OK " if rt and det else "FAIL",
               "WIN" if win else "", time.time() - t0), flush=True)
    print("проверено текстов: %d, побед: %d" % (checked, wins))
    with open(OUT_ROWS, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main()
