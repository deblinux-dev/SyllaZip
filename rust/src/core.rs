//! SZGC core: range coder, frequency tables, SZGM model loader, tokenizer.

use std::collections::{HashMap, HashSet};

pub const M32: u64 = 0xFFFF_FFFF;
pub const TOP: u64 = 1 << 24;
pub const ADAPT: i64 = 24;
pub const RESIZE: i64 = 32768;
pub const CTX_CAP: i64 = 192;
pub const ESC_RANK: i64 = -1;
pub const ESC_LIT: i64 = -2;
pub const W_MATCH: i64 = 4096;
pub const ESC_MATCH: i64 = 384;
pub const PAIR_SHIFT: u32 = 21;
pub const W_LZP_HIT: i64 = 4096;
pub const W_LZP_MISS: i64 = 128;
pub const B_ESC: i64 = 12;
pub const B_ASTEP: i64 = 48;
pub const W1_O0: i64 = 64;
pub const W1_ROW: i64 = 192;
pub const W1_FORCE: i64 = 48;

pub fn bit_length(n: i64) -> i64 {
    debug_assert!(n >= 0);
    64 - n.leading_zeros() as i64
}

pub fn apply_case(w: &str, f: i64) -> String {
    match f {
        0 => w.to_string(),
        1 => {
            let mut cs = w.chars();
            match cs.next() {
                None => String::new(),
                Some(c) => {
                    let mut s: String = c.to_uppercase().collect();
                    s.push_str(cs.as_str());
                    s
                }
            }
        }
        _ => w.chars().flat_map(|c| c.to_uppercase()).collect(),
    }
}

fn is_word_char(c: char) -> bool {
    matches!(c, 'А'..='Я' | 'а'..='я' | 'Ё' | 'ё' | 'A'..='Z' | 'a'..='z')
}

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Word(String),
    Lit(String),
}

pub fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut lit = String::new();
    for c in text.chars() {
        if is_word_char(c) {
            if !lit.is_empty() {
                out.push(Tok::Lit(std::mem::take(&mut lit)));
            }
            cur.push(c);
        } else {
            if !cur.is_empty() {
                out.push(Tok::Word(std::mem::take(&mut cur)));
            }
            lit.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(Tok::Word(cur));
    }
    if !lit.is_empty() {
        out.push(Tok::Lit(lit));
    }
    out
}

pub fn get_case(w: &str) -> i64 {
    let cs: Vec<char> = w.chars().collect();
    if cs.iter().all(|c| c.is_lowercase()) {
        return 0;
    }
    let first_up = cs[0].is_uppercase();
    let rest_lower = cs.len() == 1 || cs[1..].iter().all(|c| c.is_lowercase());
    if first_up && rest_lower {
        return 1;
    }
    if cs.len() >= 2 && cs.iter().all(|c| c.is_uppercase()) {
        return 2;
    }
    3
}

// ------------------------------------------------------------- varint

pub fn put_varint(buf: &mut Vec<u8>, n: u64) {
    let mut v = n;
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v != 0 {
            buf.push(b | 0x80);
        } else {
            buf.push(b);
            return;
        }
    }
}

pub struct Reader<'a> {
    pub d: &'a [u8],
    pub p: usize,
}

impl<'a> Reader<'a> {
    pub fn new(d: &'a [u8]) -> Self {
        Reader { d, p: 0 }
    }
    fn byte(&mut self) -> u8 {
        let b = self.d[self.p];
        self.p += 1;
        b
    }
    pub fn varint(&mut self) -> u64 {
        let mut v: u64 = 0;
        let mut sh = 0u32;
        loop {
            let b = self.byte();
            v |= ((b & 0x7F) as u64) << sh;
            sh += 7;
            if b & 0x80 == 0 {
                return v;
            }
        }
    }
    pub fn blob(&mut self) -> &'a [u8] {
        let n = self.varint() as usize;
        let s = self.p;
        self.p += n;
        &self.d[s..s + n]
    }
}

// ------------------------------------------------------------ range coder

pub struct RangeEncoder {
    pub low: u64,
    pub range: u32,
    pub cache: u8,
    pub cache_size: i64,
    pub out: Vec<u8>,
}

