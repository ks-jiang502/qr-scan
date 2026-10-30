// 生成 exe 图标：程序化绘制 PNG，再包成 ICO（单条目、256×256、PNG 内嵌）
// 用途：csc /win32icon:icon.ico
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 256;

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 绘制 ──
const px = new Uint8Array(SIZE * SIZE * 4);

const R = 58;                       // 圆角半径
const c1 = [0x4d, 0x8d, 0xff];      // 左上蓝
const c2 = [0x8b, 0x5c, 0xf6];      // 右下紫

function inRoundedRect(x, y, pad, radius) {
  const lo = pad, hi = SIZE - 1 - pad;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const dx = Math.min(Math.abs(x - lo), Math.abs(x - hi));
  const dy = Math.min(Math.abs(y - lo), Math.abs(y - hi));
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  if (x < lo + radius || x > hi - radius) {
    if (y < lo + radius || y > hi - radius) {
      return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
    }
  }
  return true;
}

// 白色描边方框（四个角），粗 13，边长 62，距边 44
const BAR = 13, ARM = 62, INSET = 44;

function inCornerMarks(x, y) {
  const nearLeft = x >= INSET && x < INSET + ARM;
  const nearRight = x > SIZE - 1 - INSET - ARM && x <= SIZE - 1 - INSET;
  const nearTop = y >= INSET && y < INSET + ARM;
  const nearBottom = y > SIZE - 1 - INSET - ARM && y <= SIZE - 1 - INSET;
  const onLeftBand = x >= INSET && x < INSET + BAR;
  const onRightBand = x > SIZE - 1 - INSET - BAR && x <= SIZE - 1 - INSET;
  const onTopBand = y >= INSET && y < INSET + BAR;
  const onBottomBand = y > SIZE - 1 - INSET - BAR && y <= SIZE - 1 - INSET;

  if (nearTop && (onLeftBand || onRightBand)) return true;
  if (nearBottom && (onLeftBand || onRightBand)) return true;
  if (nearLeft && (onTopBand || onBottomBand)) return true;
  if (nearRight && (onTopBand || onBottomBand)) return true;
  return false;
}

// 中心四个小方块
const SQ = 20, GAP = 20;
function inCenterDots(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const half = GAP / 2 + SQ / 2 + GAP / 2; // 中心到外缘
  const offs = [-1, 1];
  for (const ox of offs) {
    for (const oy of offs) {
      const px0 = cx + ox * (GAP + SQ) / 2;
      const py0 = cy + oy * (GAP + SQ) / 2;
      if (Math.abs(x - px0) <= SQ / 2 && Math.abs(y - py0) <= SQ / 2) return true;
    }
  }
  return false;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const t = (x / SIZE + y / SIZE) / 2;
    const bg = [
      Math.round(c1[0] + (c2[0] - c1[0]) * t),
      Math.round(c1[1] + (c2[1] - c1[1]) * t),
      Math.round(c1[2] + (c2[2] - c1[2]) * t),
    ];

    if (!inRoundedRect(x, y, 0, R)) {
      px[i + 3] = 0; // 圆角外透明
      continue;
    }

    if (inCornerMarks(x, y) || inCenterDots(x, y)) {
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
    } else {
      px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; px[i + 3] = 255;
    }
  }
}

const png = encodePng(SIZE, SIZE, Buffer.from(px));

// ICO 容器：1 个条目，PNG 直存
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);   // type: icon
header.writeUInt16LE(1, 4);   // count

const entry = Buffer.alloc(16);
entry[0] = 0;                 // width 256 → 0
entry[1] = 0;                 // height 256 → 0
entry[2] = 0;                 // palette
entry[3] = 0;                 // reserved
entry.writeUInt16LE(1, 4);    // planes
entry.writeUInt16LE(32, 6);   // bit count
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);  // offset

const ico = Buffer.concat([header, entry, png]);
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
console.log('已生成 ' + out + '（' + ico.length + ' 字节，PNG ' + png.length + '）');
