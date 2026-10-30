# -*- coding: utf-8 -*-
"""Fuzz-тест SZGC: случайные тексты, обрезки UTF-8, повторы, границы."""
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from szgc_codec import compress, decompress


def gen_texts(rnd, n):
    out = []
    alphabets = [
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя ",
        "ABCDEFabcdef .,!?\n",
        "😀😃😄🌍中文日本語テスト",
        "\x00\x01\x02\xff\xfe",
        "ёЁйЙёлка ЁЛКА ёж",
        "the quick brown fox jumps over the lazy dog ",
        "Привет! Как дела? Сегодня мы пошли в кино. ",
        "0123456789 -=",
        "🙂😂👍❤️🔥🎉",
    ]
    words = ["привет", "как", "дела", "the", "quick", "ллызъ", "_fps", "nya",
             "今日", "😀", "🙂", "42", "не", "на", "combien"]
    for _ in range(n):
        kind = rnd.randrange(6)
        if kind == 0:
            a = rnd.choice(alphabets)
            out.append("".join(rnd.choice(a) for _ in range(rnd.randint(0, 300))))
        elif kind == 1:
            out.append(" ".join(rnd.choice(words) for _ in range(rnd.randint(0, 80))))
        elif kind == 2:
            base = rnd.choice(["абра", "foo bar ", "今日は ", "😀😀"])
            out.append(base * rnd.randint(0, 40))
        elif kind == 3:
            # обрезка многобайтового символа на границе строки нельзя (str),
            # поэтому режем по кодовым точкам
            a = rnd.choice(alphabets)
            s = "".join(rnd.choice(a) for _ in range(rnd.randint(1, 50)))
            out.append(s[:rnd.randint(0, len(s))])
        elif kind == 4:
            out.append("".join(rnd.choice("\t\n \x0b\x0c\r") for _ in range(rnd.randint(0, 60))))
        else:
            # длинные повторы фраз (LZP-стресс)
            phrase = rnd.choice(["мы пошли в кино ", "the cat sat ", "今日 も 暑い "])
            out.append(phrase * rnd.randint(1, 30) + rnd.choice(words))
    return out


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    rnd = random.Random(987654321)
    texts = gen_texts(rnd, n)
    fails = 0
    t0 = time.time()
    for i, t in enumerate(texts):
        try:
            c = compress(t)
            d = decompress(c)
            if d != t:
                fails += 1
                print("RT FAIL %d: %r -> %r" % (i, t[:50], d[:50]))
            c2 = compress(t)
            if c2 != c:
                fails += 1
                print("DET FAIL %d" % i)
        except Exception as e:
            fails += 1
            print("EXC %d: %r: %r" % (i, t[:50], e))
        if (i + 1) % 100 == 0:
            print("  ... %d/%d (%.1fs)" % (i + 1, len(texts), time.time() - t0), flush=True)
    print("fuzz: %d/%d OK (%.1fs)" % (len(texts) - fails, len(texts), time.time() - t0))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