impl RangeEncoder {
    pub fn new() -> Self {
        RangeEncoder { low: 0, range: M32 as u32, cache: 0, cache_size: 1, out: Vec::new() }
    }
    fn shift_low(&mut self) {
        if (self.low & M32) < 0xFF00_0000 || (self.low >> 32) != 0 {
            let carry = ((self.low >> 32) & 0xFF) as u32;
            let mut temp = self.cache as u32;
            loop {
                self.out.push(((temp + carry) & 0xFF) as u8);
                temp = 0xFF;
                self.cache_size -= 1;
                if self.cache_size == 0 {
                    break;
                }
            }
            self.cache = ((self.low >> 24) & 0xFF) as u8;
        }
        self.cache_size += 1;
        self.low = (self.low << 8) & M32;
    }
    pub fn encode(&mut self, cum: i64, freq: i64, tot: i64) {
        debug_assert!(freq > 0 && tot > 0 && cum + freq <= tot, "{} {} {}", cum, freq, tot);
        let r = (self.range as u64) / tot as u64;
        self.low += cum as u64 * r;
        self.range = (freq as u64 * r) as u32;
        while (self.range as u64) < TOP {
            self.shift_low();
            self.range <<= 8;
        }
    }
    pub fn flush(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        debug_assert!(self.out.is_empty() || self.out[0] == 0);
        if self.out.is_empty() {
            Vec::new()
        } else {
            self.out[1..].to_vec()
        }
    }
}

pub struct RangeDecoder<'a> {
    pub d: &'a [u8],
    pub p: usize,
    pub range: u32,
    pub code: u32,
    pub r: u64,
    pub clamped: i64,
}

impl<'a> RangeDecoder<'a> {
    pub fn new(d: &'a [u8]) -> Self {
        let mut p = 0usize;
        let mut code: u32 = 0;
        for _ in 0..4 {
            let b = if p < d.len() { d[p] } else { 0 };
            p += 1;
            code = ((((code as u64) << 8) | b as u64) & M32) as u32;
        }
        RangeDecoder { d, p, range: M32 as u32, code, r: 1, clamped: 0 }
    }
    fn byte(&mut self) -> u8 {
        let b = if self.p < self.d.len() { self.d[self.p] } else { 0 };
        self.p += 1;
        b
    }
    pub fn start(&mut self, tot: i64) -> Result<i64, String> {
        if tot <= 0 {
            return Err("corrupt stream: zero-mass table".into());
        }
        self.r = self.range as u64 / tot as u64;
        let mut cum = self.code as u64 / self.r;
        if cum >= tot as u64 {
            cum = (tot - 1) as u64;
            self.clamped += 1;
        }
        Ok(cum as i64)
    }
    pub fn finish(&mut self, cum: i64, freq: i64) {
        self.code = ((self.code as u64)
            .wrapping_sub(cum as u64 * self.r)
            & M32) as u32;
        self.range = (freq as u64 * self.r) as u32;
        while (self.range as u64) < TOP {
            self.range <<= 8;
            let b = self.byte() as u64;
            self.code = ((((self.code as u64) << 8) | b) & M32) as u32;
        }
    }
}

// --------------------------------------------------- frequency table base+delta

/// Ordered dict for the delta layer: insertion order is part of the format.
#[derive(Clone, Default)]
struct ODict {
    keys: Vec<i64>,
    map: HashMap<i64, i64>,
}

impl ODict {
    fn get(&self, k: i64) -> Option<i64> {
        self.map.get(&k).copied()
    }
    fn get_or0(&self, k: i64) -> i64 {
        self.map.get(&k).copied().unwrap_or(0)
    }
    fn contains(&self, k: i64) -> bool {
        self.map.contains_key(&k)
    }
    fn insert(&mut self, k: i64, v: i64) {
        if !self.map.contains_key(&k) {
            self.keys.push(k);
        }
        self.map.insert(k, v);
    }
    fn len(&self) -> usize {
        self.keys.len()
    }
    fn iter(&self) -> impl Iterator<Item = (i64, i64)> + '_ {
        self.keys.iter().map(move |k| (*k, self.map[k]))
    }
}

