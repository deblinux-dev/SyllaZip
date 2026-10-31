# -*- coding: utf-8 -*-
"""Регенерация tests/vectors.json: Python-эталон для JS/Rust кросс-проверок."""
import json
import os
import random
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(REPO, ".."))
import szgc_codec as S  # noqa: E402


def build_vectors():
    texts = [
        "",
        " ",
        "Я",
        "a",
        "Привет! Как дела?",
        "Не забудь купить хлеб и молоко.",
        "The quick brown fox jumps over the lazy dog.",
        "Смешанный текст with English words внутри русского предложения.",
        "Quantum computing uses qubits. The quantum computer uses qubits and more qubits.",
        "ЁЖик и ёлка, APPLE iPhone 15 Про \U0001f600",
        "Числа: 12345 и 67890, дата 2026-10-26.",
        "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
        "\x00\x01\x02\xff",
        "ёд, ёлка, ЁЛКА, ёж, ЁЖ",
    ]
    hold = os.path.join(REPO, "holdout")
    for n in ("en_2026", "en_quantum", "ru_2026"):
        p = os.path.join(hold, n + ".txt")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                texts.append(f.read()[:1500])
    rnd = random.Random(20261031)
    alphabets = [
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя ",
        "abc XYZ .,!?\n",
        "😀😃🌍中文日本語",
        "ёЁ ёлка ЁЛКА",
        "\x00\x01\x02\xff",
        "the of and to in is it you that",
    ]
    for _ in range(14):
        a = rnd.choice(alphabets)
        texts.append("".join(rnd.choice(a) for _ in range(rnd.randint(0, 120))))
    out = []
    for t in texts:
        c = S.compress(t)
        assert S.decompress(c) == t
        assert S.compress(t) == c
        out.append({"text": t, "hex": c.hex(), "tag": c[0]})
    return out


if __name__ == "__main__":
    vecs = build_vectors()
    path = os.path.join(REPO, "vectors.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(vecs, f, ensure_ascii=False)
    print("векторов: %d -> %s" % (len(vecs), path))
