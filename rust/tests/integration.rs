use szgc::core::{get_case, tokenize, Tok};
use szgc::jsonutil::JVal;
use szgc::{decompress, load_embedded_model, compress, EMBEDDED_VECTORS};

fn hex(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// Byte identity with the Python reference implementation on all vectors.
#[test]
fn reference_vectors() {
    let mut model = load_embedded_model();
    let vs = match szgc::jsonutil::parse(EMBEDDED_VECTORS).unwrap() {
        JVal::Arr(v) => v,
        _ => panic!("vectors.json: array expected"),
    };
    assert!(vs.len() >= 30, "vectors.json looks empty");
    for (i, v) in vs.iter().enumerate() {
        let text = v.get("text").and_then(|x| x.as_str()).unwrap();
        let want = v.get("hex").and_then(|x| x.as_str()).unwrap();
        let got = hex(&compress(&mut model, text));
        assert_eq!(got, want, "encode mismatch on vector #{}, {:?}", i, text);
        assert_eq!(
            decompress(&mut model, &unhex(want)).unwrap(),
            text,
            "decode mismatch on vector #{}",
            i
        );
    }
}

#[test]
fn fixed_texts_roundtrip() {
    let mut model = load_embedded_model();
    let texts = [
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
        "The quick brown fox jumps over the lazy dog.",
        "ЦБ России повысил ключевую ставку до двадцати одного процента годовых.",
        "Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.",
        "мы пошли в кино мы пошли в кино мы пошли в кино",
    ];
    for t in texts {
        let c = compress(&mut model, t);
        let c2 = compress(&mut model, t);
        assert_eq!(c, c2, "non-deterministic encode for {:?}", t);
        assert_eq!(decompress(&mut model, &c).unwrap(), t, "roundtrip for {:?}", t);
    }
}

/// Deterministic xorshift64 fuzz: random alphabets, words, repeats, control bytes.
#[test]
fn fuzz_roundtrip() {
    let mut model = load_embedded_model();
    let mut st: u64 = 0x2026_1026;
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
        "🙂😂👍❤️🔥🎉",
    ]
    .iter()
    .map(|s| s.chars().collect())
    .collect();
    let words = ["привет", "как", "дела", "the", "quick", "ллызъ", "_fps", "今日", "😀", "42"];
    for iter in 0..400 {
        let t = match (rnd() as usize) % 5 {
            0 => {
                let a = &alphabets[(rnd() as usize) % alphabets.len()];
                let n = (rnd() as usize) % 121;
                let s: String = (0..n).map(|_| a[(rnd() as usize) % a.len()]).collect();
                s
            }
            1 => {
                let n = 1 + (rnd() as usize) % 40;
                let s: Vec<&str> = (0..n).map(|_| words[(rnd() as usize) % words.len()]).collect();
                s.join(" ")
            }
            2 => {
                let base = ["абра", "foo bar ", "今日は ", "😀😀"][(rnd() as usize) % 4];
                base.repeat(1 + (rnd() as usize) % 30)
            }
            3 => {
                let a = &alphabets[(rnd() as usize) % alphabets.len()];
                let chunk: String = (0..(rnd() as usize) % 20 + 1)
                    .map(|_| a[(rnd() as usize) % a.len()])
                    .collect();
                format!("{} ", chunk).repeat(1 + (rnd() as usize) % 10)
            }
            _ => {
                let ws: Vec<char> = "\t\n \u{b}\r".chars().collect();
                let n = (rnd() as usize) % 40;
                let s: String = (0..n).map(|_| ws[(rnd() as usize) % ws.len()]).collect();
                s
            }
        };
        let c = compress(&mut model, &t);
        let c2 = compress(&mut model, &t);
        assert_eq!(c, c2, "iter {}: non-deterministic", iter);
        match decompress(&mut model, &c) {
            Ok(d) => assert_eq!(d, t, "iter {}: roundtrip mismatch", iter),
            Err(e) => panic!("iter {}: decode error {} for {:?}", iter, e, t),
        }
    }
}

/// Corrupt headers must be rejected, not panic.
#[test]
fn bad_streams_rejected() {
    let mut model = load_embedded_model();
    assert!(decompress(&mut model, &[]).is_err());
    assert!(decompress(&mut model, &[0x00]).is_err());
    assert!(decompress(&mut model, &[0x06, 1, 2, 3]).is_err());
    let _ = decompress(&mut model, &[0x02, 0xFF, 0xFF, 0xFF]);
}

#[test]
fn tokenizer_and_case() {
    assert_eq!(
        tokenize("Привет! Как дела?"),
        vec![
            Tok::Word("Привет".into()),
            Tok::Lit("! ".into()),
            Tok::Word("Как".into()),
            Tok::Lit(" ".into()),
            Tok::Word("дела".into()),
            Tok::Lit("?".into()),
        ]
    );
    assert_eq!(tokenize("ёлка ЁЛКА ель123"), vec![
        Tok::Word("ёлка".into()),
        Tok::Lit(" ".into()),
        Tok::Word("ЁЛКА".into()),
        Tok::Lit(" ".into()),
        Tok::Word("ель".into()),
        Tok::Lit("123".into()),
    ]);
    assert_eq!(get_case("привет"), 0);
    assert_eq!(get_case("Привет"), 1);
    assert_eq!(get_case("ПРИВЕТ"), 2);
    assert_eq!(get_case("ЁЖик"), 3);
}

/// Short chat phrases must compress tighter than raw (sanity, model quality).
#[test]
fn compression_actually_compresses() {
    let mut model = load_embedded_model();
    for t in [
        "Привет! Как дела?",
        "Спасибо большое, выручил!",
        "Не забудь купить хлеб и молоко.",
    ] {
        let c = compress(&mut model, t);
        assert!(c.len() < t.len(), "{:?}: {} bytes vs raw {}", t, c.len(), t.len());
    }
}
