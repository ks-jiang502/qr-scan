/* 扫码器 · 界面逻辑 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LS_SETTINGS = 'qrscan.settings.v1';
  const LS_HISTORY = 'qrscan.history.v1';
  const HISTORY_LIMIT = 24;

  const state = {
    settings: { autoCopy: false, autoOpen: false },
    history: [],
    crop: null, // { source: canvas, dragging, startX, startY }
    cam: { stream: null, timer: null, raf: 0 },
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ───────────── 持久化 ───────────── */

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      state.settings.autoCopy = !!s.autoCopy;
      state.settings.autoOpen = !!s.autoOpen;
    } catch (e) { /* 忽略损坏的配置 */ }
    try {
      const h = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
      if (Array.isArray(h)) state.history = h.filter((x) => x && typeof x.data === 'string').slice(0, HISTORY_LIMIT);
    } catch (e) { /* 忽略损坏的历史 */ }
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) {}
  }

  function saveHistory() {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(state.history)); } catch (e) {}
  }

  /* ───────────── 通用工具 ───────────── */

  let toastTimer = 0;
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.dataset.kind = kind || '';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function copyText(text, quiet) {
    const value = String(text == null ? '' : text);
    try {
      await navigator.clipboard.writeText(value);
    } catch (e) {
      // 剪贴板权限被拒时退回旧接口
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { toast('复制失败，请手动选中复制', 'warn'); return; }
      document.body.removeChild(ta);
    }
    if (!quiet) toast('已复制到剪贴板', 'ok');
  }

  /* ───────────── 解码 ───────────── */

  function tryDecode(canvas, opts) {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return QrDecode.decodeAll(img, opts || {});
    } catch (err) {
      console.warn('[扫码器] 解码异常', err);
      return [];
    }
  }

  function upscale(canvas, factor) {
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * factor);
    c.height = Math.round(canvas.height * factor);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false; // 最近邻放大，二维码边缘不会被抹糊
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  /** 先按原尺寸解，失败再放大重试（截图里的小码常常需要放大） */
  function decodeCanvasWithRetry(canvas, opts) {
    let codes = tryDecode(canvas, opts);
    if (codes.length) return codes;

    for (const factor of [2, 3]) {
      if (canvas.width * factor > 6000 || canvas.height * factor > 6000) break;
      const up = upscale(canvas, factor);
      codes = tryDecode(up, opts);
      if (codes.length) {
        // 坐标换算回原图尺度，保证后续高亮/裁剪位置正确
        for (const c of codes) {
          c.box.x /= factor; c.box.y /= factor;
          c.box.w /= factor; c.box.h /= factor;
          c.box.cx /= factor; c.box.cy /= factor;
          c.box.size /= factor;
        }
        return codes;
      }
    }
    return [];
  }

  /* ───────────── 结果展示 ───────────── */

  function resultCardHTML(info, index, total) {
    const badge = `<span class="badge" data-type="${escapeHtml(info.type)}">${escapeHtml(info.label)}</span>`;
    const idx = total > 1 ? `<span class="result-idx">第 ${index + 1} 个</span>` : '';

    let title;
    if (info.type === 'url' || info.type === 'email' || info.type === 'tel') {
      title = `<a href="${escapeHtml(info.openUrl || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(info.title)}</a>`;
    } else {
      title = escapeHtml(info.title);
    }

    let fields = '';
    if (info.fields && info.fields.length) {
      fields = '<dl class="fields">' + info.fields.map((f) => {
        const mono = /密码|电话|编号/.test(f.k) ? ' class="mono"' : '';
        return `<dt>${escapeHtml(f.k)}</dt><dd${mono}>${escapeHtml(f.v)}</dd>`;
      }).join('') + '</dl>';
    }

    const actions = [
      `<button class="btn" data-act="copy">复制</button>`,
      info.openUrl ? `<button class="btn primary" data-act="open">打开</button>` : '',
    ].join('');

    return `<article class="result">
      <div class="result-head">${badge}${idx}</div>
      <p class="result-title">${title}</p>
      ${fields}
      <div class="result-actions">${actions}</div>
    </article>`;
  }

  function renderResults(items) {
    const box = $('results');
    $('emptyState').hidden = true;
    box.innerHTML = '';

    items.forEach((entry, i) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = resultCardHTML(entry.info, i, items.length);
      const card = wrap.firstElementChild;

      const copyBtn = card.querySelector('[data-act="copy"]');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          copyText(entry.info.copyText || entry.code.data);
          copyBtn.textContent = '已复制';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        });
      }

      const openBtn = card.querySelector('[data-act="open"]');
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          window.open(entry.info.openUrl, '_blank', 'noopener');
        });
      }

      box.appendChild(card);
    });
  }

  /** 识别成功后的统一出口：渲染、存历史、执行自动动作 */
  function handleCodes(codes) {
    if (!codes || !codes.length) return;
    const items = codes.map((code) => ({ code, info: QrDecode.parseContent(code.data) }));
    renderResults(items);
    addHistory(items[0].code.data);

    const first = items[0].info;
    if (state.settings.autoCopy) copyText(first.copyText || first.title, true);
    if (state.settings.autoOpen && first.openUrl) window.open(first.openUrl, '_blank', 'noopener');
  }

  /* ───────────── 历史 ───────────── */

  function historyLabel(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > 42 ? t.slice(0, 42) + '…' : t;
  }

  function addHistory(data) {
    state.history = state.history.filter((h) => h.data !== data);
    state.history.unshift({ data, ts: Date.now() });
    state.history = state.history.slice(0, HISTORY_LIMIT);
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    const ul = $('history');
    ul.innerHTML = '';
    for (const item of state.history) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = '点击复制：' + item.data;
      btn.innerHTML = '<span class="dot"></span><span class="label"></span>';
      btn.querySelector('.label').textContent = historyLabel(item.data);
      btn.addEventListener('click', () => copyText(item.data));
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  /* ───────────── 截图框选 ───────────── */

  async function captureScreen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('这个浏览器不支持屏幕捕获，请改用「打开图片」或粘贴截图', 'warn');
      return;
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    } catch (err) {
      // 用户点了取消，不需要打扰
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
      toast('无法获取屏幕画面：' + ((err && err.message) || err), 'warn');
      return;
    }

    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play().catch(() => {});
      await wait(260); // 等共享画面真正刷出第一帧

      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      if (!w || !h) {
        toast('没有拿到屏幕画面，请重试并选择「整个屏幕」', 'warn');
        return;
      }

      const snap = document.createElement('canvas');
      snap.width = w;
      snap.height = h;
      snap.getContext('2d').drawImage(video, 0, 0, w, h);
      openCrop(snap);
    } catch (err) {
      toast('截屏失败：' + ((err && err.message) || err), 'warn');
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  function layoutMask() {
    const stage = $('cropStage').getBoundingClientRect();
    const view = $('cropCanvas').getBoundingClientRect();
    const mask = $('cropMask');
    mask.style.left = (view.left - stage.left) + 'px';
    mask.style.top = (view.top - stage.top) + 'px';
    mask.style.width = view.width + 'px';
    mask.style.height = view.height + 'px';
  }

  function openCrop(source) {
    const view = $('cropCanvas');
    view.width = source.width;
    view.height = source.height;
    view.getContext('2d').drawImage(source, 0, 0);

    state.crop = { source, dragging: false, startX: 0, startY: 0 };
    $('cropRect').style.display = 'none';
    $('cropLayer').hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(layoutMask);
  }

  function closeCrop() {
    state.crop = null;
    $('cropLayer').hidden = true;
    $('cropRect').style.display = 'none';
    document.body.style.overflow = '';
  }

  function pointInMask(evt) {
    const r = $('cropMask').getBoundingClientRect();
    return {
      x: Math.min(Math.max(evt.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(evt.clientY - r.top, 0), r.height),
    };
  }

  function normRect(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
  }

  function showRect(x, y, w, h) {
    const el = $('cropRect');
    el.style.display = 'block';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = Math.max(w, 1) + 'px';
    el.style.height = Math.max(h, 1) + 'px';
  }

  function setScanning(on) {
    const rect = $('cropRect');
    const old = rect.querySelector('.scan-flash');
    if (old) old.remove();
    if (!on) return;
    const line = document.createElement('div');
    line.className = 'scan-flash';
    rect.appendChild(line);
  }

  async function scanSelection(rect) {
    const snap = state.crop && state.crop.source;
    if (!snap) return;

    const maskRect = $('cropMask').getBoundingClientRect();
    const kx = snap.width / maskRect.width;
    const ky = snap.height / maskRect.height;

    const cut = document.createElement('canvas');
    cut.width = Math.max(1, Math.round(rect.w * kx));
    cut.height = Math.max(1, Math.round(rect.h * ky));
    cut.getContext('2d').drawImage(
      snap,
      Math.round(rect.x * kx), Math.round(rect.y * ky), cut.width, cut.height,
      0, 0, cut.width, cut.height
    );

    setScanning(true);
    await wait(60); // 让扫描线先画出来，避免“点了没反应”

    const codes = decodeCanvasWithRetry(cut, { tile: false });
    setScanning(false);

    if (!codes.length) {
      toast('这个区域没扫到二维码，换个范围再试', 'warn');
      return;
    }
    closeCrop();
    handleCodes(codes);
  }

  async function scanFullScreen() {
    const snap = state.crop && state.crop.source;
    if (!snap) return;
    setScanning(true);
    const rect = $('cropRect');
    rect.style.display = 'block';
    rect.style.left = '0px';
    rect.style.top = '0px';
    rect.style.width = '100%';
    rect.style.height = '100%';
    await wait(60);
    const codes = decodeCanvasWithRetry(snap, { thorough: true });
    setScanning(false);
    if (!codes.length) {
      rect.style.display = 'none';
      toast('整屏里没扫到二维码，换用框选试试', 'warn');
      return;
    }
    closeCrop();
    handleCodes(codes);
  }

  /* ───────────── 图片 / 粘贴 / 拖拽 ───────────── */

  async function decodeBlob(blob) {
    if (!blob) return;
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      toast('这个文件不是能读的图片', 'warn');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();

    const codes = decodeCanvasWithRetry(canvas, { thorough: true });
    if (!codes.length) {
      toast('这张图片里没有找到二维码', 'warn');
      return;
    }
    handleCodes(codes);
  }

  /* ───────────── 摄像头 ───────────── */

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('这个浏览器不支持摄像头', 'warn');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      const msg = (err && err.name === 'NotAllowedError')
        ? '摄像头权限被拒绝，请在浏览器地址栏里允许'
        : '打不开摄像头：' + ((err && err.message) || err);
      toast(msg, 'warn');
      return;
    }

    const video = $('camVideo');
    state.cam.stream = stream;
    video.srcObject = stream;
    $('camLayer').hidden = false;
    try { await video.play(); } catch (e) {}

    const tick = () => {
      if (!state.cam.stream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 900 / video.videoWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(video.videoWidth * scale);
        c.height = Math.round(video.videoHeight * scale);
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        const codes = tryDecode(c, { tile: false });
        if (codes.length) {
          stopCamera();
          handleCodes(codes);
          return;
        }
      }
      state.cam.timer = setTimeout(tick, 220);
    };
    tick();
  }

  function stopCamera() {
    clearTimeout(state.cam.timer);
    if (state.cam.stream) {
      state.cam.stream.getTracks().forEach((t) => t.stop());
      state.cam.stream = null;
    }
    $('camVideo').srcObject = null;
    $('camLayer').hidden = true;
  }

  /* ───────────── 初始化 ───────────── */

  function init() {
    loadState();
    $('optAutoCopy').checked = state.settings.autoCopy;
    $('optAutoOpen').checked = state.settings.autoOpen;
    renderHistory();

    $('optAutoCopy').addEventListener('change', (e) => {
      state.settings.autoCopy = e.target.checked;
      saveSettings();
    });
    $('optAutoOpen').addEventListener('change', (e) => {
      state.settings.autoOpen = e.target.checked;
      saveSettings();
    });

    $('btnCapture').addEventListener('click', captureScreen);
    $('btnCamera').addEventListener('click', startCamera);
    $('btnFile').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) decodeBlob(f);
      e.target.value = '';
    });

    $('btnPaste').addEventListener('click', () => {
      toast('按 Ctrl + V 粘贴截图即可', 'warn');
    });

    $('btnCropCancel').addEventListener('click', closeCrop);
    $('btnCropFull').addEventListener('click', scanFullScreen);
    $('btnCamCancel').addEventListener('click', stopCamera);
    $('btnClearHistory').addEventListener('click', () => {
      state.history = [];
      saveHistory();
      renderHistory();
      toast('历史已清空', 'ok');
    });

    // 框选交互
    const mask = $('cropMask');
    mask.addEventListener('pointerdown', (e) => {
      if (!state.crop) return;
      e.preventDefault();
      mask.setPointerCapture(e.pointerId);
      const p = pointInMask(e);
      state.crop.dragging = true;
      state.crop.startX = p.x;
      state.crop.startY = p.y;
      showRect(p.x, p.y, 1, 1);
    });
    mask.addEventListener('pointermove', (e) => {
      if (!state.crop || !state.crop.dragging) return;
      const p = pointInMask(e);
      const r = normRect(state.crop.startX, state.crop.startY, p.x, p.y);
      showRect(r.x, r.y, r.w, r.h);
    });
    mask.addEventListener('pointerup', (e) => {
      if (!state.crop || !state.crop.dragging) return;
      state.crop.dragging = false;
      const p = pointInMask(e);
      const r = normRect(state.crop.startX, state.crop.startY, p.x, p.y);
      showRect(r.x, r.y, r.w, r.h);
      if (r.w < 10 || r.h < 10) {
        $('cropRect').style.display = 'none';
        return;
      }
      scanSelection(r);
    });
    mask.addEventListener('pointercancel', () => {
      if (state.crop) state.crop.dragging = false;
    });

    // 粘贴
    document.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const imgItem = items.find((it) => it.kind === 'file' && it.type && it.type.indexOf('image/') === 0);
      if (!imgItem) return;
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (file) decodeBlob(file);
    });

    // 拖拽
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) decodeBlob(file);
    });

    // Esc 关闭浮层
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('camLayer').hidden) stopCamera();
      else if (!$('cropLayer').hidden) closeCrop();
    });

    window.addEventListener('resize', () => {
      if (!$('cropLayer').hidden) layoutMask();
    });
  }

  /* ───────────── 自检（访问 ?selftest=1 时运行，用于回归验证） ───────────── */

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('加载失败: ' + url));
      img.src = url;
    });
  }

  async function runSelfTest() {
    const out = document.createElement('pre');
    out.id = 'selftest-out';
    out.style.cssText = 'position:fixed;left:0;bottom:0;right:0;max-height:45vh;overflow:auto;margin:0;padding:10px;background:#05070b;color:#7dffb0;font:12px/1.6 ui-monospace,Consolas,monospace;z-index:9999;white-space:pre-wrap;border-top:1px solid #2a3142;';
    document.body.appendChild(out);

    const lines = [];
    const log = (s) => { lines.push(s); out.textContent = lines.join('\n'); };
    let failed = 0;
    const check = (name, ok, detail) => {
      if (!ok) failed++;
      log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  → ' + detail : ''));
    };

    try {
      // 1. 直接解码一张普通二维码图片
      const link = await loadImage('tests/fixtures/link.png');
      const c1 = document.createElement('canvas');
      c1.width = link.width; c1.height = link.height;
      c1.getContext('2d').drawImage(link, 0, 0);
      let codes = decodeCanvasWithRetry(c1, { thorough: true });
      check('本地图片解码', codes.length === 1 && codes[0].data === 'https://example.com/login?id=42',
        JSON.stringify(codes.map((c) => c.data)));

      // 2. WiFi 码解析
      const wifi = await loadImage('tests/fixtures/wifi.png');
      const c2 = document.createElement('canvas');
      c2.width = wifi.width; c2.height = wifi.height;
      c2.getContext('2d').drawImage(wifi, 0, 0);
      codes = decodeCanvasWithRetry(c2, { thorough: true });
      const info = codes.length ? QrDecode.parseContent(codes[0].data) : null;
      check('WiFi 码解析出密码', !!info && info.type === 'wifi' && info.copyText === 'secret123',
        info ? info.type + '/' + info.copyText : 'no-code');

      // 3. 模拟整屏截图：1600×900 的画布里放一个 170px 的小码
      const big = document.createElement('canvas');
      big.width = 1600; big.height = 900;
      const bg = big.getContext('2d');
      bg.fillStyle = '#ffffff';
      bg.fillRect(0, 0, big.width, big.height);
      bg.drawImage(link, 1200, 40, 170, 170);
      codes = decodeCanvasWithRetry(big, { thorough: true });
      check('整屏大图里的小二维码', codes.length === 1 && codes[0].data === 'https://example.com/login?id=42',
        'found=' + codes.length);

      // 4. 一张图里两个二维码
      const two = document.createElement('canvas');
      two.width = 1200; two.height = 500;
      const t = two.getContext('2d');
      t.fillStyle = '#ffffff';
      t.fillRect(0, 0, two.width, two.height);
      t.drawImage(link, 60, 70, 360, 360);
      t.drawImage(wifi, 700, 70, 360, 360);
      codes = decodeCanvasWithRetry(two, { thorough: true });
      const texts = codes.map((c) => c.data).sort();
      check('同屏两个二维码', codes.length === 2 && texts[0].indexOf('WIFI:') === 0,
        JSON.stringify(texts));

      // 5. 界面渲染链路：结果卡片能正常插入
      handleCodes(codeListToFake(codes.slice(0, 1)));
      const cards = document.querySelectorAll('#results .result');
      check('结果卡片渲染', cards.length === 1, 'cards=' + cards.length);
    } catch (err) {
      check('自检未抛异常', false, String(err && err.message || err));
    }

    log(failed ? '── 有 ' + failed + ' 项失败 ──' : '── 全部通过 ──');
    document.title = failed ? 'SELFTEST FAILED' : 'SELFTEST PASSED';
  }

  function codeListToFake(codes) { return codes; }

  function maybeRunSelfTest() {
    if (!/[?&]selftest=1/.test(location.search)) return;
    runSelfTest();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); maybeRunSelfTest(); });
  } else {
    init();
    maybeRunSelfTest();
  }
})();
