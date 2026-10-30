#!/usr/bin/env node
/**
 * 扫码器 · 本地静态服务
 *
 * 为什么需要它：浏览器的「捕获屏幕」需要安全上下文，
 * 用 127.0.0.1 打开比 file:// 稳（部分内核会直接拒绝 file:// 的屏幕共享）。
 *
 * 用法：node server.js [--port 7457] [--no-open] [--idle 20]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return fallback;
}

const BASE_PORT = Number(argValue('--port', 7457)) || 7457;
const NO_OPEN = argv.includes('--no-open');
const IDLE_MINUTES = Number(argValue('--idle', 20)) || 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let lastActivity = Date.now();

function serve(req, res) {
  lastActivity = Date.now();

  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const target = path.resolve(ROOT, '.' + pathname);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/** 找 Edge（app 模式能开一个没有地址栏的独立窗口，更像桌面应用） */
function findEdge() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function openBrowser(url) {
  const edge = findEdge();
  try {
    if (edge) {
      spawn(edge, [`--app=${url}`, '--window-size=1200,880'], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.log('打开浏览器失败，请手动访问：' + url);
  }
}

function start(port, attempt) {
  const server = http.createServer(serve);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      start(port + 1, attempt + 1);
      return;
    }
    console.error('服务启动失败：' + err.message);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  扫码器已就绪 →  ' + url);
    console.log('  关闭窗口后服务会在 ' + IDLE_MINUTES + ' 分钟内自动退出，也可以按 Ctrl+C 结束。');
    console.log('');
    if (!NO_OPEN) openBrowser(url);

    setInterval(() => {
      if (Date.now() - lastActivity > IDLE_MINUTES * 60 * 1000) {
        console.log('长时间没有访问，服务退出。');
        process.exit(0);
      }
    }, 60 * 1000).unref();
  });
}

start(BASE_PORT, 0);
