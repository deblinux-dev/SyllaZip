const path = require('path');
const SZGC = require(path.join(__dirname, '..', 'web', 'szgc.js'));
const fs = require('fs');
SZGC.loadModel(new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'graph-model.bin'))));
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(24680);
const alphabets = ['абвгдеёжзийклмнопрстуфхцчшщъыьэюя ', 'ABCDEFabcdef .,!?\n',
  '😀😃😄🌍中文日本語テスト', '\x00\x01\x02\xff\xfe', 'ёЁйЙёлка ЁЛКА ёж', '🙂😂👍❤️🔥🎉'].map(a => Array.from(a));
const words = ['привет', 'как', 'дела', 'the', 'quick', 'ллызъ', '_fps', '今日', '😀', '42', 'не'];
let fails = 0;
for (let i = 0; i < 300; i++) {
  let t;
  const k = Math.floor(rnd() * 5);
  if (k === 0) {
    const a = alphabets[Math.floor(rnd() * alphabets.length)];
    const n = Math.floor(rnd() * 250);
    t = Array.from({length: n}, () => a[Math.floor(rnd() * a.length)]).join('');
  } else if (k === 1) {
    const n = Math.floor(rnd() * 60);
    t = Array.from({length: n}, () => words[Math.floor(rnd() * words.length)]).join(' ');
  } else if (k === 2) {
    const base = ['абра', 'foo bar ', '今日は ', '😀😀'][Math.floor(rnd() * 4)];
    t = base.repeat(Math.floor(rnd() * 35));
  } else if (k === 3) {
    t = Array.from({length: Math.floor(rnd() * 40)}, () => '\t\n \x0b\r'[Math.floor(rnd() * 5)]).join('');
  } else {
    const p = ['мы пошли в кино ', 'the cat sat ', '今日 も 暑い '][Math.floor(rnd() * 3)];
    t = p.repeat(1 + Math.floor(rnd() * 25));
  }
  try {
    const c = SZGC.compress(t);
    const d = SZGC.decompress(c);
    const c2 = SZGC.compress(t);
    if (d !== t || Buffer.from(c).toString('hex') !== Buffer.from(c2).toString('hex')) {
      fails++;
      console.log('FAIL', i, JSON.stringify(t.slice(0, 40)));
    }
  } catch (e) {
    fails++;
    console.log('EXC', i, e.message, JSON.stringify(t.slice(0, 40)));
  }
}
console.log('JS fuzz: ' + (300 - fails) + '/300 OK');
process.exit(fails ? 1 : 0);