#[derive(Clone)]
pub struct FT {
    pub bs: Vec<i64>,
    pub bw: Vec<i64>,
    bset: HashSet<i64>,
    delta: ODict,
    pub esc: i64,
    base_esc: i64,
    pub base_sum: i64,
    is_o0: bool,
    esc0: (i64, i64),
    astep: i64,
    cap: Option<i64>,
    resize_at: i64,
    tot: i64,
}

impl FT {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        syms: Option<Vec<i64>>,
        weights: Option<Vec<i64>>,
        esc: i64,
        is_o0: bool,
        esc0: (i64, i64),
        astep: Option<i64>,
        cap: Option<i64>,
        resize_at: Option<i64>,
    ) -> FT {
        let bs = syms.unwrap_or_default();
        let bw = weights.unwrap_or_default();
        let base_sum = bw.iter().sum();
        let mut delta = ODict::default();
        let tot;
        if is_o0 {
            delta.insert(ESC_RANK, esc0.0);
            delta.insert(ESC_LIT, esc0.1);
            tot = base_sum + esc0.0 + esc0.1;
        } else {
            tot = base_sum + esc;
        }
        FT {
            bset: bs.iter().copied().collect(),
            bs,
            bw,
            delta,
            esc,
            base_esc: esc,
            base_sum,
            is_o0,
            esc0,
            astep: astep.unwrap_or(ADAPT),
            cap,
            resize_at: resize_at.unwrap_or(RESIZE),
            tot,
        }
    }

    pub fn simple(syms: Vec<i64>, weights: Vec<i64>, esc: i64) -> FT {
        FT::new(Some(syms), Some(weights), esc, false, (0, 0), None, None, None)
    }

    pub fn empty(esc: i64, astep: i64, cap: i64) -> FT {
        FT::new(None, None, esc, false, (0, 0), Some(astep), Some(cap), None)
    }

    fn cap(&self) -> i64 {
        match self.cap {
            Some(c) => c,
            None => CTX_CAP + self.base_sum / 16,
        }
    }

    pub fn total(&self) -> i64 {
        self.tot
    }

    pub fn total_excl(&self, excl: Option<&HashSet<i64>>) -> i64 {
        let excl = match excl {
            None => return self.tot,
            Some(e) if e.is_empty() => return self.tot,
            Some(e) => e,
        };
        let mut lo = 0i64;
        for i in 0..self.bs.len() {
            let s = self.bs[i];
            if excl.contains(&s) {
                continue;
            }
            lo += self.bw[i] + self.delta.get_or0(s);
        }
        for (s, dw) in self.delta.iter() {
            if self.bset.contains(&s) || excl.contains(&s) {
                continue;
            }
            lo += dw;
        }
        lo + self.esc
    }

    pub fn reset(&mut self) {
        if self.is_o0 {
            self.delta = ODict::default();
            self.delta.insert(ESC_RANK, self.esc0.0);
            self.delta.insert(ESC_LIT, self.esc0.1);
            self.esc = 0;
            self.tot = self.base_sum + self.esc0.0 + self.esc0.1;
        } else {
            self.delta = ODict::default();
            self.esc = self.base_esc;
            self.tot = self.base_sum + self.esc;
        }
    }

    pub fn in_table(&self, sym: i64, excl: Option<&HashSet<i64>>) -> bool {
        if self.bset.contains(&sym) {
            return !matches!(excl, Some(e) if e.contains(&sym));
        }
        self.delta.contains(sym) && !matches!(excl, Some(e) if e.contains(&sym))
    }

    /// (cum, freq, tot); sym=None means the escape interval.
    pub fn find_encode(&self, sym: Option<i64>, excl: Option<&HashSet<i64>>) -> (i64, i64, i64) {
        let mut lo = 0i64;
        let mut found = false;
        let mut freq = 0i64;
        let mut cum = 0i64;
        for i in 0..self.bs.len() {
            let s = self.bs[i];
            if matches!(excl, Some(e) if e.contains(&s)) {
                continue;
            }
            let w = self.bw[i] + self.delta.get_or0(s);
            if w != 0 && Some(s) == sym {
                found = true;
                freq = w;
                cum = lo;
            }
            lo += w;
        }
        for (s, dw) in self.delta.iter() {
            if self.bset.contains(&s) || matches!(excl, Some(e) if e.contains(&s)) {
                continue;
            }
            if Some(s) == sym {
                found = true;
                freq = dw;
                cum = lo;
            }
            lo += dw;
        }
        let tot = lo + self.esc;
        if found {
            (cum, freq, tot)
        } else {
            (tot - self.esc, self.esc, tot)
        }
    }

    /// (sym|None, lo, freq); None = escape.
    pub fn decode_sym(&self, cum: i64, excl: Option<&HashSet<i64>>) -> (Option<i64>, i64, i64) {
        let mut lo = 0i64;
        for i in 0..self.bs.len() {
            let s = self.bs[i];
            if matches!(excl, Some(e) if e.contains(&s)) {
                continue;
            }
            let w = self.bw[i] + self.delta.get_or0(s);
            if cum < lo + w {
                return (Some(s), lo, w);
            }
            lo += w;
        }
        for (s, dw) in self.delta.iter() {
            if self.bset.contains(&s) || matches!(excl, Some(e) if e.contains(&s)) {
                continue;
            }
            if cum < lo + dw {
                return (Some(s), lo, dw);
            }
            lo += dw;
        }
        (None, lo, self.esc)
    }

    pub fn adapt(&mut self, sym: Option<i64>, insert: bool, insert_sym: Option<i64>) {
        match sym {
            None => {
                if self.esc < 60000 {
                    self.esc += self.astep;
                    self.tot += self.astep;
                }
                if insert {
                    if let Some(isym) = insert_sym {
                        if self.delta.contains(isym) {
                            if self.delta.get(isym).unwrap() < 60000 {
                                let v = self.delta.get(isym).unwrap() + self.astep;
                                self.delta.insert(isym, v);
                                self.tot += self.astep;
                            }
                        } else if !self.bset.contains(&isym)
                            && ((self.bs.len() + self.delta.len()) as i64) < self.cap()
                        {
                            self.delta.insert(isym, self.astep);
                            self.tot += self.astep;
                        }
                    }
                }
            }
            Some(s) if self.bset.contains(&s) => {
                let old = self.delta.get_or0(s);
                if old < 60000 {
                    self.delta.insert(s, old + self.astep);
                    self.tot += self.astep;
                }
            }
            Some(s) => match self.delta.get(s) {
                None => {
                    if ((self.bs.len() + self.delta.len()) as i64) < self.cap() {
                        self.delta.insert(s, self.astep);
                        self.tot += self.astep;
                    }
                }
                Some(old) if old < 60000 => {
                    self.delta.insert(s, old + self.astep);
                    self.tot += self.astep;
                }
                _ => {}
            },
        }
        if self.tot >= self.resize_at && !self.is_o0 {
            self.resize();
        }
    }

    fn resize(&mut self) {
        let mut nd = ODict::default();
        for i in 0..self.bs.len() {
            let s = self.bs[i];
            let eff = (self.bw[i] + self.delta.get_or0(s)) >> 1;
            let d = eff - self.bw[i];
            if d > 0 {
                nd.insert(s, d);
            }
        }
        for (s, dw) in self.delta.iter() {
            if self.bset.contains(&s) {
                continue;
            }
            let eff = dw >> 1;
            if eff > 0 {
                nd.insert(s, eff);
            }
        }
        self.delta = nd;
        if self.is_o0 {
            if !self.delta.contains(ESC_RANK) {
                self.delta.insert(ESC_RANK, 0);
            }
            let r = self.delta.get(ESC_RANK).unwrap();
            self.delta.insert(ESC_RANK, r.max(1));
            let l = self.delta.get_or0(ESC_LIT) >> 1;
            self.delta.insert(ESC_LIT, l.max(1));
        }
        self.esc = if !self.is_o0 { (self.esc >> 1).max(1) } else { self.esc };
        self.tot = self.base_sum + self.delta.map.values().sum::<i64>() + self.esc;
    }

    pub fn delta_keys(&self) -> Vec<i64> {
        self.delta.keys.clone()
    }
}

