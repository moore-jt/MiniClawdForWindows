// Generates assets/tray.png (16x16 pixel clawd) and assets/icon.png (256x256 app/installer icon).
// Run: node scripts/make-tray-icon.js
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
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

/** Nearest-neighbour scaled PNG of the pixel art. */
function render(scale) {
  const w = W * scale, h = H * scale, stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[Math.floor(y / scale)][Math.floor(x / scale)];
      const px = c === 'o' ? O : c === 'd' ? D : T;
      Buffer.from(px).copy(raw, y * stride + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = (name, buf) => { fs.writeFileSync(path.join(__dirname, '..', 'assets', name), buf); console.log('wrote assets/' + name); };
out('tray.png', render(1));
out('icon.png', render(16));
