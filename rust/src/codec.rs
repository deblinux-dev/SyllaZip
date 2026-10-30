//! SZGC codec: token mode (0x02) and byte fallback modes (0x03..0x05).
//! Mirror of szgc_codec.py.

use std::collections::{HashMap, HashSet};

use crate::core::*;

const FMT_TAG: u8 = 2;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Prev {
    Word(u64),
    Punct(usize),
    Lit,
}

use crate::core::TableId as TId;

enum WTab {
    Match(u64),
    B2(u64),
    B1(u64),
    C(usize),
    Lem(u64),
}

enum TabRef {
    A(u64),
    C(usize),
}

enum TabId {
    Match(u64),
    Model(TId),
}

fn hexs(h: &[u8]) -> String {
    h.iter().map(|b| format!("{:02x}", b)).collect()
}

fn escape_excl(ft: &FT, excl: &mut HashSet<i64>) {
    for s in ft.bs.clone() {
        excl.insert(s);
    }
    for s in ft.delta_keys() {
        excl.insert(s);
    }
}

/// One word-chain table step: encode sym or escape. true = found.
fn enc_word_tab(enc: &mut RangeEncoder, ft: &mut FT, sym: i64, excl: &mut HashSet<i64>) -> bool {
    if ft.in_table(sym, Some(excl)) {
        let (cum, freq, tot) = ft.find_encode(Some(sym), Some(excl));
        enc.encode(cum, freq, tot);
        ft.adapt(Some(sym), false, None);
        true
    } else {
        let (cum, freq, tot) = ft.find_encode(None, Some(excl));
        enc.encode(cum, freq, tot);
        escape_excl(ft, excl);
        false
    }
}

/// One word-chain table step on decode; Some(sym) when found, escape extends excl.
fn dec_word_tab(
    dec: &mut RangeDecoder,
    ft: &mut FT,
    excl: &mut HashSet<i64>,
) -> Result<Option<i64>, String> {
    let tot = ft.total_excl(Some(excl));
    let cum = dec.start(tot)?;
    let (s, lo, freq) = ft.decode_sym(cum, Some(excl));
    dec.finish(lo, freq);
    match s {
        Some(s) => {
            ft.adapt(Some(s), false, None);
            Ok(Some(s))
        }
        None => {
            escape_excl(ft, excl);
            Ok(None)
        }
    }
}

pub struct Szgc<'a> {
    m: &'a mut Model,
    byte_mode: Option<u8>,
    bo0: Option<FT>,
    match_: HashMap<u64, FT>,
    b1c: HashMap<u8, FT>,
    b1hit: HashMap<u8, FT>,
    bctx: HashMap<u8, HashMap<Vec<u8>, FT>>,
    bhist: Vec<u8>,
    kindc: HashMap<i64, FT>,
    last_kind: i64,
    prev: Option<Prev>,
    prev2: Option<Prev>,
    w1: Option<u64>,
    w2: Option<u64>,
    wlist: Vec<u64>,
    lzp_pos: HashMap<u64, usize>,
    lzp_flag: FT,
    raw_t: FT,
}

