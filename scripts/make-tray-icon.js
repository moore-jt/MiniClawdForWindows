// Generates assets/tray.png (16x16 pixel clawd). Run: node scripts/make-tray-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const W = 16, H = 16;
const O = [217, 119, 87, 255], D = [40, 30, 30, 255], T = [0, 0, 0, 0];
const rows = [
  '................',
  '................',
  '................',
  '..oo........oo..',
  '..oooooooooooo..',
  '.oooooooooooooo.',
  '.oooddooooddooo.',
  '.oooddooooddooo.',
  '.oooooooooooooo.',
  '.oooooooooooooo.',
  '..oooooooooooo..',
  '..oooooooooooo..',
  '...oo.oooo.oo...',
  '...oo......oo...',
  '................',
  '................',
];
const raw = Buffer.alloc((W * 4 + 1) * H);
rows.forEach((r, y) => {
  raw[y * (W * 4 + 1)] = 0;
  [...r].forEach((c, x) => {
    const px = c === 'o' ? O : c === 'd' ? D : T;
    Buffer.from(px).copy(raw, y * (W * 4 + 1) + 1 + x * 4);
  });
});
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'tray.png'), png);
console.log('wrote assets/tray.png');
