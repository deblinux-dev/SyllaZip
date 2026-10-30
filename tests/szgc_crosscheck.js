/*
 * Кросс-проверка SZGC JS-порта против эталонных векторов Python.
 * Запуск: node szgc_crosscheck.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SZGC = require(path.join(__dirname, "..", "web", "szgc.js"));
const modelBytes = new Uint8Array(
  fs.readFileSync(path.join(__dirname, "..", "graph-model.bin")));
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "tests", "vectors.json"), "utf-8"));

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(a) {
  let s = "";
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0");
  return s;
}

const t0 = Date.now();
SZGC.loadModel(modelBytes);
console.log("модель загружена: %d мс", Date.now() - t0);

let ok = 0, fails = 0;
const t1 = Date.now();
for (let i = 0; i < vectors.length; i++) {
  const v = vectors[i];
  let c, d, c2;
  try {
    c = SZGC.compress(v.text);
    d = SZGC.decompress(c);
    c2 = SZGC.compress(v.text);
  } catch (e) {
    fails++;
    console.log("EXC #%d (tag %s): %s", i, v.tag, e.message);
    continue;
  }
  const encOk = bytesToHex(c) === v.hex;
  const rtOk = d === v.text;
  const detOk = bytesToHex(c2) === v.hex;
  if (encOk && rtOk && detOk) {
    ok++;
  } else {
    fails++;
    console.log("FAIL #%d (tag %s): enc=%s rt=%s det=%s text=%r",
      i, v.tag, encOk, rtOk, detOk, JSON.stringify(v.text.slice(0, 40)));
    if (!encOk) {
      const expect = v.hex, got = bytesToHex(c);
      let diff = 0;
      while (diff < expect.length && diff < got.length && expect[diff] === got[diff]) diff += 2;
      console.log("   первое расхождение на байте %d: ожидалось %s, получено %s",
        diff / 2, expect.slice(diff, diff + 8), got.slice(diff, diff + 8));
    }
  }
}
console.log("кросс-проверка: %d/%d OK (%d мс)", ok, vectors.length, Date.now() - t1);
process.exit(fails ? 1 : 0);
