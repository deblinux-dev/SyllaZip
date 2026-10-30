//! SZGC CLI: compress / decompress / batch / bench / selftest.
//! Model is embedded at build time; --model PATH overrides it.

use std::io::{Read, Write};
use std::time::Instant;

use szgc::core::Model;
use szgc::jsonutil::{escape_string, JVal};

fn args() -> Vec<String> {
    std::env::args().collect()
}

fn usage() -> ! {
    eprintln!("SZGC — морфографовый предиктивный кодек");
    eprintln!("использование:");
    eprintln!("  szgc c <input> [output]     сжать текстовый файл (stdout, если нет output)");
    eprintln!("  szgc d <input> [output]     распаковать");
    eprintln!("  szgc t \"текст\"              сжать строку аргумента, hex в stdout");
    eprintln!("  szgc batch <texts.json>     сжать массив строк, JSON-массив hex в stdout");
    eprintln!("  szgc batchdec <hex.json>    распаковать JSON-массив hex, JSON-массив строк");
    eprintln!("  szgc bench [texts.json]     таблица размеров (SZGC)");
    eprintln!("  szgc selftest [n]           векторы + round-trip + fuzz");
    eprintln!("  szgc model-info             статистика модели");
    eprintln!("опции: --model PATH (по умолчанию встроенная модель)");
    std::process::exit(2);
}

fn find_arg(flag: &str) -> Option<String> {
    let a = args();
    a.iter()
        .position(|x| x == flag)
        .and_then(|i| a.get(i + 1).cloned())
}

fn build_model() -> Model {
    let t0 = Instant::now();
    let m = match find_arg("--model") {
        Some(path) => {
            let data = std::fs::read(&path).unwrap_or_else(|e| {
                eprintln!("не удалось прочитать модель {}: {}", path, e);
                std::process::exit(1);
            });
            Model::from_bytes(&data).unwrap_or_else(|e| {
                eprintln!("{}", e);
                std::process::exit(1);
            })
        }
        None => Model::from_bytes(szgc::EMBEDDED_MODEL).expect("embedded model"),
    };
    eprintln!(
        "модель: {} слов, {} пунктуаций, {:.1} МБ ({:.2?})",
        m.d,
        m.p,
        szgc::EMBEDDED_MODEL.len() as f64 / 1048576.0,
        t0.elapsed()
    );
    m
}

fn hex(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn main() {
    let a = args();
    if a.len() < 2 {
        usage();
    }
    let cmd = a[1].clone();
    match cmd.as_str() {
        "c" | "compress" => {
            let mut model = build_model();
            let input = a.get(2).cloned().unwrap_or_else(|| "-".into());
            let text = if input == "-" {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s).expect("stdin");
                s
            } else {
                std::fs::read_to_string(&input).expect("input file")
            };
            let blob = szgc::compress(&mut model, &text);
            match a.get(3) {
                Some(out) => std::fs::write(out, &blob).expect("write output"),
                None => {
                    std::io::stdout().write_all(&blob).expect("stdout");
                }
            }
        }
        "d" | "decompress" => {
            let mut model = build_model();
            let input = a.get(2).cloned().unwrap_or_else(|| "-".into());
            let data = if input == "-" {
                let mut v = Vec::new();
                std::io::stdin().read_to_end(&mut v).expect("stdin");
                v
            } else {
                std::fs::read(&input).expect("input file")
            };
            let text = szgc::decompress(&mut model, &data).expect("decompress");
            match a.get(3) {
                Some(out) => std::fs::write(out, text.as_bytes()).expect("write output"),
                None => print!("{}", text),
            }
        }
        "t" | "text" => {
            let mut model = build_model();
            let text = a.get(2).cloned().unwrap_or_default();
            let blob = szgc::compress(&mut model, &text);
            println!("{}", hex(&blob));
        }
        "batch" => {
            let mut model = build_model();
            let path = a.get(2).cloned().unwrap_or_default();
            let data = std::fs::read_to_string(&path).expect("texts.json");
            let arr = match szgc::jsonutil::parse(&data).expect("json") {
                JVal::Arr(v) => v,
                _ => panic!("expected array"),
            };
            let mut out = String::from("[");
            for (i, v) in arr.iter().enumerate() {
                let t = v.as_str().expect("string item");
                let blob = szgc::compress(&mut model, t);
                out.push_str(&escape_string(&hex(&blob)));
                if i + 1 < arr.len() {
                    out.push(',');
                }
            }
            out.push(']');
            println!("{}", out);
        }
        "batchdec" => {
            let mut model = build_model();
            let path = a.get(2).cloned().unwrap_or_default();
            let data = std::fs::read_to_string(&path).expect("hex.json");
            let arr = match szgc::jsonutil::parse(&data).expect("json") {
                JVal::Arr(v) => v,
                _ => panic!("expected array"),
            };
            let mut out = String::from("[");
            for (i, v) in arr.iter().enumerate() {
                let blob = unhex(v.as_str().expect("hex string")).expect("hex");
                let t = szgc::decompress(&mut model, &blob).expect("decode");
                out.push_str(&escape_string(&t));
                if i + 1 < arr.len() {
                    out.push(',');
                }
            }
            out.push(']');
            println!("{}", out);
        }
        "bench" => {
            let mut model = build_model();
            let data = match a.get(2) {
                Some(p) => std::fs::read_to_string(p).expect("texts.json"),
                None => szgc::EMBEDDED_BENCH.to_string(),
            };
            let arr = match szgc::jsonutil::parse(&data).expect("json") {
                JVal::Arr(v) => v,
                _ => panic!("expected array"),
            };
            println!("{:<8} {:>8} {:>8} {:>5}", "text", "raw", "SZGC", "rt");
            let mut wins_best = 0usize;
            for (i, v) in arr.iter().enumerate() {
                let t = v.as_str().expect("string item");
                let t0 = Instant::now();
                let blob = szgc::compress(&mut model, t);
                let rt = szgc::decompress(&mut model, &blob).as_deref().ok() == Some(t);
                let det = szgc::compress(&mut model, t) == blob;
                println!(
                    "{:<8} {:>8} {:>8} {:>5} ({:.2?})",
                    format!("text{}", i),
                    t.len(),
                    blob.len(),
                    if rt && det { "OK" } else { "FAIL" },
                    t0.elapsed()
                );
                if rt && det {
                    wins_best += 1;
                }
            }
            println!("round-trip+det: {}/{}", wins_best, arr.len());
        }
        "selftest" => {
            let mut model = build_model();
            let n_fuzz: usize = a
                .get(2)
                .and_then(|s| s.parse().ok())
                .unwrap_or(200);
            selftest(&mut model, n_fuzz);
        }
        "model-info" => {
            let model = build_model();
            println!("D={} P={} L={}", model.d, model.p, model.l);
            println!("puncts: {:?}", model.puncts);
            println!("top words: {:?}", &model.words[..30.min(model.words.len())]);
        }
        _ => usage(),
    }
}

