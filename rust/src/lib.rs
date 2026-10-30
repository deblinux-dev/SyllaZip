pub mod core;
pub mod codec;
pub mod jsonutil;

pub const EMBEDDED_MODEL: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../graph-model.bin"));
pub const EMBEDDED_VECTORS: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/vectors.json"));
pub const EMBEDDED_BENCH: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/bench_texts.json"));

use core::Model;

pub fn load_embedded_model() -> Model {
    Model::from_bytes(EMBEDDED_MODEL).expect("embedded model")
}

pub fn compress(model: &mut Model, text: &str) -> Vec<u8> {
    codec::Szgc::new(model).encode(text)
}

pub fn decompress(model: &mut Model, data: &[u8]) -> Result<String, String> {
    codec::Szgc::new(model).decode(data)
}