// ------------------------------------------------------------- Fenwick o0

pub struct FenwickO0 {
    pub bs: Vec<i64>,
    pub bweight: Vec<i64>,
    pos: HashMap<i64, usize>,
    pub bset: HashSet<i64>,
    tree: Vec<i64>,
    raw_tot: i64,
    esc_rank: i64,
    esc_lit: i64,
    esc_rank0: i64,
    esc_lit0: i64,
    extra: HashMap<i64, i64>,
    adds: Vec<(usize, i64)>,
}

impl FenwickO0 {
    pub fn new(syms: Vec<i64>, weights: Vec<i64>, esc_rank: i64, esc_lit: i64) -> FenwickO0 {
        let n = syms.len();
        let pos: HashMap<i64, usize> = syms.iter().copied().enumerate().map(|(i, s)| (s, i)).collect();
        let raw_tot: i64 = weights.iter().sum();
        let mut tree = vec![0i64; n + 1];
        for (i, w) in weights.iter().enumerate() {
            let mut j = i + 1;
            while j <= n {
                tree[j] += w;
                j += j & j.wrapping_neg();
            }
        }
        FenwickO0 {
            bset: syms.iter().copied().collect(),
            bs: syms,
            bweight: weights,
            pos,
            tree,
            raw_tot,
            esc_rank,
            esc_lit,
            esc_rank0: esc_rank,
            esc_lit0: esc_lit,
            extra: HashMap::new(),
            adds: Vec::new(),
        }
    }