fn selftest(model: &mut Model, n_fuzz: usize) {
    let mut fails = 0usize;
    // 1) reference vectors (produced by the Python implementation)
    let vectors = szgc::jsonutil::parse(szgc::EMBEDDED_VECTORS).expect("vectors.json");
    if let JVal::Arr(vs) = vectors {
        let t0 = Instant::now();
        for (i, v) in vs.iter().enumerate() {
            let text = v.get("text").and_then(|x| x.as_str()).expect("text");
            let want = v.get("hex").and_then(|x| x.as_str()).expect("hex");
            let got = hex(&szgc::compress(model, text));
            let back = szgc::decompress(model, &unhex(want).unwrap());
            if got != want || back.as_deref().ok() != Some(text) {
                eprintln!("VECTOR FAIL #{} ({} bytes)", i, text.len());
                fails += 1;
            }
        }
        println!("векторы: {}/{} OK ({:.2?})", vs.len() - fails, vs.len(), t0.elapsed());
    }
    // 2) fixed texts
    let fixed = [
        "Привет! Как дела?",
        "Спасибо большое, выручил!",
        "Не забудь купить хлеб и молоко.",
        "Ок, до связи!",
        "",
        " ",
        "Я",
        "ЁЖик и ёлка, APPLE iPhone 15 Про \u{1F600}",
        "Числа: 12345 и 67890, дата 2026-10-26.",
        "СМЕШАННЫЙ ЁЖ и Крош",
        "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
        "Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.",
    ];
    for t in fixed {
        fails += check(model, t);
    }
    // 3) deterministic fuzz
    let mut st = 0x20261026u64;
    let mut rnd = move || {
        st ^= st << 13;
        st ^= st >> 7;
        st ^= st << 17;
        st
    };
    let alphabets: Vec<Vec<char>> = [
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя ",
        "abc XYZ .,!?\n",
        "😀😃🌍中文日本語",
        "ёЁ ёлка ЁЛКА",
        "\u{0}\u{1}\u{2}\u{FF}",
    ]
    .iter()
    .map(|s| s.chars().collect())
    .collect();
    for _ in 0..n_fuzz {
        let a = &alphabets[(rnd() as usize) % alphabets.len()];
        let n = (rnd() as usize) % 121;
        let t: String = (0..n).map(|_| a[(rnd() as usize) % a.len()]).collect();
        fails += check(model, &t);
    }
    if fails > 0 {
        eprintln!("FAILURES: {}", fails);
        std::process::exit(1);
    }
    println!("selftest: OK ({} fuzz)", n_fuzz);
}

fn check(model: &mut Model, t: &str) -> usize {
    let c = szgc::compress(model, t);
    let d = szgc::decompress(model, &c);
    let c2 = szgc::compress(model, t);
    let ok = d.as_deref().ok() == Some(t) && c == c2;
    if !ok {
        eprintln!("FAIL {:?}", &t[..t.len().min(60)]);
        return 1;
    }
    0
}