impl<'a> Szgc<'a> {
    pub fn new(m: &'a mut Model) -> Szgc<'a> {
        Szgc {
            m,
            byte_mode: None,
            bo0: None,
            match_: HashMap::new(),
            b1c: HashMap::new(),
            b1hit: HashMap::new(),
            bctx: HashMap::new(),
            bhist: Vec::new(),
            kindc: HashMap::new(),
            last_kind: 0,
            prev: None,
            prev2: None,
            w1: None,
            w2: None,
            wlist: Vec::new(),
            lzp_pos: HashMap::new(),
            lzp_flag: FT::simple(vec![1, 0], vec![W_LZP_HIT, W_LZP_MISS], 0),
            raw_t: FT::simple(vec![0, 1, 2], vec![64, 96, 40], 0),
        }
    }

    // ------------------------------------------------------------ state

    fn touch(&self, id: TId) {
        self.m.touched.borrow_mut().push(id);
    }

    fn fresh(&mut self) {
        let ids: Vec<TId> = self.m.touched.borrow_mut().drain(..).collect();
        for id in ids {
            match id {
                TId::O0 => self.m.st_o0.reset(),
                TId::Byte => self.m.st_byte.reset(),
                TId::Bo0 => {
                    if let Some(ft) = self.bo0.as_mut() {
                        ft.reset()
                    }
                }
                TId::Len => self.m.st_len.reset(),
                TId::Case(i) => self.m.st_case[i].reset(),
                TId::B1(k) => {
                    if let Some(ft) = self.m.b1.get_mut(&k) {
                        ft.reset()
                    }
                }
                TId::B2(k) => {
                    if let Some(ft) = self.m.b2.get_mut(&k) {
                        ft.reset()
                    }
                }
                TId::Lem(k) => {
                    if let Some(ft) = self.m.lem.get_mut(&k) {
                        ft.reset()
                    }
                }
                TId::A(k) => {
                    if let Some(ft) = self.m.a.get_mut(&k) {
                        ft.reset()
                    }
                }
                TId::C(k) => {
                    if let Some(ft) = self.m.c.get_mut(&k) {
                        ft.reset()
                    }
                }
            }
        }
        self.match_.clear();
        self.b1c.clear();
        self.b1hit.clear();
        self.bctx.clear();
        self.bhist.clear();
        if let Some(ft) = self.bo0.as_mut() {
            ft.reset();
        }
        self.prev = None;
        self.prev2 = None;
        self.w1 = None;
        self.w2 = None;
        self.wlist.clear();
        self.lzp_pos.clear();
        self.lzp_flag.reset();
        self.kindc.clear();
        self.last_kind = 0;
        self.raw_t.reset();
    }

    fn byte1_row(&mut self, pb: u8) -> &mut FT {
        if !self.b1c.contains_key(&pb) {
            let ft = match self.m.byte1_rows.get(&(pb as u64)) {
                Some((syms, ws)) => FT::new(
                    Some(syms.clone()),
                    Some(ws.clone()),
                    0,
                    false,
                    (0, 0),
                    Some(B_ASTEP),
                    None,
                    None,
                ),
                None => FT::new(None, None, 0, false, (0, 0), Some(B_ASTEP), None, None),
            };
            self.b1c.insert(pb, ft);
        }
        self.b1c.get_mut(&pb).unwrap()
    }

    fn byte1_hit_ft(&mut self, pb: u8) -> &mut FT {
        self.b1hit
            .entry(pb)
            .or_insert_with(|| FT::simple(vec![0, 1, 2], vec![W1_O0, W1_ROW, W1_FORCE], 0))
    }

    fn byte_ctx_ft(&mut self, order: u8, key: &[u8]) -> &mut FT {
        let d = self.bctx.entry(order).or_default();
        d.entry(key.to_vec()).or_insert_with(|| {
            FT::new(None, None, B_ESC, false, (0, 0), Some(B_ASTEP), Some(256), None)
        })
    }

    /// Adaptive byte-context chain keys for the current depth; creates rows.
    fn byte_table_keys(&mut self, hist: Option<&[u8]>) -> Vec<(u8, Vec<u8>)> {
        let bm = self.byte_mode;
        let mut keys: Vec<(u8, Vec<u8>)> = Vec::new();
        {
            let h: &[u8] = match hist {
                Some(x) => x,
                None => &self.bhist,
            };
            if bm != Some(2) {
                if (bm.is_none() || bm == Some(0)) && h.len() >= 3 {
                    keys.push((3, vec![h[h.len() - 3], h[h.len() - 2], h[h.len() - 1]]));
                }
                if h.len() >= 2 {
                    keys.push((2, vec![h[h.len() - 2], h[h.len() - 1]]));
                }
            }
        }
        for (order, key) in &keys {
            self.byte_ctx_ft(*order, key);
        }
        keys
    }

    fn byte_o0_ft(&mut self) -> &mut FT {
        if self.bo0.is_none() {
            let bw: Vec<i64> = self.m.st_byte.bw.iter().map(|&w| (w >> 4).max(1)).collect();
            self.bo0 = Some(FT::new(
                Some((0..256).collect()),
                Some(bw),
                0,
                false,
                (0, 0),
                Some(64),
                None,
                Some(3000),
            ));
        }
        self.bo0.as_mut().unwrap()
    }

    fn ctx_ac(&self) -> Option<TabRef> {
        match self.prev? {
            Prev::Word(sym) => {
                if self.m.a.contains_key(&sym) {
                    Some(TabRef::A(sym))
                } else {
                    None
                }
            }
            Prev::Punct(idx) => {
                if self.m.c.contains_key(&(idx as u64)) {
                    Some(TabRef::C(idx))
                } else {
                    None
                }
            }
            Prev::Lit => None,
        }
    }

    fn case_ctx(&self) -> usize {
        match self.prev {
            None => 0,
            Some(Prev::Punct(i)) => {
                let s = &self.m.puncts[i];
                let last = s.trim_end().chars().next_back();
                if matches!(last, Some('.') | Some('!') | Some('?') | Some('…')) {
                    1
                } else {
                    2
                }
            }
            _ => 3,
        }
    }

    // ------------------------------------------------- byte encode/decode

    fn enc_byte(&mut self, enc: &mut RangeEncoder, b: u8) {
        let mut excl: HashSet<i64> = HashSet::new();
        let mut escaped: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut b1_miss: Option<u8> = None;
        let mut done = false;
        let tabs = self.byte_table_keys(None);
        for (order, key) in &tabs {
            let ft = self.bctx.get_mut(order).unwrap().get_mut(key).unwrap();
            if ft.in_table(b as i64, Some(&excl)) {
                let (cum, freq, tot) = ft.find_encode(Some(b as i64), Some(&excl));
                enc.encode(cum, freq, tot);
                ft.adapt(Some(b as i64), false, None);
                done = true;
                break;
            }
            let (cum, freq, tot) = ft.find_encode(None, Some(&excl));
            enc.encode(cum, freq, tot);
            escaped.push((*order, key.clone()));
            escape_excl(ft, &mut excl);
        }
        if !done && !self.bhist.is_empty() && self.byte_mode.is_none() {
            let pb = *self.bhist.last().unwrap();
            let inrow = {
                let row = self.byte1_row(pb);
                row.in_table(b as i64, Some(&excl)) && row.total_excl(Some(&excl)) > 0
            };
            let v: i64 = if inrow {
                let (_, f1, t1) = self.byte1_hit_ft(pb).find_encode(Some(1), None);
                let (_, fr, tr) = self.byte1_row(pb).find_encode(Some(b as i64), Some(&excl));
                let (_, f0, t0) = self.byte1_hit_ft(pb).find_encode(Some(0), None);
                let (_, fo, to) = self.m.st_byte.find_encode(Some(b as i64), Some(&excl));
                let cost_row =
                    (bit_length(t1) - bit_length(f1)) + (bit_length(tr) - bit_length(fr));
                let cost_o0 = (bit_length(t0) - bit_length(f0)) + (bit_length(to) - bit_length(fo));
                if cost_row <= cost_o0 {
                    1
                } else {
                    0
                }
            } else {
                2
            };
            let hit_t = self.byte1_hit_ft(pb);
            let (cum, freq, tot) = hit_t.find_encode(Some(v), None);
            enc.encode(cum, freq, tot);
            hit_t.adapt(Some(v), false, None);
            if v == 1 {
                let row = self.byte1_row(pb);
                let (cum, freq, tot) = row.find_encode(Some(b as i64), Some(&excl));
                enc.encode(cum, freq, tot);
                row.adapt(Some(b as i64), false, None);
                done = true;
            } else if v == 2 {
                b1_miss = Some(pb);
            }
        }
        if !done {
            let empty = self.term_o0_mut().total_excl(Some(&excl)) == 0;
            if empty {
                excl.clear();
            }
            match self.byte_mode {
                None => {
                    let (cum, freq, tot) = self.m.st_byte.find_encode(Some(b as i64), Some(&excl));
                    enc.encode(cum, freq, tot);
                    self.m.st_byte.adapt(Some(b as i64), false, None);
                }
                _ => {
                    let t = self.byte_o0_ft();
                    let (cum, freq, tot) = t.find_encode(Some(b as i64), Some(&excl));
                    enc.encode(cum, freq, tot);
                    t.adapt(Some(b as i64), false, None);
                }
            }
            self.touch(if self.byte_mode.is_none() { TId::Byte } else { TId::Bo0 });
        }
        for (order, key) in escaped {
            let ft = self.bctx.get_mut(&order).unwrap().get_mut(&key).unwrap();
            ft.adapt(None, true, Some(b as i64));
        }
        if let Some(pb) = b1_miss {
            self.byte1_row(pb).adapt(None, true, Some(b as i64));
        }
        self.bhist.push(b);
    }

    fn term_o0_mut(&mut self) -> &mut FT {
        match self.byte_mode {
            None => &mut self.m.st_byte,
            _ => self.byte_o0_ft(),
        }
    }

    fn dec_byte(&mut self, dec: &mut RangeDecoder) -> Result<u8, String> {
        let mut excl: HashSet<i64> = HashSet::new();
        let mut escaped: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut b1_miss: Option<u8> = None;
        let mut sym: Option<i64> = None;
        let tabs = self.byte_table_keys(None);
        for (order, key) in &tabs {
            let ft = self.bctx.get_mut(order).unwrap().get_mut(key).unwrap();
            let tot = ft.total_excl(Some(&excl));
            let cum = dec.start(tot)?;
            let (s, lo, freq) = ft.decode_sym(cum, Some(&excl));
            dec.finish(lo, freq);
            if let Some(s) = s {
                ft.adapt(Some(s), false, None);
                sym = Some(s);
                break;
            }
            escaped.push((*order, key.clone()));
            escape_excl(ft, &mut excl);
        }
        if sym.is_none() && !self.bhist.is_empty() && self.byte_mode.is_none() {
            let pb = *self.bhist.last().unwrap();
            let hit_t = self.byte1_hit_ft(pb);
            let cum = dec.start(hit_t.total())?;
            let (vo, lo, freq) = hit_t.decode_sym(cum, None);
            dec.finish(lo, freq);
            let v = vo.expect("b1hit");
            hit_t.adapt(Some(v), false, None);
            if v == 1 {
                let row = self.byte1_row(pb);
                let tot = row.total_excl(Some(&excl));
                let cum = dec.start(tot)?;
                let (s2, lo, freq) = row.decode_sym(cum, Some(&excl));
                dec.finish(lo, freq);
                row.adapt(s2, false, None);
                sym = s2;
            } else if v == 2 {
                b1_miss = Some(pb);
            }
        }
        let sym: i64 = match sym {
            Some(s) => s,
            None => {
                let empty = self.term_o0_mut().total_excl(Some(&excl)) == 0;
                if empty {
                    excl.clear();
                }
                let s = match self.byte_mode {
                    None => {
                        let tot = self.m.st_byte.total_excl(Some(&excl));
                        let cum = dec.start(tot)?;
                        let (s, lo, freq) = self.m.st_byte.decode_sym(cum, Some(&excl));
                        dec.finish(lo, freq);
                        self.m.st_byte.adapt(s, false, None);
                        self.touch(TId::Byte);
                        s
                    }
                    _ => {
                        let t = self.byte_o0_ft();
                        let tot = t.total_excl(Some(&excl));
                        let cum = dec.start(tot)?;
                        let (s, lo, freq) = t.decode_sym(cum, Some(&excl));
                        dec.finish(lo, freq);
                        t.adapt(s, false, None);
                        self.touch(TId::Bo0);
                        s
                    }
                };
                s.expect("terminal o0 always resolves a byte")
            }
        };
        for (order, key) in escaped {
            let ft = self.bctx.get_mut(&order).unwrap().get_mut(&key).unwrap();
            ft.adapt(None, true, Some(sym));
        }
        if let Some(pb) = b1_miss {
            self.byte1_row(pb).adapt(None, true, Some(sym));
        }
        self.bhist.push(sym as u8);
        Ok(sym as u8)
    }

    // ------------------------------------------------- varint via byte chain

    fn enc_varint(&mut self, enc: &mut RangeEncoder, n: u64) {
        let mut buf = Vec::new();
        put_varint(&mut buf, n);
        for b in buf {
            self.enc_byte(enc, b);
        }
    }

    fn dec_varint(&mut self, dec: &mut RangeDecoder) -> Result<u64, String> {
        let mut v: u64 = 0;
        let mut sh = 0u32;
        loop {
            let b = self.dec_byte(dec)?;
            v |= ((b & 0x7F) as u64) << sh;
            sh += 7;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
    }

    // ------------------------------------------------- literal runs

    fn enc_lit(&mut self, enc: &mut RangeEncoder, data: &[u8]) {
        let mut i = 0usize;
        while i < data.len() {
            let k = data.len() - i;
            let (end, s) = if k > 63 {
                (i + 63, 62i64)
            } else if k == 63 {
                (i + 63, 63)
            } else {
                (i + k, k as i64 - 1)
            };
            let (cum, freq, tot) = self.m.st_len.find_encode(Some(s), None);
            enc.encode(cum, freq, tot);
            self.m.st_len.adapt(Some(s), false, None);
            self.touch(TId::Len);
            for j in i..end {
                self.enc_byte(enc, data[j]);
            }
            i = end;
        }
    }

    fn dec_lit(&mut self, dec: &mut RangeDecoder) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        loop {
            let tot = self.m.st_len.total();
            let cum = dec.start(tot)?;
            let (s, lo, freq) = self.m.st_len.decode_sym(cum, None);
            dec.finish(lo, freq);
            let s = s.expect("st_len");
            self.m.st_len.adapt(Some(s), false, None);
            self.touch(TId::Len);
            let n = if s >= 62 { 63 } else { s + 1 };
            for _ in 0..n {
                out.push(self.dec_byte(dec)?);
            }
            if s != 62 {
                return Ok(out);
            }
        }
    }

    fn enc_case(&mut self, enc: &mut RangeEncoder, flag: i64, ctx: usize) {
        let (cum, freq, tot) = self.m.st_case[ctx].find_encode(Some(flag), None);
        enc.encode(cum, freq, tot);
        self.m.st_case[ctx].adapt(Some(flag), false, None);
        self.touch(TId::Case(ctx));
    }

    fn dec_case(&mut self, dec: &mut RangeDecoder, ctx: usize) -> Result<i64, String> {
        let tot = self.m.st_case[ctx].total();
        let cum = dec.start(tot)?;
        let (s, lo, freq) = self.m.st_case[ctx].decode_sym(cum, None);
        dec.finish(lo, freq);
        let s = s.expect("st_case");
        self.m.st_case[ctx].adapt(Some(s), false, None);
        self.touch(TId::Case(ctx));
        Ok(s)
    }

    // ------------------------------------------------- integer cost estimates

    fn est_bits(acc: &mut i64, _cum: i64, freq: i64, tot: i64) {
        if freq > 0 {
            *acc += (bit_length(tot) - bit_length(freq)) * 256;
        }
    }

    /// Estimate of coding sym in ft; false = escape (excl is extended).
    fn est_ft(acc: &mut i64, ft: &FT, sym: i64, excl: &mut HashSet<i64>) -> bool {
        if ft.in_table(sym, Some(excl)) {
            let (cum, freq, tot) = ft.find_encode(Some(sym), Some(excl));
            Self::est_bits(acc, cum, freq, tot);
            true
        } else {
            let (cum, freq, tot) = ft.find_encode(None, Some(excl));
            Self::est_bits(acc, cum, freq, tot);
            escape_excl(ft, excl);
            false
        }
    }

    fn est_ft_o0(acc: &mut i64, ft: &FenwickO0, sym: i64, excl: &mut HashSet<i64>) -> bool {
        if ft.in_table(sym, Some(excl)) {
            let (cum, freq, tot) = ft.find_encode(sym, Some(excl));
            Self::est_bits(acc, cum, freq, tot);
            true
        } else {
            let (cum, freq, tot) = ft.find_encode(ESC_RANK, Some(excl));
            Self::est_bits(acc, cum, freq, tot);
            false
        }
    }

    fn est_byte(&mut self, b: u8, hist: &[u8]) -> i64 {
        let mut acc = 0i64;
        let mut excl: HashSet<i64> = HashSet::new();
        let mut hit = false;
        let tabs = self.byte_table_keys(Some(hist));
        for (order, key) in &tabs {
            let ft = self.bctx.get_mut(order).unwrap().get_mut(key).unwrap();
            if Self::est_ft(&mut acc, ft, b as i64, &mut excl) {
                hit = true;
                break;
            }
        }
        if !hit && !hist.is_empty() {
            let pb = hist[hist.len() - 1];
            let inrow = {
                let row = self.byte1_row(pb);
                row.in_table(b as i64, Some(&excl)) && row.total_excl(Some(&excl)) > 0
            };
            let empty = self.term_o0_mut().total_excl(Some(&excl)) == 0;
            if empty {
                excl.clear();
            }
            let (co, fo, to) = match self.byte_mode {
                None => self.m.st_byte.find_encode(Some(b as i64), Some(&excl)),
                _ => {
                    let t = self.byte_o0_ft();
                    t.find_encode(Some(b as i64), Some(&excl))
                }
            };
            let v: i64 = if inrow {
                let (_, fr, tr) = self.byte1_row(pb).find_encode(Some(b as i64), Some(&excl));
                let (_, f1, t1) = self.byte1_hit_ft(pb).find_encode(Some(1), None);
                let (_, f0, t0) = self.byte1_hit_ft(pb).find_encode(Some(0), None);
                let cost_row =
                    (bit_length(t1) - bit_length(f1)) + (bit_length(tr) - bit_length(fr));
                let cost_o0 = (bit_length(t0) - bit_length(f0)) + (bit_length(to) - bit_length(fo));
                if cost_row <= cost_o0 {
                    1
                } else {
                    0
                }
            } else {
                2
            };
            let (cv, fv, tv) = self.byte1_hit_ft(pb).find_encode(Some(v), None);
            Self::est_bits(&mut acc, cv, fv, tv);
            if v == 1 {
                let (cr, fr, tr) = self.byte1_row(pb).find_encode(Some(b as i64), Some(&excl));
                Self::est_bits(&mut acc, cr, fr, tr);
            } else {
                Self::est_bits(&mut acc, co, fo, to);
            }
        } else if !hit {
            let empty = self.term_o0_mut().total_excl(Some(&excl)) == 0;
            if empty {
                excl.clear();
            }
            let (cum, freq, tot) = match self.byte_mode {
                None => self.m.st_byte.find_encode(Some(b as i64), Some(&excl)),
                _ => {
                    let t = self.byte_o0_ft();
                    t.find_encode(Some(b as i64), Some(&excl))
                }
            };
            Self::est_bits(&mut acc, cum, freq, tot);
        }
        acc
    }

    fn est_varint(&mut self, n: u64, hist: &mut Vec<u8>) -> i64 {
        let mut buf = Vec::new();
        put_varint(&mut buf, n);
        let mut acc = 0i64;
        for b in buf {
            acc += self.est_byte(b, hist);
            hist.push(b);
        }
        if std::env::var_os("SZGC_TRACE").is_some() {
            eprintln!("V est_varint({}) hist0={} -> {}", n, hexs(hist), acc);
        }
        acc
    }


    fn est_chain(&mut self, sym: i64, flag: i64, pred: Option<u64>, r: u64) -> i64 {
        let mut acc = 0i64;
        let mut excl: HashSet<i64> = HashSet::new();
        if let Some(p) = pred {
            let (cum, freq, tot) = self.lzp_flag.find_encode(Some(0), None);
            Self::est_bits(&mut acc, cum, freq, tot);
            excl.insert(p as i64);
        }
        let mut hit = false;
        for tab in self.word_table_keys() {
            let res = match tab {
                WTab::Match(pair) => match self.match_.get(&pair) {
                    Some(ft) => Self::est_ft(&mut acc, ft, sym, &mut excl),
                    None => false,
                },
                WTab::B2(pair) => match self.m.b2.get(&pair) {
                    Some(ft) => Self::est_ft(&mut acc, ft, sym, &mut excl),
                    None => false,
                },
                WTab::B1(k) => match self.m.b1.get(&k) {
                    Some(ft) => Self::est_ft(&mut acc, ft, sym, &mut excl),
                    None => false,
                },
                WTab::C(idx) => match self.m.c.get(&(idx as u64)) {
                    Some(ft) => Self::est_ft(&mut acc, ft, sym, &mut excl),
                    None => false,
                },
                WTab::Lem(li) => match self.m.lem.get(&li) {
                    Some(ft) => Self::est_ft(&mut acc, ft, sym, &mut excl),
                    None => false,
                },
            };
            if res {
                hit = true;
                break;
            }
        }
        if !hit && !Self::est_ft_o0(&mut acc, &self.m.st_o0, sym, &mut excl) {
            // cost is intentionally not counted (state-warming call, mirror of Python)
            let mut h = self.bhist.clone();
            self.est_varint(r, &mut h);
        }
        let ctx = self.case_ctx();
        let (cum, freq, tot) = self.m.st_case[ctx].find_encode(Some(flag), None);
        Self::est_bits(&mut acc, cum, freq, tot);
        acc
    }

    fn est_raw(&mut self, data: &[u8]) -> i64 {
        if data.len() == 1 {
            let h = self.bhist.clone();
            return self.est_byte(data[0], &h);
        }
        let mut acc = 0i64;
        let mut hist = self.bhist.clone();
        let mut i = 0usize;
        while i < data.len() {
            let k = data.len() - i;
            let (end, s) = if k > 63 {
                (i + 63, 62i64)
            } else if k == 63 {
                (i + 63, 63)
            } else {
                (i + k, k as i64 - 1)
            };
            let (cum, freq, tot) = self.m.st_len.find_encode(Some(s), None);
            Self::est_bits(&mut acc, cum, freq, tot);
            for j in i..end {
                acc += self.est_byte(data[j], &hist);
                hist.push(data[j]);
            }
            i = end;
        }
        acc
    }

    fn est_punct(&mut self, pidx: usize) -> i64 {
        let mut acc = 0i64;
        let mut hit = false;
        match self.ctx_ac() {
            Some(TabRef::A(sym)) => {
                if let Some(ft) = self.m.a.get(&sym) {
                    hit = Self::est_ft(&mut acc, ft, pidx as i64, &mut HashSet::new());
                }
            }
            Some(TabRef::C(idx)) => {
                if let Some(ft) = self.m.c.get(&(idx as u64)) {
                    hit = Self::est_ft(&mut acc, ft, pidx as i64, &mut HashSet::new());
                }
            }
            None => {}
        }
        if !hit {
            let (cum, freq, tot) = self.m.st_o0.find_encode(pidx as i64, None);
            Self::est_bits(&mut acc, cum, freq, tot);
        }
        acc
    }

    // ------------------------------------------------------- word tables

    fn word_table_keys(&self) -> Vec<WTab> {
        let m = &*self.m;
        let mut tabs = Vec::new();
        if let (Some(w1), Some(w2)) = (self.w1, self.w2) {
            let pair = (w2 << PAIR_SHIFT) | w1;
            if self.match_.contains_key(&pair) {
                tabs.push(WTab::Match(pair));
            }
            if m.b2.contains_key(&pair) {
                tabs.push(WTab::B2(pair));
            }
        }
        if let Some(Prev::Punct(idx)) = self.prev {
            if m.puncts[idx] == " " {
                if let Some(w1) = self.w1 {
                    if m.b1.contains_key(&w1) {
                        tabs.push(WTab::B1(w1));
                    }
                }
            } else if m.c.contains_key(&(idx as u64)) {
                tabs.push(WTab::C(idx));
            }
        }
        if let Some(w1) = self.w1 {
            let li = m.lemma_ids[(w1 as usize) - m.p];
            if m.lem.contains_key(&li) {
                tabs.push(WTab::Lem(li));
            }
        }
        tabs
    }

    fn lzp_predicted(&self) -> Option<u64> {
        let w1 = self.w1?;
        let w2 = self.w2?;
        let pair = (w2 << PAIR_SHIFT) | w1;
        let j = *self.lzp_pos.get(&pair)?;
        self.wlist.get(j).copied()
    }

    fn lzp_register(&mut self, sym: u64) {
        if let (Some(w1), Some(w2)) = (self.w1, self.w2) {
            let pair = (w2 << PAIR_SHIFT) | w1;
            self.lzp_pos.insert(pair, self.wlist.len());
        }
        self.wlist.push(sym);
    }

    fn enc_lzp_hit(&mut self, enc: &mut RangeEncoder) {
        let (cum, freq, tot) = self.lzp_flag.find_encode(Some(1), None);
        enc.encode(cum, freq, tot);
        self.lzp_flag.adapt(Some(1), false, None);
    }

    fn enc_lzp_miss(&mut self, enc: &mut RangeEncoder) {
        let (cum, freq, tot) = self.lzp_flag.find_encode(Some(0), None);
        enc.encode(cum, freq, tot);
        self.lzp_flag.adapt(Some(0), false, None);
    }

    fn dec_lzp(&mut self, dec: &mut RangeDecoder) -> Result<bool, String> {
        let tot = self.lzp_flag.total();
        let cum = dec.start(tot)?;
        let (s, lo, freq) = self.lzp_flag.decode_sym(cum, None);
        dec.finish(lo, freq);
        let s = s.expect("lzp_flag");
        self.lzp_flag.adapt(Some(s), false, None);
        Ok(s == 1)
    }

    fn after_word(&mut self, sym: u64) {
        if let (Some(w1), Some(w2)) = (self.w1, self.w2) {
            let pair = (w2 << PAIR_SHIFT) | w1;
            let known = match self.match_.get(&pair) {
                Some(mft) => !mft.bs.is_empty() && mft.bs[0] == sym as i64,
                None => false,
            };
            if known {
                let mft = self.match_.get_mut(&pair).unwrap();
                mft.adapt(Some(sym as i64), false, None);
            } else {
                self.match_
                    .insert(pair, FT::simple(vec![sym as i64], vec![W_MATCH], ESC_MATCH));
            }
        }
        self.w2 = self.w1;
        self.w1 = Some(sym);
        self.prev2 = self.prev;
        self.prev = Some(Prev::Word(sym));
    }

    fn adapt_insert(&mut self, id: TId, sym: i64) {
        match id {
            TId::B1(k) => self.m.b1.get_mut(&k).unwrap().adapt(None, true, Some(sym)),
            TId::B2(k) => self.m.b2.get_mut(&k).unwrap().adapt(None, true, Some(sym)),
            TId::Lem(k) => self.m.lem.get_mut(&k).unwrap().adapt(None, true, Some(sym)),
            TId::A(k) => self.m.a.get_mut(&k).unwrap().adapt(None, true, Some(sym)),
            TId::C(k) => self.m.c.get_mut(&k).unwrap().adapt(None, true, Some(sym)),
            _ => unreachable!(),
        }
    }

    // ------------------------------------------------------------ encode

    pub fn encode(&mut self, text: &str) -> Vec<u8> {
        let mut best_tag: u8 = 2;
        let mut best_buf = self.encode_tokens(text);
        for mode in 0u8..3 {
            let buf = self.encode_bytes_mode(text, mode);
            if buf.len() < best_buf.len() {
                best_tag = 3 + mode;
                best_buf = buf;
            }
        }
        let mut out = Vec::with_capacity(best_buf.len() + 1);
        out.push(best_tag);
        out.extend_from_slice(&best_buf);
        out
    }

    fn enc_raw_flag(&mut self, enc: &mut RangeEncoder, v: i64) {
        let (cum, freq, tot) = self.raw_t.find_encode(Some(v), None);
        enc.encode(cum, freq, tot);
        self.raw_t.adapt(Some(v), false, None);
    }

    fn kind_ft(&mut self) -> &mut FT {
        self.kindc.entry(self.last_kind).or_insert_with(|| {
            FT::simple(vec![0, 1, 2, 3, 4], vec![650, 260, 90, 24, 40], 0)
        })
    }

    fn enc_kind(&mut self, enc: &mut RangeEncoder, k: i64) {
        let (cum, freq, tot) = self.kind_ft().find_encode(Some(k), None);
        enc.encode(cum, freq, tot);
        self.kind_ft().adapt(Some(k), false, None);
        self.last_kind = k;
    }

    fn encode_tokens(&mut self, text: &str) -> Vec<u8> {
        self.fresh();
        self.byte_mode = None;
        let mut enc = RangeEncoder::new();
        let punct_idx: HashMap<String, usize> = self
            .m
            .puncts
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, p)| (p, i))
            .collect();
        let toks = tokenize(text);
        for tok in toks {
            match tok {
                Tok::Word(w) => {
                    let low = w.to_lowercase();
                    let r = self.m.rank.get(&low).copied();
                    let flag = get_case(&w);
                    let ok = match r {
                        Some(r) => flag != 3 && apply_case(&self.m.words[r as usize], flag) == w,
                        None => false,
                    };
                    if ok {
                        let r = r.unwrap();
                        self.enc_kind(&mut enc, 0);
                        let sym = self.m.p as u64 + r as u64;
                        let pred = self.lzp_predicted();
                        let hit = pred == Some(sym);
                        if pred.is_some() {
                            if hit {
                                self.enc_lzp_hit(&mut enc);
                            } else {
                                self.enc_lzp_miss(&mut enc);
                            }
                        }
                        if hit {
                            let ctx = self.case_ctx();
                            self.enc_case(&mut enc, flag, ctx);
                            self.lzp_register(sym);
                            self.after_word(sym);
                            self.bhist.extend_from_slice(w.as_bytes());
                            continue;
                        }
                        let tb = w.as_bytes().to_vec();
                        let use_chain = self.est_chain(sym as i64, flag, pred, r as u64)
                            <= self.est_raw(&tb);
                        if !use_chain {
                            if tb.len() == 1 {
                                self.enc_raw_flag(&mut enc, 0);
                                self.enc_byte(&mut enc, tb[0]);
                            } else {
                                self.enc_raw_flag(&mut enc, 2);
                                self.enc_lit(&mut enc, &tb);
                            }
                            self.lzp_register(sym);
                            self.after_word(sym);
                            continue;
                        }
                        self.enc_raw_flag(&mut enc, 1);
                        let mut excl: HashSet<i64> = HashSet::new();
                        if let Some(p) = pred {
                            excl.insert(p as i64);
                        }
                        let mut escaped: Vec<TabId> = Vec::new();
                        let mut done = false;
                        for tab in self.word_table_keys() {
                            let esc_now;
                            match tab {
                                WTab::Match(pair) => {
                                    let ft = self.match_.get_mut(&pair).unwrap();
                                    let got =
                                        enc_word_tab(&mut enc, ft, sym as i64, &mut excl);
                                    done = got;
                                    esc_now = !got;
                                    if esc_now {
                                        escaped.push(TabId::Match(pair));
                                    }
                                }
                                WTab::B2(pair) => {
                                    let ft = self.m.b2.get_mut(&pair).unwrap();
                                    let got =
                                        enc_word_tab(&mut enc, ft, sym as i64, &mut excl);
                                    self.touch(TId::B2(pair));
                                    done = got;
                                    esc_now = !got;
                                    if esc_now {
                                        escaped.push(TabId::Model(TId::B2(pair)));
                                    }
                                }
                                WTab::B1(k) => {
                                    let ft = self.m.b1.get_mut(&k).unwrap();
                                    let got =
                                        enc_word_tab(&mut enc, ft, sym as i64, &mut excl);
                                    self.touch(TId::B1(k));
                                    done = got;
                                    esc_now = !got;
                                    if esc_now {
                                        escaped.push(TabId::Model(TId::B1(k)));
                                    }
                                }
                                WTab::C(idx) => {
                                    let ft = self.m.c.get_mut(&(idx as u64)).unwrap();
                                    let got =
                                        enc_word_tab(&mut enc, ft, sym as i64, &mut excl);
                                    self.touch(TId::C(idx as u64));
                                    done = got;
                                    esc_now = !got;
                                    if esc_now {
                                        escaped.push(TabId::Model(TId::C(idx as u64)));
                                    }
                                }
                                WTab::Lem(li) => {
                                    let ft = self.m.lem.get_mut(&li).unwrap();
                                    let got =
                                        enc_word_tab(&mut enc, ft, sym as i64, &mut excl);
                                    self.touch(TId::Lem(li));
                                    done = got;
                                    esc_now = !got;
                                    if esc_now {
                                        escaped.push(TabId::Model(TId::Lem(li)));
                                    }
                                }
                            }
                            if done {
                                break;
                            }
                        }
                        if !done {
                            let in_o0 = self.m.st_o0.bset.contains(&(sym as i64))
                                && !excl.contains(&(sym as i64));
                            if in_o0 {
                                let (cum, freq, tot) =
                                    self.m.st_o0.find_encode(sym as i64, Some(&excl));
                                enc.encode(cum, freq, tot);
                                self.m.st_o0.adapt(sym as i64);
                            } else {
                                let (cum, freq, tot) =
                                    self.m.st_o0.find_encode(ESC_RANK, Some(&excl));
                                enc.encode(cum, freq, tot);
                                self.m.st_o0.adapt(ESC_RANK);
                                self.enc_varint(&mut enc, r as u64);
                            }
                            self.touch(TId::O0);
                        }
                        for t in escaped {
                            match t {
                                TabId::Match(pair) => {
                                    let ft = self.match_.get_mut(&pair).unwrap();
                                    ft.adapt(None, true, Some(sym as i64));
                                }
                                TabId::Model(id) => self.adapt_insert(id, sym as i64),
                            }
                        }
                        let ctx = self.case_ctx();
                        self.enc_case(&mut enc, flag, ctx);
                        self.lzp_register(sym);
                        self.after_word(sym);
                        self.bhist.extend_from_slice(w.as_bytes());
                    } else {
                        let tb = w.as_bytes();
                        if tb.len() == 1 {
                            self.enc_kind(&mut enc, 2);
                            self.enc_byte(&mut enc, tb[0]);
                        } else {
                            self.enc_kind(&mut enc, 4);
                            self.enc_lit(&mut enc, tb);
                        }
                        self.prev2 = self.prev;
                        self.prev = Some(Prev::Lit);
                    }
                }
                Tok::Lit(tok) => {
                    let pidx = punct_idx.get(&tok).copied();
                    match pidx {
                        Some(pidx) => {
                            self.enc_kind(&mut enc, 1);
                            let tb = tok.as_bytes().to_vec();
                            let use_st = self.est_punct(pidx) <= self.est_raw(&tb);
                            if !use_st {
                                if tb.len() == 1 {
                                    self.enc_raw_flag(&mut enc, 0);
                                    self.enc_byte(&mut enc, tb[0]);
                                } else {
                                    self.enc_raw_flag(&mut enc, 2);
                                    self.enc_lit(&mut enc, &tb);
                                }
                                self.prev2 = self.prev;
                                self.prev = Some(Prev::Punct(pidx));
                                continue;
                            }
                            self.enc_raw_flag(&mut enc, 1);
                            let mut done = false;
                            match self.ctx_ac() {
                                Some(TabRef::A(a_key)) => {
                                    self.touch(TId::A(a_key));
                                    let ft = self.m.a.get_mut(&a_key).unwrap();
                                    if ft.in_table(pidx as i64, None) {
                                        let (cum, freq, tot) =
                                            ft.find_encode(Some(pidx as i64), None);
                                        enc.encode(cum, freq, tot);
                                        ft.adapt(Some(pidx as i64), false, None);
                                        done = true;
                                    } else {
                                        let (cum, freq, tot) = ft.find_encode(None, None);
                                        enc.encode(cum, freq, tot);
                                        ft.adapt(None, false, None);
                                    }
                                }
                                Some(TabRef::C(idx)) => {
                                    self.touch(TId::C(idx as u64));
                                    let ft = self.m.c.get_mut(&(idx as u64)).unwrap();
                                    if ft.in_table(pidx as i64, None) {
                                        let (cum, freq, tot) =
                                            ft.find_encode(Some(pidx as i64), None);
                                        enc.encode(cum, freq, tot);
                                        ft.adapt(Some(pidx as i64), false, None);
                                        done = true;
                                    } else {
                                        let (cum, freq, tot) = ft.find_encode(None, None);
                                        enc.encode(cum, freq, tot);
                                        ft.adapt(None, false, None);
                                    }
                                }
                                None => {}
                            }
                            if !done {
                                let (cum, freq, tot) =
                                    self.m.st_o0.find_encode(pidx as i64, None);
                                enc.encode(cum, freq, tot);
                                self.m.st_o0.adapt(pidx as i64);
                                self.touch(TId::O0);
                            }
                            self.prev2 = self.prev;
                            self.prev = Some(Prev::Punct(pidx));
                            self.bhist.extend_from_slice(tok.as_bytes());
                        }
                        None => {
                            let tb = tok.as_bytes();
                            if tb.len() == 1 {
                                self.enc_kind(&mut enc, 2);
                                self.enc_byte(&mut enc, tb[0]);
                            } else {
                                self.enc_kind(&mut enc, 4);
                                self.enc_lit(&mut enc, tb);
                            }
                            self.prev2 = self.prev;
                            self.prev = Some(Prev::Lit);
                        }
                    }
                }
            }
        }
        self.enc_kind(&mut enc, 3);
        enc.flush()
    }

    fn encode_bytes_mode(&mut self, text: &str, mode: u8) -> Vec<u8> {
        self.fresh();
        self.byte_mode = Some(mode);
        let mut enc = RangeEncoder::new();
        let data = text.as_bytes().to_vec();
        self.enc_varint(&mut enc, data.len() as u64);
        for b in data {
            self.enc_byte(&mut enc, b);
        }
        enc.flush()
    }

    // ------------------------------------------------------------ decode

    pub fn decode(&mut self, data: &[u8]) -> Result<String, String> {
        if data.is_empty() {
            return Err("empty stream".into());
        }
        if (3..=5).contains(&data[0]) {
            return self.decode_bytes(&data[1..], data[0] - 3);
        }
        if data[0] != FMT_TAG {
            return Err("bad header".into());
        }
        self.fresh();
        self.byte_mode = None;
        let mut dec = RangeDecoder::new(&data[1..]);
        let punct_idx: HashMap<String, usize> = self
            .m
            .puncts
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, p)| (p, i))
            .collect();
        let mut out: Vec<String> = Vec::new();
        loop {
            if dec.p > dec.d.len() + 16 {
                return Err("stream exhausted (desync)".into());
            }
            let k = self.dec_kind(&mut dec)?;
            if k == 3 {
                break;
            }
            if k == 0 {
                let pred = self.lzp_predicted();
                let mut excl: HashSet<i64> = HashSet::new();
                let mut escaped: Vec<TabId> = Vec::new();
                let mut r_dec: Option<u64> = None;
                if let Some(p) = pred {
                    if self.dec_lzp(&mut dec)? {
                        let ctx = self.case_ctx();
                        let flag = self.dec_case(&mut dec, ctx)?;
                        let w = apply_case(&self.m.words[(p - self.m.p as u64) as usize], flag);
                        out.push(w.clone());
                        self.bhist.extend_from_slice(w.as_bytes());
                        self.lzp_register(p);
                        self.after_word(p);
                        continue;
                    }
                    excl.insert(p as i64);
                }
                let v = self.dec_raw_sym(&mut dec)?;
                if v != 1 {
                    let s = if v == 0 {
                        let b = self.dec_byte(&mut dec)?;
                        String::from_utf8(vec![b]).map_err(|_| "invalid utf-8")?
                    } else {
                        let lit = self.dec_lit(&mut dec)?;
                        String::from_utf8(lit).map_err(|_| "invalid utf-8")?
                    };
                    out.push(s.clone());
                    let r2 = self.m.rank.get(&s.to_lowercase()).copied();
                    if let Some(r2) = r2 {
                        let sym2 = self.m.p as u64 + r2 as u64;
                        self.lzp_register(sym2);
                        self.after_word(sym2);
                    }
                    continue;
                }
                let mut found: Option<i64> = None;
                for tab in self.word_table_keys() {
                    let esc_now;
                    match tab {
                        WTab::Match(pair) => {
                            let ft = self.match_.get_mut(&pair).unwrap();
                            found = dec_word_tab(&mut dec, ft, &mut excl)?;
                            esc_now = found.is_none();
                            if esc_now {
                                escaped.push(TabId::Match(pair));
                            }
                        }
                        WTab::B2(pair) => {
                            self.touch(TId::B2(pair));
                            let ft = self.m.b2.get_mut(&pair).unwrap();
                            found = dec_word_tab(&mut dec, ft, &mut excl)?;
                            esc_now = found.is_none();
                            if esc_now {
                                escaped.push(TabId::Model(TId::B2(pair)));
                            }
                        }
                        WTab::B1(k) => {
                            self.touch(TId::B1(k));
                            let ft = self.m.b1.get_mut(&k).unwrap();
                            found = dec_word_tab(&mut dec, ft, &mut excl)?;
                            esc_now = found.is_none();
                            if esc_now {
                                escaped.push(TabId::Model(TId::B1(k)));
                            }
                        }
                        WTab::C(idx) => {
                            self.touch(TId::C(idx as u64));
                            let ft = self.m.c.get_mut(&(idx as u64)).unwrap();
                            found = dec_word_tab(&mut dec, ft, &mut excl)?;
                            esc_now = found.is_none();
                            if esc_now {
                                escaped.push(TabId::Model(TId::C(idx as u64)));
                            }
                        }
                        WTab::Lem(li) => {
                            self.touch(TId::Lem(li));
                            let ft = self.m.lem.get_mut(&li).unwrap();
                            found = dec_word_tab(&mut dec, ft, &mut excl)?;
                            esc_now = found.is_none();
                            if esc_now {
                                escaped.push(TabId::Model(TId::Lem(li)));
                            }
                        }
                    }
                    if found.is_some() {
                        break;
                    }
                }
                if found.is_none() {
                    let tot = self.m.st_o0.total_excl(Some(&excl));
                    let cum = dec.start(tot)?;
                    let (s, lo, freq) = self.m.st_o0.decode_sym(cum, Some(&excl));
                    dec.finish(lo, freq);
                    self.touch(TId::O0);
                    if s == ESC_RANK {
                        self.m.st_o0.adapt(ESC_RANK);
                        let r = self.dec_varint(&mut dec)?;
                        r_dec = Some(r);
                        found = Some(self.m.p as i64 + r as i64);
                    } else {
                        self.m.st_o0.adapt(s);
                        found = Some(s);
                    }
                }
                let sym = found.unwrap() as u64;
                for t in escaped {
                    match t {
                        TabId::Match(pair) => {
                            let ft = self.match_.get_mut(&pair).unwrap();
                            ft.adapt(None, true, Some(sym as i64));
                        }
                        TabId::Model(id) => self.adapt_insert(id, sym as i64),
                    }
                }
                self.lzp_register(sym);
                let ctx = self.case_ctx();
                let flag = self.dec_case(&mut dec, ctx)?;
                let w = match r_dec {
                    Some(r) => apply_case(&self.m.words[r as usize], flag),
                    None => apply_case(
                        &self.m.words[(sym - self.m.p as u64) as usize],
                        flag,
                    ),
                };
                out.push(w.clone());
                self.bhist.extend_from_slice(w.as_bytes());
                self.after_word(sym);
            } else if k == 1 {
                let v = self.dec_raw_sym(&mut dec)?;
                if v != 1 {
                    let s = if v == 0 {
                        let b = self.dec_byte(&mut dec)?;
                        String::from_utf8(vec![b]).map_err(|_| "invalid utf-8")?
                    } else {
                        let lit = self.dec_lit(&mut dec)?;
                        String::from_utf8(lit).map_err(|_| "invalid utf-8")?
                    };
                    out.push(s.clone());
                    match punct_idx.get(&s) {
                        Some(&pidx2) => {
                            self.prev2 = self.prev;
                            self.prev = Some(Prev::Punct(pidx2));
                        }
                        None => {
                            self.prev2 = self.prev;
                            self.prev = Some(Prev::Lit);
                        }
                    }
                    continue;
                }
                let mut sym: Option<i64> = None;
                match self.ctx_ac() {
                    Some(TabRef::A(a_key)) => {
                        self.touch(TId::A(a_key));
                        let ft = self.m.a.get_mut(&a_key).unwrap();
                        let tot = ft.total();
                        let cum = dec.start(tot)?;
                        let (s, lo, freq) = ft.decode_sym(cum, None);
                        dec.finish(lo, freq);
                        match s {
                            Some(s) => {
                                ft.adapt(Some(s), false, None);
                                sym = Some(s);
                            }
                            None => ft.adapt(None, false, None),
                        }
                    }
                    Some(TabRef::C(idx)) => {
                        self.touch(TId::C(idx as u64));
                        let ft = self.m.c.get_mut(&(idx as u64)).unwrap();
                        let tot = ft.total();
                        let cum = dec.start(tot)?;
                        let (s, lo, freq) = ft.decode_sym(cum, None);
                        dec.finish(lo, freq);
                        match s {
                            Some(s) => {
                                ft.adapt(Some(s), false, None);
                                sym = Some(s);
                            }
                            None => ft.adapt(None, false, None),
                        }
                    }
                    None => {}
                }
                let sym: i64 = match sym {
                    Some(s) => s,
                    None => {
                        let tot = self.m.st_o0.total();
                        let cum = dec.start(tot)?;
                        let (s, lo, freq) = self.m.st_o0.decode_sym(cum, None);
                        dec.finish(lo, freq);
                        self.m.st_o0.adapt(s);
                        self.touch(TId::O0);
                        s
                    }
                };
                let p = self.m.puncts[sym as usize].clone();
                out.push(p.clone());
                self.prev2 = self.prev;
                self.prev = Some(Prev::Punct(sym as usize));
                self.bhist.extend_from_slice(p.as_bytes());
            } else if k == 2 {
                let b = self.dec_byte(&mut dec)?;
                out.push(String::from_utf8(vec![b]).map_err(|_| "invalid utf-8")?);
                self.prev2 = self.prev;
                self.prev = Some(Prev::Lit);
            } else {
                let lit = self.dec_lit(&mut dec)?;
                let s = String::from_utf8(lit).map_err(|_| "invalid utf-8")?;
                out.push(s);
                self.prev2 = self.prev;
                self.prev = Some(Prev::Lit);
            }
        }
        Ok(out.concat())
    }

    fn dec_kind(&mut self, dec: &mut RangeDecoder) -> Result<i64, String> {
        let t = self.kind_ft();
        let tot = t.total();
        let cum = dec.start(tot)?;
        let (s, lo, freq) = t.decode_sym(cum, None);
        dec.finish(lo, freq);
        let s = s.expect("kind");
        t.adapt(Some(s), false, None);
        self.last_kind = s;
        Ok(s)
    }

    fn dec_raw_sym(&mut self, dec: &mut RangeDecoder) -> Result<i64, String> {
        let tot = self.raw_t.total();
        let cum = dec.start(tot)?;
        let (s, lo, freq) = self.raw_t.decode_sym(cum, None);
        dec.finish(lo, freq);
        let s = s.expect("raw_t");
        self.raw_t.adapt(Some(s), false, None);
        Ok(s)
    }

    fn decode_bytes(&mut self, data: &[u8], mode: u8) -> Result<String, String> {
        self.fresh();
        self.byte_mode = Some(mode);
        let mut dec = RangeDecoder::new(data);
        let n = self.dec_varint(&mut dec)?;
        let mut out = Vec::with_capacity(n as usize);
        for _ in 0..n {
            out.push(self.dec_byte(&mut dec)?);
        }
        String::from_utf8(out).map_err(|_| "invalid utf-8".into())
    }
}
