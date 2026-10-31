# -*- coding: utf-8 -*-
"""Генерация docs/chart_ratio.png и docs/chart_sizes.png из tests/bench_rows.json."""
import json

import matplotlib.font_manager as fm

fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')

import matplotlib.pyplot as plt
plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

BASE = '/home/z/my-project/download/syllazip'
rows = json.load(open(f'{BASE}/tests/bench_rows.json'))
texts = {t['name']: t['text'] for t in json.load(open(f'{BASE}/tests/bench_texts.json'))}

COMPETITORS = ('gzip9', 'bz2', 'xz9e', 'br11', 'zstd19')

READABLE = {
    'base01': '«Привет! Как дела?»',
    'base02': '«Не забудь купить хлеб и молоко.»',
    'base03': '«Сегодня мы пошли в кино. Завтра …»',
    'base04': 'Панграммы EN «The quick brown fox …»',
    'base05': 'Новость ЦБ РФ',
    'ru_2026': 'Википедия RU «2026 год» · 5,9 КБ',
    'ru_wc2026': 'Википедия RU «ЧМ-2026» · 7,7 КБ',
    'ru_space_tourism': 'Википедия RU «Космический туризм» · 4 КБ',
    'en_2026': 'Википедия EN «2026» · 3,1 КБ',
    'en_quantum': 'Википедия EN «Quantum computing» · 5,6 КБ',
}


def noise_kind(t):
    has_cjk = any(ord(c) > 0x2F00 for c in t)
    has_cyr = any('а' <= c <= 'я' or c == 'ё' for c in t)
    if has_cjk:
        return 'CJK + эмодзи'
    if has_cyr:
        return 'случайные русские буквы'
    return 'случайная латиница и знаки'


def label(name, raw):
    if name in READABLE:
        return READABLE[name]
    return f'{name} · {noise_kind(texts.get(name, ""))} · {raw} Б'


items = []
for r in rows:
    best = min(r[c] for c in COMPETITORS)
    pct = round(r['szgc'] / best * 100)
    items.append((pct, label(r['name'], r['raw']), pct <= 100, r))

items.sort(key=lambda x: x[0], reverse=True)

labels = [t[1] for t in items]
pcts = [t[0] for t in items]
colors = ['#c0392b' if t[2] else '#e67e22' for t in items]

fig, ax = plt.subplots(figsize=(11, 9.6), dpi=140, constrained_layout=True)
y = range(len(items))
bars = ax.barh(y, pcts, color=colors, height=0.68, zorder=3)

ax.set_yticks(list(y))
ax.set_yticklabels(labels, fontsize=9.5)
for bar, pct in zip(bars, pcts):
    ax.text(bar.get_width() + 1.2, bar.get_y() + bar.get_height() / 2,
            f'{pct}%', va='center', fontsize=9, color='#333333', zorder=4)

ax.axvline(100, color='#555555', linestyle='--', linewidth=1.2, zorder=2)
ax.set_xlim(0, 118)
ax.set_xlabel('Размер SZGC относительно лучшего из конкурентов, %', fontsize=11)
ax.set_title('Чем короче полоса — тем лучше SZGC сжал этот текст\n'
             '100% = размер лучшего классического компрессора на этом тексте',
             fontsize=12.5)
ax.xaxis.grid(True, color='#dddddd', zorder=0)
ax.tick_params(axis='x', labelsize=10)

for spine in ('top', 'right'):
    ax.spines[spine].set_visible(False)

fig.savefig(f'{BASE}/docs/chart_ratio.png')
print('chart_ratio.png: %d полос, побед: %d' % (len(items), sum(1 for t in items if t[2])))

# ---- chart_sizes.png: исходник vs SZGC и brotli (лог-шкала) ----
fig2, ax2 = plt.subplots(figsize=(10, 7.5), dpi=140, constrained_layout=True)
xs = [t[3]['raw'] for t in items]
ys_szgc = [t[3]['szgc'] for t in items]
ys_br = [t[3]['br11'] for t in items]
ax2.scatter(xs, ys_szgc, s=46, color='#c0392b', label='SZGC', zorder=3)
ax2.scatter(xs, ys_br, s=40, color='#7f8c8d', marker='^', label='brotli -q11', zorder=2)
lim = max(max(xs), max(ys_szgc), max(ys_br)) * 1.15
ax2.plot([1, lim], [1, lim], color='#bbbbbb', linewidth=1, linestyle='--', zorder=1)
ax2.set_xscale('log')
ax2.set_yscale('log')
ax2.set_xlabel('Исходный размер, байт (лог-шкала)', fontsize=11)
ax2.set_ylabel('Сжатый размер, байт (лог-шкала)', fontsize=11)
ax2.set_title('Размер архива против исходного размера\n'
              'ниже пунктира = сжатие; SZGC против brotli -q11', fontsize=12.5)
ax2.grid(True, color='#dddddd', zorder=0)
ax2.legend(fontsize=10)
for spine in ('top', 'right'):
    ax2.spines[spine].set_visible(False)
fig2.savefig(f'{BASE}/docs/chart_sizes.png')
print('chart_sizes.png сохранён')