    fn tree_add(&mut self, i: usize, v: i64) {
        let n = self.tree.len() - 1;
        let mut i = i;
        while i <= n {
            self.tree[i] += v;
            i += i & i.wrapping_neg();
        }
    }

    fn prefix(&self, i: usize) -> i64 {
        let mut s = 0i64;
        let mut i = i;
        while i > 0 {
            s += self.tree[i];
            i -= i & i.wrapping_neg();
        }
        s
    }

    fn w_of(&self, s: i64) -> i64 {
        self.bweight[self.pos[&s]] + self.extra.get(&s).copied().unwrap_or(0)
    }

    fn excl_sorted(&self, excl: &HashSet<i64>) -> Vec<(usize, i64)> {
        let mut items: Vec<(usize, i64)> = excl
            .iter()
            .filter_map(|s| self.pos.get(s).map(|&p| (p, self.w_of(*s))))
            .collect();
        items.sort_unstable();
        items
    }

    fn excl_below(items: &[(usize, i64)], idx: usize) -> i64 {
        let mut s = 0i64;
        for &(pi, w) in items {
            if pi < idx {
                s += w;
            } else {
                break;
            }
        }
        s
    }

    pub fn total(&self) -> i64 {
        self.raw_tot + self.esc_rank + self.esc_lit
    }

    pub fn total_excl(&self, excl: Option<&HashSet<i64>>) -> i64 {
        match excl {
            None => self.total(),
            Some(e) if e.is_empty() => self.total(),
            Some(e) => self.total() - e.iter().filter(|s| self.pos.contains_key(s)).map(|s| self.w_of(*s)).sum::<i64>(),
        }
    }

    pub fn in_table(&self, sym: i64, excl: Option<&HashSet<i64>>) -> bool {
        if self.bset.contains(&sym) {
            return !matches!(excl, Some(e) if e.contains(&sym));
        }
        false
    }

    pub fn reset(&mut self) {
        let adds = std::mem::take(&mut self.adds);
        for &(idx, v) in &adds {
            self.tree_add(idx + 1, -v);
            self.raw_tot -= v;
        }
        self.extra.clear();
        self.esc_rank = self.esc_rank0;
        self.esc_lit = self.esc_lit0;
    }

    pub fn adapt(&mut self, sym: i64) {
        if sym == ESC_RANK {
            self.esc_rank = (self.esc_rank + ADAPT).min(60000);
        } else if sym == ESC_LIT {
            self.esc_lit = (self.esc_lit + ADAPT).min(60000);
        } else if let Some(&idx) = self.pos.get(&sym) {
            let w = self.extra.get(&sym).copied().unwrap_or(0);
            if w < 60000 {
                self.tree_add(idx + 1, ADAPT);
                self.raw_tot += ADAPT;
                self.adds.push((idx, ADAPT));
                self.extra.insert(sym, w + ADAPT);
            }
        }
    }

