# -*- coding: utf-8 -*-
"""SZGC CLI (обёртка ядра)"""
import glob
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import szgc_codec

USAGE = """SZGC — морфографовый предиктивный кодек (Python-ядро)
использование:
  szgc_cli.py c <input> [output]     сжать текстовый файл (stdout, если нет output)
  szgc_cli.py d <input> [output]     распаковать
  szgc_cli.py t "текст"              сжать строку аргумента, hex в stdout
  szgc_cli.py batch <texts.json>     сжать массив строк, JSON-массив hex в stdout
  szgc_cli.py batchdec <hex.json>    распаковать JSON-массив hex, JSON-массив строк
  szgc_cli.py bench [texts.json]     таблица размеров (SZGC)
  szgc_cli.py selftest [n]           векторы + round-trip + fuzz
  szgc_cli.py model-info             статистика модели
опции: --model PATH (по умолчанию graph-model.bin рядом с szgc_codec.py)
"""

VECTORS_FALLBACK = [
    "Привет! Как дела?",
    "Спасибо большое, выручил!",
    "Не забудь купить хлеб и молоко.",
    "Ок, до связи!",
    "",
    " ",
    "Я",
    "ЁЖик и ёлка, APPLE iPhone 15 Про \U0001F600",
    "Числа: 12345 и 67890, дата 2026-10-26.",
    "СМЕШАННЫЙ ЁЖ и Крош",
    "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
    "Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.",
]


def find_arg(flag):
    a = sys.argv
    if flag in a:
        i = a.index(flag)
        if i + 1 < len(a):
            return a[i + 1]
    return None


def build_model():
    t0 = time.time()
    path = find_arg("--model")
    try:
        m = szgc_codec.Model(path) if path else szgc_codec.get_model()
    except Exception as e:
        print("не удалось загрузить модель%s: %s" % (" (%s)" % path if path else "", e), file=sys.stderr)
        sys.exit(1)
    szgc_codec._MODEL = m
    size = os.path.getsize(path) if path else os.path.getsize(szgc_codec.MODEL_PATH)
    print("модель: %d слов, %d пунктуаций, %.1f МБ (%.2fс)" % (m.D, m.P, size / 1048576.0, time.time() - t0), file=sys.stderr)
    return m


def read_t(path):
    if path == "-" or path is None:
        return sys.stdin.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


def read_b(path):
    if path == "-" or path is None:
        import io
        data = sys.stdin.buffer.read()
    else:
        with open(path, "rb") as f:
            data = f.read()
    return data


def usage():
    print(USAGE, file=sys.stderr)
    sys.exit(2)


