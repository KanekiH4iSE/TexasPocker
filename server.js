'use strict';
// HTTP (статика) + WebSocket (игра). Комнаты хранятся в памяти.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Table } = require('./lib/table');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const rooms = new Map();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(table) {
  for (const [pid, ws] of table.conns) send(ws, { t: 'state', s: table.view(pid) });
}

function makeTable() {
  const code = newCode();
  const table = new Table(code, {}, broadcast);
  table.conns = new Map();
  rooms.set(code, table);
  return table;
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let rel;
  try { rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); } catch (e) { rel = '/'; }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });

function attach(ctx, ws, table, p) {
  const old = table.conns.get(p.id);
  if (old && old !== ws) { old.ctx = null; old.close(); }
  table.conns.set(p.id, ws);
  ctx.table = table;
  ctx.pid = p.id;
  send(ws, { t: 'joined', code: table.code, token: p.token, id: p.id });
  table.setConnected(p.id, true);
}

function detach(ctx, ws) {
  const { table, pid } = ctx;
  if (!table) return;
  if (table.conns.get(pid) === ws) {
    table.conns.delete(pid);
    table.setConnected(pid, false);
  }
}

wss.on('connection', (ws) => {
  const ctx = { table: null, pid: null };
  ws.ctx = ctx;
  ws.isAlive = true;
  let budget = 20;
  const refill = setInterval(() => { budget = 20; }, 1000);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (--budget < 0) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try {
      handle(ctx, ws, m);
    } catch (e) {
      send(ws, { t: 'error', msg: e.message });
    }
  });

  ws.on('close', () => {
    clearInterval(refill);
    if (ws.ctx) detach(ws.ctx, ws);
  });
});

function handle(ctx, ws, m) {
  if (m.t === 'create') {
    if (ctx.table) throw new Error('Вы уже за столом');
    const table = makeTable();
    attach(ctx, ws, table, table.addPlayer(m.name));
    return;
  }
  if (m.t === 'join') {
    if (ctx.table) throw new Error('Вы уже за столом');
    const table = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!table) throw new Error('Комната не найдена');
    const known = m.token ? table.byToken(String(m.token)) : null;
    attach(ctx, ws, table, known || table.addPlayer(m.name));
    return;
  }
  const { table, pid } = ctx;
  if (!table) throw new Error('Сначала войдите в комнату');
  switch (m.t) {
    case 'start': table.start(pid); break;
    case 'act': table.act(pid, String(m.action), m.amount); break;
    case 'rebuy': table.rebuy(pid); break;
    case 'leave': {
      table.conns.delete(pid);
      table.removePlayer(pid);
      ctx.table = null; ctx.pid = null;
      send(ws, { t: 'left' });
      if (table.players.length === 0) { table.destroy(); rooms.delete(table.code); }
      break;
    }
    default: throw new Error('Неизвестная команда');
  }
}

// Живость соединений: Render и мобильные сети рвут "молчащие" сокеты.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// Пустые комнаты без подключений живут 10 минут.
setInterval(() => {
  for (const [code, t] of rooms) {
    if (t.isEmpty() && Date.now() - t.lastActive > 10 * 60 * 1000) {
      t.destroy();
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => console.log(`Poker on http://localhost:${PORT}`));