    /// (cum, freq, tot); for ESC_RANK/ESC_LIT — tail intervals.
    pub fn find_encode(&self, sym: i64, excl: Option<&HashSet<i64>>) -> (i64, i64, i64) {
        let items;
        let excl_sum;
        match excl {
            None => {
                items = Vec::new();
                excl_sum = 0;
            }
            Some(e) if e.is_empty() => {
                items = Vec::new();
                excl_sum = 0;
            }
            Some(e) => {
                items = self.excl_sorted(e);
                excl_sum = items.iter().map(|x| x.1).sum();
            }
        }
        if sym == ESC_RANK || sym == ESC_LIT {
            let base = self.raw_tot - excl_sum;
            let tot = base + self.esc_rank + self.esc_lit;
            if sym == ESC_RANK {
                return (base, self.esc_rank, tot);
            }
            return (base + self.esc_rank, self.esc_lit, tot);
        }
        match self.pos.get(&sym) {
            None => {
                let base = self.raw_tot - excl_sum;
                (base, self.esc_rank, base + self.esc_rank + self.esc_lit)
            }
            Some(&idx) if matches!(excl, Some(e) if e.contains(&sym)) => {
                let _ = idx;
                let base = self.raw_tot - excl_sum;
                (base, self.esc_rank, base + self.esc_rank + self.esc_lit)
            }
            Some(&idx) => {
                let w = self.w_of(sym);
                let cum = self.prefix(idx) - Self::excl_below(&items, idx);
                let tot = self.raw_tot - excl_sum + self.esc_rank + self.esc_lit;
                (cum, w, tot)
            }
        }
    }

    /// (sym, lo, freq); sym = ESC_RANK/ESC_LIT for escape intervals.
    pub fn decode_sym(&self, cum: i64, excl: Option<&HashSet<i64>>) -> (i64, i64, i64) {
        let items;
        let excl_sum;
        match excl {
            None => {
                items = Vec::new();
                excl_sum = 0;
            }
            Some(e) if e.is_empty() => {
                items = Vec::new();
                excl_sum = 0;
            }
            Some(e) => {
                items = self.excl_sorted(e);
                excl_sum = items.iter().map(|x| x.1).sum();
            }
        }
        let base_tot = self.raw_tot - excl_sum;
        if cum >= base_tot {
            if cum < base_tot + self.esc_rank {
                return (ESC_RANK, base_tot, self.esc_rank);
            }
            return (ESC_LIT, base_tot + self.esc_rank, self.esc_lit);
        }
        let (mut lo, mut hi) = (0usize, self.bs.len() - 1);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let ap = self.prefix(mid + 1) - Self::excl_below(&items, mid + 1);
            if ap > cum {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        let idx = lo;
        let s = self.bs[idx];
        let w = self.w_of(s);
        let lo_cum = self.prefix(idx) - Self::excl_below(&items, idx);
        (s, lo_cum, w)
    }
}

// ------------------------------------------------------------- model

/// Identifies a model table for the touched-set (state rollback between calls).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TableId {
    O0,
    Byte,
    Bo0,
    Len,
    Case(usize),
    B1(u64),
    B2(u64),
    Lem(u64),
    A(u64),
    C(u64),
}

pub struct Model {
    pub d: usize,
    pub p: usize,
    pub l: usize,
    pub puncts: Vec<String>,
    pub words: Vec<String>,
    pub rank: HashMap<String, u32>,
    pub lemma_ids: Vec<u64>,
    pub st_o0: FenwickO0,
    pub b1: HashMap<u64, FT>,
    pub b2: HashMap<u64, FT>,
    pub lem: HashMap<u64, FT>,
    pub a: HashMap<u64, FT>,
    pub c: HashMap<u64, FT>,
    pub st_byte: FT,
    pub byte1_rows: HashMap<u64, (Vec<i64>, Vec<i64>)>,
    pub st_case: Vec<FT>,
    pub st_len: FT,
    /// Tables adapted during the last encode/decode call; reset by the next one.
    pub touched: std::cell::RefCell<Vec<TableId>>,
}

