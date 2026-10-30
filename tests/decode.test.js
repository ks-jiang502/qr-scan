'use strict';
/**
 * 解码核心的单元测试：node --test tests/
 * 期望值来自二维码规范的既定行为，而不是“让测试通过”。
 */
const test = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const QrDecode = require('../app/decode.js');

/**
 * 用 qrcode 的模块矩阵直接画像素，绕开 PNG 编解码，
 * 得到与 canvas ImageData 同构的对象。
 */
function renderQR(text, opts) {
  const o = Object.assign({ scale: 4, quiet: 4, invert: false, ec: 'M' }, opts || {});
  const qr = QRCode.create(text, { errorCorrectionLevel: o.ec });
  const size = qr.modules.size;
  const dim = (size + o.quiet * 2) * o.scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);

  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      const dark = qr.modules.data[my * size + mx] === 1;
      const color = o.invert ? (dark ? 0 : 255) : dark ? 0 : 255;
      const px0 = (mx + o.quiet) * o.scale;
      const py0 = (my + o.quiet) * o.scale;
      for (let y = py0; y < py0 + o.scale; y++) {
        for (let x = px0; x < px0 + o.scale; x++) {
          const off = (y * dim + x) * 4;
          data[off] = color;
          data[off + 1] = color;
          data[off + 2] = color;
          data[off + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

/** 把若干张码贴到同一张画布上，模拟一屏里有多个码 */
function compose(canvasW, canvasH, parts) {
  const data = new Uint8ClampedArray(canvasW * canvasH * 4).fill(255);
  for (const p of parts) {
    for (let y = 0; y < p.img.height; y++) {
      const ty = p.y + y;
      if (ty < 0 || ty >= canvasH) continue;
      for (let x = 0; x < p.img.width; x++) {
        const tx = p.x + x;
        if (tx < 0 || tx >= canvasW) continue;
        const s = (y * p.img.width + x) * 4;
        const d = (ty * canvasW + tx) * 4;
        data[d] = p.img.data[s];
        data[d + 1] = p.img.data[s + 1];
        data[d + 2] = p.img.data[s + 2];
        data[d + 3] = 255;
      }
    }
  }
  return { data, width: canvasW, height: canvasH };
}

test('单个二维码可以解出原文', () => {
  const img = renderQR('https://example.com/login?token=abc123');
  const codes = QrDecode.decodeAll(img);
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].data, 'https://example.com/login?token=abc123');
});

test('中文与特殊字符往返一致', () => {
  const text = '扫码结果：中文/emoji🙂/符号 & "quotes" <tag>';
  const codes = QrDecode.decodeAll(renderQR(text));
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].data, text);
});

test('同一画面里的两个二维码都能解出（无重复）', () => {
  const a = renderQR('https://a.example.com', { scale: 4 });
  const b = renderQR('https://b.example.com', { scale: 4 });
  const img = compose(900, 400, [
    { img: a, x: 30, y: 60 },
    { img: b, x: 520, y: 60 },
  ]);
  const codes = QrDecode.decodeAll(img);
  const texts = codes.map((c) => c.data).sort();
  assert.deepStrictEqual(texts, ['https://a.example.com', 'https://b.example.com']);
});

test('黑底白码（反色）也能解出', () => {
  const img = renderQR('INVERT-ME', { invert: true });
  const codes = QrDecode.decodeAll(img);
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].data, 'INVERT-ME');
});

test('小尺寸（每模块 2px）仍可解出', () => {
  const img = renderQR('small-module', { scale: 2 });
  const codes = QrDecode.decodeAll(img);
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].data, 'small-module');
});

test('解码结果带外接框，可用于界面高亮', () => {
  const img = renderQR('locate-me', { scale: 4 });
  const [code] = QrDecode.decodeAll(img);
  assert.ok(code.box.w > 0 && code.box.h > 0);
  assert.ok(code.box.x >= 0 && code.box.y >= 0);
  assert.ok(code.box.x + code.box.w <= img.width);
  assert.ok(code.box.y + code.box.h <= img.height);
});

test('WiFi 码解析出用户名密码，并还原转义字符', () => {
  const c = QrDecode.parseContent('WIFI:T:WPA;S:My\\;Net;P:p\\:a\\,ss;H:true;;');
  assert.strictEqual(c.type, 'wifi');
  assert.strictEqual(c.title, 'My;Net');
  assert.strictEqual(c.fields.find((f) => f.k === '密码').v, 'p:a,ss');
  assert.strictEqual(c.copyText, 'p:a,ss');
});

test('vCard 解析姓名、电话与邮箱', () => {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:张三',
    'ORG:示例公司',
    'TEL:+86 138 0000 0000',
    'EMAIL:zs@example.com',
    'END:VCARD',
  ].join('\n');
  const c = QrDecode.parseContent(vcard);
  assert.strictEqual(c.type, 'vcard');
  assert.strictEqual(c.title, '张三');
  assert.ok(c.fields.some((f) => f.k === '电话' && f.v === '+86 138 0000 0000'));
  assert.ok(c.fields.some((f) => f.k === '邮箱' && f.v === 'zs@example.com'));
});

test('链接识别：带协议原样打开，裸域名补 https', () => {
  assert.strictEqual(QrDecode.parseContent('https://x.example.com/a').openUrl, 'https://x.example.com/a');
  assert.strictEqual(QrDecode.parseContent('www.example.com/x').openUrl, 'https://www.example.com/x');
  assert.strictEqual(QrDecode.parseContent('example.com').openUrl, 'https://example.com');
});

test('普通文本不会被误判成链接', () => {
  const c = QrDecode.parseContent('这是一段普通文本，不是网址');
  assert.strictEqual(c.type, 'text');
  assert.strictEqual(c.openUrl, undefined);
});

test('空图像数据会明确报错而不是静默返回空', () => {
  assert.throws(() => QrDecode.decodeAll({ data: null, width: 0, height: 0 }), /图像数据无效/);
});
