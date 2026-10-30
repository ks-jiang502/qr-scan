/**
 * 二维码解码核心（浏览器 / Node 双用，不依赖 DOM）
 *
 * 浏览器：window.QrDecode
 * Node：  require('./decode.js')
 *
 * 依赖：jsQR（浏览器已通过 <script> 全局注入，Node 通过 require('jsqr')）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.QrDecode = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /** 同一张图里最多尝试解码这么多个二维码 */
  const MAX_CODES = 16;
  /** 涂白时向外扩的像素，防止边缘残留导致同一个码被重复解出 */
  const BLANK_PAD = 2;

  function getJsQR() {
    if (typeof root.jsQR === 'function') return root.jsQR;
    if (typeof module === 'object' && typeof require === 'function') {
      return require('jsqr');
    }
    throw new Error('jsQR 未加载');
  }

  /** jsQR 的 location 是四个角点，换算成外接矩形 */
  function boundingBox(location) {
    const pts = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner,
    ].filter(Boolean);
    if (!pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      size: Math.max(maxX - minX, maxY - minY),
    };
  }

  /** 把已解码区域涂白，避免下一轮重复命中同一个码 */
  function blankBox(data, imgW, imgH, box, pad) {
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(imgW - 1, Math.ceil(box.x + box.w + pad));
    const y1 = Math.min(imgH - 1, Math.ceil(box.y + box.h + pad));
    for (let y = y0; y <= y1; y++) {
      let off = (y * imgW + x0) * 4;
      for (let x = x0; x <= x1; x++) {
        data[off] = 255;
        data[off + 1] = 255;
        data[off + 2] = 255;
        data[off + 3] = 255;
        off += 4;
      }
    }
  }

  function isSameCode(data, box, prev) {
    const dist = Math.hypot(box.cx - prev.cx, box.cy - prev.cy);
    const tolerance = Math.max(8, prev.size * 0.5);
    return data === prev.data && dist < tolerance;
  }

  /** 在给定像素上反复解，每解出一个就把该区域涂白，直到没有新的码 */
  function sweep(imageLike, maxCodes) {
    const jsQR = getJsQR();
    const w = imageLike.width | 0;
    const h = imageLike.height | 0;
    // 复制一份，因为涂白会破坏原始像素
    const pixels = new Uint8ClampedArray(imageLike.data);
    const codes = [];
    const prev = [];

    for (let i = 0; i < maxCodes; i++) {
      // 先按正常配色找，找不到再优先按反色找（黑底白码）。
      // 注意：这里不能用 'onlyInvert'，jsQR 1.4.0 在该模式下不会生成反色矩阵，
      // 会把 undefined 传进 locate 直接抛错；'invertFirst' 行为等价且安全。
      let res = jsQR(pixels, w, h, { inversionAttempts: 'dontInvert' });
      if (!res) res = jsQR(pixels, w, h, { inversionAttempts: 'invertFirst' });
      if (!res) break;

      const box = boundingBox(res.location);
      if (!box) break;
      if (prev.some((p) => isSameCode(res.data, box, p))) break;

      codes.push({
        data: res.data,
        binaryData: res.binaryData ? Array.from(res.binaryData) : null,
        version: res.version,
        location: res.location,
        box,
      });
      prev.push({ data: res.data, cx: box.cx, cy: box.cy, size: box.size });
      blankBox(pixels, w, h, box, BLANK_PAD);
    }
    return codes;
  }

  /** 从原图裁出子区域，做成独立的像素副本 */
  function crop(imageData, x, y, w, h) {
    const src = imageData.data;
    const srcW = imageData.width;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * srcW + x) * 4;
      out.set(src.subarray(from, from + w * 4), row * w * 4);
    }
    return { data: out, width: w, height: h };
  }

  /** 把子区域解出的坐标换算回原图坐标 */
  function shiftCodes(codes, dx, dy) {
    for (const c of codes) {
      c.box.x += dx;
      c.box.y += dy;
      c.box.cx += dx;
      c.box.cy += dy;
      if (c.location) {
        for (const key of Object.keys(c.location)) {
          const p = c.location[key];
          if (p && typeof p.x === 'number') {
            c.location[key] = { x: p.x + dx, y: p.y + dy };
          }
        }
      }
    }
    return codes;
  }

  /** 合并分块结果，去掉被相邻块重复解出的同一个码 */
  function mergeCodes(into, from) {
    for (const c of from) {
      const dup = into.some((o) => {
        if (o.data !== c.data) return false;
        const tol = Math.max(24, Math.max(o.box.size, c.box.size) * 0.6);
        return Math.hypot(o.box.cx - c.box.cx, o.box.cy - c.box.cy) < tol;
      });
      if (!dup) into.push(c);
    }
    return into;
  }

  /**
   * 按网格切块扫描，结果并入 found（坐标已换算回整图）。
   * 只要 step <= tileSize - 最大码边长，任意该尺寸以内的码都必然被某一块完整盖住；
   * 所以分两层：小步长找小码，大步长找大码。
   */
  function tileScan(imageData, tileSize, step, found, max) {
    const w = imageData.width | 0;
    const h = imageData.height | 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const tw = Math.min(tileSize, w - x);
        const th = Math.min(tileSize, h - y);
        if (tw < 64 || th < 64) continue;
        const sub = crop(imageData, x, y, tw, th);
        const codes = sweep(sub, max);
        if (!codes.length) continue;
        mergeCodes(found, shiftCodes(codes, x, y));
        if (found.length >= max) return;
      }
    }
  }

  /**
   * 在一帧图像里解出所有二维码。
   * 策略：先整图扫描；整图没扫到小码时切成重叠的块再扫，
   * 这样截图里的二维码在大画布中占比很小也能被找到。
   *
   * 注意 jsQR 在「一张图里有两个以上二维码」时经常整图定位失败（会把两个码的定位角
   * 混着配对），所以多码场景本来就依赖分块，分块的覆盖性必须靠得住。
   *
   * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
   * @param {{maxCodes?: number, tile?: boolean, tileSize?: number, thorough?: boolean}} [options]
   * @returns {Array<{data: string, binaryData: number[], version: number, location: object, box: object}>}
   */
  function decodeAll(imageData, options) {
    const opts = options || {};
    const max = opts.maxCodes || MAX_CODES;
    const w = imageData.width | 0;
    const h = imageData.height | 0;
    if (!w || !h || !imageData.data) throw new Error('图像数据无效');
    if (imageData.data.length !== w * h * 4) throw new Error('图像数据无效');

    const found = sweep(imageData, max);
    const wantTiles = opts.tile !== false;

    // 整图扫到了、又不需要更全的结果时直接返回
    if (found.length && !opts.thorough) return found.slice(0, max);
    if (!wantTiles) return found.slice(0, max);

    // 分块只对大图有意义：整图扫描在小图上已经很可靠
    if (w <= 400 && h <= 400) return found.slice(0, max);

    // 第一层：512 的块、384 的步长，保证边长 ≤128px 的小码一定落在某块里
    const t1 = Math.max(128, Math.min(opts.tileSize || 512, 512));
    tileScan(imageData, t1, Math.max(64, Math.min(384, t1 - 128)), found, max);
    if (found.length >= max) return found.slice(0, max);

    // 第二层：1024 的块、512 的步长，保证边长 ≤512px 的大码也落在某块里。
    // 整图一个都没扫到时无条件做；thorough 模式下也做，用来把同屏的多个码找全。
    if (opts.thorough || !found.length) {
      if (w > 512 || h > 512) tileScan(imageData, 1024, 512, found, max);
    }
    return found.slice(0, max);
  }

  // ────────────────────────── 内容解析 ──────────────────────────

  /** 解析 WIFI:T:WPA;S:名称;P:密码;H:true;; 这类键值格式（支持反斜杠转义） */
  function parseWifi(text) {
    const body = text.slice(5);
    const fields = {};
    let key = '';
    let val = '';
    let inVal = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inVal && ch === '\\' && i + 1 < body.length) {
        val += body[++i];
        continue;
      }
      if (ch === ':' && !inVal) {
        inVal = true;
        continue;
      }
      if (ch === ';') {
        if (key) fields[key.toUpperCase()] = val;
        key = '';
        val = '';
        inVal = false;
        continue;
      }
      if (inVal) val += ch;
      else key += ch;
    }
    if (key) fields[key.toUpperCase()] = val;
    const encryption = (fields.T || 'WPA').toUpperCase();
    return {
      type: 'wifi',
      label: 'WiFi',
      title: fields.S || '(未命名网络)',
      fields: [
        { k: '网络名称', v: fields.S || '' },
        { k: '密码', v: fields.P || '(无)' },
        { k: '加密方式', v: encryption === 'NOPASS' ? '无密码' : encryption },
        { k: '隐藏网络', v: fields.H === 'true' ? '是' : '否' },
      ].filter((f) => f.v !== ''),
      copyText: fields.P || fields.S || text,
    };
  }

  function parseVcard(text) {
    const lines = text.split(/\r?\n/);
    const pick = (name) => {
      const line = lines.find((l) => new RegExp('^' + name + '[;:]', 'i').test(l));
      if (!line) return '';
      const idx = line.indexOf(':');
      return idx >= 0 ? line.slice(idx + 1).split(';')[0].trim() : '';
    };
    const fn = pick('FN') || pick('N');
    const tels = lines
      .filter((l) => /^TEL[;:]/i.test(l))
      .map((l) => l.slice(l.indexOf(':') + 1).trim())
      .filter(Boolean);
    const org = pick('ORG');
    const email = pick('EMAIL');
    return {
      type: 'vcard',
      label: '名片',
      title: fn || org || '(无名片信息)',
      fields: [
        { k: '姓名', v: fn },
        { k: '组织', v: org },
        ...tels.map((t, i) => ({ k: tels.length > 1 ? `电话 ${i + 1}` : '电话', v: t })),
        { k: '邮箱', v: email },
      ].filter((f) => f.v),
      copyText: text,
    };
  }

  /** 把扫描内容归类，方便界面展示与给出操作按钮 */
  function parseContent(raw) {
    const text = String(raw == null ? '' : raw);
    const trimmed = text.trim();

    if (/^https?:\/\//i.test(trimmed)) {
      return {
        type: 'url',
        label: '链接',
        title: trimmed,
        fields: [],
        openUrl: trimmed,
        copyText: trimmed,
      };
    }
    if (/^WIFI:/i.test(trimmed)) return parseWifi(trimmed);
    if (/^BEGIN:VCARD/i.test(trimmed)) return parseVcard(trimmed);
    if (/^mailto:/i.test(trimmed)) {
      const addr = trimmed.slice(7).split('?')[0];
      return {
        type: 'email',
        label: '邮箱',
        title: decodeURIComponentSafe(addr),
        fields: [],
        openUrl: trimmed,
        copyText: addr,
      };
    }
    if (/^tel:/i.test(trimmed)) {
      return {
        type: 'tel',
        label: '电话',
        title: trimmed.slice(4),
        fields: [],
        openUrl: trimmed,
        copyText: trimmed.slice(4),
      };
    }
    if (/^smsto:/i.test(trimmed)) {
      return {
        type: 'sms',
        label: '短信',
        title: trimmed.slice(6).split('?')[0],
        fields: [],
        copyText: trimmed,
      };
    }
    if (/^geo:/i.test(trimmed)) {
      return {
        type: 'geo',
        label: '位置',
        title: trimmed.slice(4),
        fields: [],
        openUrl: 'https://uri.amap.com/marker?position=' + trimmed.slice(4).split(',')[1] + ',' + trimmed.slice(4).split(',')[0],
        copyText: trimmed,
      };
    }
    // 不带协议的域名也当成链接给出
    if (/^(www\.|[a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(trimmed) && !/\s/.test(trimmed)) {
      return {
        type: 'url',
        label: '链接',
        title: trimmed,
        fields: [],
        openUrl: 'https://' + trimmed,
        copyText: trimmed,
      };
    }
    return {
      type: 'text',
      label: '文本',
      title: trimmed,
      fields: [],
      copyText: text,
    };
  }

  function decodeURIComponentSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  return {
    decodeAll,
    parseContent,
    parseWifi,
    parseVcard,
    boundingBox,
    MAX_CODES,
  };
});