fn rows_from(r: &mut Reader) -> Result<HashMap<u64, FT>, String> {
    let n = r.varint();
    let mut d = HashMap::with_capacity(n as usize);
    for _ in 0..n {
        let k = r.varint();
        let m = r.varint();
        let mut syms = Vec::with_capacity(m as usize);
        let mut ws = Vec::with_capacity(m as usize);
        for _ in 0..m {
            syms.push(r.varint() as i64);
            ws.push(r.varint() as i64);
        }
        d.insert(k, FT::simple(syms, ws, 40));
    }
    Ok(d)
}

impl Model {
    pub fn from_bytes(data: &[u8]) -> Result<Model, String> {
        if data.len() < 5 || &data[..4] != b"SZGM" || data[4] != 2 {
            return Err("bad model (SZGM v2 expected)".into());
        }
        let mut r = Reader::new(data);
        r.p = 5;
        let d_sz = r.varint() as usize;
        let p_sz = r.varint() as usize;
        let l = r.varint() as usize;
        let _o0_top = r.varint();
        let _b1_rows = r.varint();
        let _b2_rows = r.varint();
        let _lem_rows = r.varint();
        let mut puncts = Vec::with_capacity(p_sz);
        for _ in 0..p_sz {
            let b = r.blob();
            puncts.push(String::from_utf8(b.to_vec()).map_err(|_| "bad punct utf-8")?);
        }
        let mut words = Vec::with_capacity(d_sz);
        let mut rank = HashMap::with_capacity(d_sz * 2);
        for i in 0..d_sz {
            let b = r.blob();
            let w = String::from_utf8(b.to_vec()).map_err(|_| "bad word utf-8")?;
            rank.insert(w.clone(), i as u32);
            words.push(w);
        }
        let mut lemma_ids = Vec::with_capacity(d_sz);
        for _ in 0..d_sz {
            lemma_ids.push(r.varint());
        }
        let n0 = r.varint() as usize;
        let mut syms = Vec::with_capacity(n0);
        let mut ws = Vec::with_capacity(n0);
        for _ in 0..n0 {
            syms.push(r.varint() as i64);
            ws.push(r.varint() as i64);
        }
        let esc_rank = r.varint() as i64;
        let esc_lit = r.varint() as i64;
        let st_o0 = FenwickO0::new(syms, ws, esc_rank, esc_lit);
        let b1 = rows_from(&mut r)?;
        let b2 = rows_from(&mut r)?;
        let lem = rows_from(&mut r)?;
        let a = rows_from(&mut r)?;
        let c = rows_from(&mut r)?;
        let mut bw = Vec::with_capacity(256);
        for _ in 0..256 {
            bw.push(r.varint() as i64);
        }
        let st_byte = FT::new(
            Some((0..256).collect()),
            Some(bw),
            0,
            false,
            (0, 0),
            Some(64),
            None,
            Some(10000),
        );
        let n_b1 = r.varint();
        let mut byte1_rows = HashMap::with_capacity(n_b1 as usize);
        for _ in 0..n_b1 {
            let pbi = r.varint();
            let k = r.varint();
            let mut syms = Vec::with_capacity(k as usize);
            let mut ws = Vec::with_capacity(k as usize);
            for _ in 0..k {
                syms.push(r.varint() as i64);
                ws.push(r.varint() as i64);
            }
            byte1_rows.insert(pbi, (syms, ws));
        }
        let mut st_case = Vec::with_capacity(4);
        for _ in 0..4 {
            let mut row = Vec::with_capacity(3);
            for _ in 0..3 {
                row.push(r.varint() as i64);
            }
            st_case.push(FT::simple(vec![0, 1, 2], row, 0));
        }
        let mut lw = Vec::with_capacity(64);
        for _ in 0..64 {
            lw.push(r.varint() as i64);
        }
        let st_len = FT::new(Some((0..64).collect()), Some(lw), 0, false, (0, 0), Some(96), None, None);
        Ok(Model {
            d: d_sz,
            p: p_sz,
            l,
            puncts,
            words,
            rank,
            lemma_ids,
            st_o0,
            b1,
            b2,
            lem,
            a,
            c,
            st_byte,
            byte1_rows,
            st_case,
            st_len,
            touched: std::cell::RefCell::new(Vec::new()),
        })
    }
}