def main():
    a = sys.argv[1:]
    ma = find_arg("--model")
    if ma is not None:
        i = a.index("--model")
        a = a[:i] + a[i + 2:]
    if len(a) < 1:
        usage()
    cmd = a[0]
    m = build_model()
    if cmd in ("c", "compress"):
        text = read_t(a[1] if len(a) > 1 else "-")
        blob = szgc_codec.compress(text)
        out = a[2] if len(a) > 2 else None
        if out:
            with open(out, "wb") as f:
                f.write(blob)
        else:
            sys.stdout.buffer.write(blob)
            sys.stdout.buffer.flush()
    elif cmd in ("d", "decompress"):
        data = read_b(a[1] if len(a) > 1 else "-")
        try:
            text = szgc_codec.decompress(data)
        except Exception as e:
            print("ошибка декодирования: %s" % e, file=sys.stderr)
            sys.exit(1)
        out = a[2] if len(a) > 2 else None
        if out:
            with open(out, "w", encoding="utf-8") as f:
                f.write(text)
        else:
            sys.stdout.write(text)
    elif cmd in ("t", "text"):
        text = a[1] if len(a) > 1 else ""
        print(szgc_codec.compress(text).hex())
    elif cmd == "batch":
        texts = json.load(open(a[1], encoding="utf-8")) if len(a) > 1 else []
        print(json.dumps([szgc_codec.compress(t).hex() for t in texts], ensure_ascii=False))
    elif cmd == "batchdec":
        hx = json.load(open(a[1], encoding="utf-8")) if len(a) > 1 else []
        try:
            texts = [szgc_codec.decompress(bytes.fromhex(h)) for h in hx]
        except Exception as e:
            print("ошибка декодирования: %s" % e, file=sys.stderr)
            sys.exit(1)
        print(json.dumps(texts, ensure_ascii=False))
    elif cmd == "bench":
        p = a[1] if len(a) > 1 else None
        if not p:
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "bench_texts.json")
        raw = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else []
        # новый формат — записи {"name", "text"}, старый — просто строки
        texts = [(x.get("name") or "text%d" % i, x["text"]) if isinstance(x, dict) else ("text%d" % i, x)
                 for i, x in enumerate(raw)]
        print("%-12s %8s %8s %5s" % ("text", "raw", "SZGC", "rt"))
        ok = 0
        for name, t in texts:
            t0 = time.time()
            blob = szgc_codec.compress(t)
            rt = szgc_codec.decompress(blob) == t
            det = szgc_codec.compress(t) == blob
            print("%-12s %8d %8d %5s (%.2fс)" % (name, len(t.encode("utf-8")) if t else 0, len(blob), "OK" if rt and det else "FAIL", time.time() - t0))
            ok += 1 if rt and det else 0
        print("round-trip+det: %d/%d" % (ok, len(texts)))
    elif cmd == "selftest":
        n = int(a[1]) if len(a) > 1 else 200
        selftest(n)
    elif cmd == "model-info":
        print("D=%d P=%d L=%d" % (m.D, m.P, m.L))
        print("puncts:", m.puncts)
        print("top words:", m.words[:30])
    else:
        usage()


def selftest(n_fuzz):
    fails = 0
    vp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "vectors.json")
    texts = []
    if os.path.exists(vp):
        t0 = time.time()
        nvec = 0
        for v in json.load(open(vp, encoding="utf-8")):
            got = szgc_codec.compress(v["text"]).hex()
            back = szgc_codec.decompress(bytes.fromhex(v["hex"]))
            if got != v["hex"] or back != v["text"]:
                print("VECTOR FAIL #%d (%d bytes)" % (nvec, len(v["text"])), file=sys.stderr)
                fails += 1
            nvec += 1
        print("векторы: %d/%d OK (%.2fс)" % (nvec - fails, nvec, time.time() - t0))
    texts += list(VECTORS_FALLBACK)
    for p in sorted(glob.glob("data/corpus/wiki_00.txt")):
        with open(p, encoding="utf-8") as f:
            first = f.read(6000)
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size // 2))
            texts += [first, f.read(6000)]
    rnd = random.Random(20261026)
    alphabets = [
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя ",
        "abc XYZ .,!?\n",
        "\U0001F600\U0001F603\U0001F30D中文日本語",
        "ёЁ ёлка ЁЛКА",
        "\x00\x01\x02\xff",
    ]
    for _ in range(n_fuzz):
        a = rnd.choice(alphabets)
        texts.append("".join(rnd.choice(a) for _ in range(rnd.randint(0, 120))))
    t0 = time.time()
    ok = 0
    for i, t in enumerate(texts):
        try:
            c = szgc_codec.compress(t)
            d = szgc_codec.decompress(c)
        except Exception as e:
            print("FAIL #%d EXC %r: %r" % (i, e, t[:60]), file=sys.stderr)
            fails += 1
            continue
        if d != t or szgc_codec.compress(t) != c:
            print("FAIL #%d: %r" % (i, t[:60]), file=sys.stderr)
            fails += 1
        else:
            ok += 1
        if i % 40 == 0:
            print("  ... %d/%d (%.1fс)" % (i, len(texts), time.time() - t0), flush=True)
    if fails > 0:
        print("FAILURES: %d" % fails, file=sys.stderr)
        sys.exit(1)
    print("selftest: OK (%d/%d round-trip+det, %.1fс)" % (ok, len(texts), time.time() - t0))


if __name__ == "__main__":
    main()
