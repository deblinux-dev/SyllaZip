#!/usr/bin/env python
"""Двусторонняя кросс-проверка Python ↔ Rust: encode и decode побайтово."""
import json
import os
import random
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import szgc_codec as S

N = int(sys.argv[1]) if len(sys.argv) > 1 else 150
RUST = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "rust", "target", "release", "szgc")

texts = [
    "Привет! Как дела?", "", " ", "\n", "ё", "Я", "a",
    "Не забудь купить хлеб и молоко.",
    "Сегодня мы пошли в кино. Завтра мы пошли в театр.",
    "The quick brown fox jumps over the lazy dog.",
    "СМЕШАННЫЙ ЁЖ и Крош, APPLE iPhone 15 Про \U0001f600",
    "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
    "Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.",
    "мы пошли в кино мы пошли в кино мы пошли в кино мы пошли в кино",
    "\t\n \x0b\r", "😀文中中🌍😃😃本😀😀😃中中😀", "abc XYZ", "1234567890",
]
rnd = random.Random(97531)
alphabets = [
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя ",
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    "abc XYZ .,!?\n",
    "ABCDEFabcdef .,!?\n\t",
    "😀😃😄🌍中文日本語テスト",
    "\x00\x01\x02\x7f\xff\xfe",
    "ёЁйЙёлка ЁЛКА ёж",
    "🙂😂👍❤️🔥🎉",
]
words = ["привет", "как", "дела", "the", "quick", "ллызъ", "_fps", "今日", "😀", "42", "не", "SZGC"]
_wiki_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "..", "data", "corpus", "wiki_00.txt")
wiki = (open(_wiki_path, encoding="utf-8").read() if os.path.exists(_wiki_path)
        else "ЦБ России повысил ключевую ставку до двадцати одного процента годовых. " * 200)
while len(texts) < N:
    k = rnd.randint(0, 4)
    if k == 0:
        a = rnd.choice(alphabets)
        texts.append("".join(rnd.choice(a) for _ in range(rnd.randint(0, 150))))
    elif k == 1:
        texts.append(" ".join(rnd.choice(words) for _ in range(rnd.randint(1, 50))))
    elif k == 2:
        base = rnd.choice(["абра", "foo bar ", "今日は ", "😀😀", "the cat sat "])
        texts.append(base * rnd.randint(1, 40))
    elif k == 3:
        off = rnd.randint(0, len(wiki) - 4000)
        texts.append(wiki[off:off + rnd.randint(100, 3000)])
    else:
        a = rnd.choice(alphabets)
        n = rnd.randint(1, 30)
        chunk = "".join(rnd.choice(a) for _ in range(n))
        texts.append((chunk + " ") * rnd.randint(1, 12))

t0 = time.time()
with open("/tmp/xtexts.json", "w", encoding="utf-8") as f:
    json.dump(texts, f, ensure_ascii=False)
rust_hex = json.loads(subprocess.run(
    [RUST, "batch", "/tmp/xtexts.json"], capture_output=True, check=True).stdout)
assert len(rust_hex) == len(texts)

fails = 0
py_hex = []
for i, (t, h) in enumerate(zip(texts, rust_hex)):
    pb = S.compress(t).hex()
    py_hex.append(pb)
    if pb != h:
        print(f"ENC MISMATCH #{i}: py {pb[:32]} rust {h[:32]}")
        fails += 1
        continue
    if S.decompress(bytes.fromhex(h)) != t:
        print(f"PY-DEC FAIL #{i}")
        fails += 1

with open("/tmp/pyhex.json", "w") as f:
    json.dump(py_hex, f)
rust_dec = json.loads(subprocess.run(
    [RUST, "batchdec", "/tmp/pyhex.json"], capture_output=True, check=True).stdout)
for i, (t, d) in enumerate(zip(texts, rust_dec)):
    if d != t:
        print(f"RUST-DEC FAIL #{i}")
        fails += 1

print(f"кросс-проверка Python↔Rust: {len(texts) - fails}/{len(texts)} OK "
      f"(encode+decode в обе стороны, {time.time() - t0:.1f}s)")
sys.exit(1 if fails else 0)
