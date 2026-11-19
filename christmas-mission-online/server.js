'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = process.env.ADMIN_PIN || crypto.randomBytes(4).toString('hex');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'missions.json');
const MAX_BODY = 16000;
const MAX_PARTICIPANTS = 300;
const clients = new Set();
const rate = new Map();
let state = { participants: [], draws: [], paused: false, createdAt: new Date().toISOString() };

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && Array.isArray(saved.participants) && Array.isArray(saved.draws)) {
    state = { ...state, ...saved, paused: !!saved.paused };
  }
} catch (error) { if (error.code !== 'ENOENT') console.warn('Could not load data:', error.message); }

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
function error(res, status, message) { json(res, status, { error: message }); }
function publicState() {
  const count = state.participants.reduce((n, p) => n + p.missions.length, 0);
  return { participants: state.participants.length, total: count, drawn: state.draws.length, remaining: count - state.draws.length,
    paused: state.paused, lastDraw: state.draws.at(-1) || null, createdAt: state.createdAt };
}
function adminState() { return { ...publicState(), submissions: state.participants.map(({ id, name, missions, updatedAt }) => ({ id, name, missions, updatedAt })), draws: state.draws }; }
function broadcast() {
  const payload = `event: update\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}
function isAdmin(req) {
  const supplied = req.headers['x-admin-pin'];
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied); const b = Buffer.from(ADMIN_PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function throttle(req, key, limit = 25) {
  const ip = (req.socket.remoteAddress || 'unknown') + ':' + key;
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); rate.set(ip, arr);
  return arr.length <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rate) if (v.every(t => now - t > 60000)) rate.delete(k); }, 60000).unref();
setInterval(() => { for (const c of clients) { try { c.write(': keepalive\n\n'); } catch { clients.delete(c); } } }, 25000).unref();
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, text = '';
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('요청 크기가 너무 큽니다.')); req.destroy(); } else text += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('올바르지 않은 요청입니다.')); } });
    req.on('error', reject);
  });
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function staticFile(req, res, pathname) {
  let filename = pathname === '/' || pathname === '/admin' ? 'index.html' : pathname.slice(1);
  const full = path.resolve(__dirname, 'public', filename);
  if (!full.startsWith(path.resolve(__dirname, 'public') + path.sep)) return error(res, 403, '접근할 수 없습니다.');
  fs.readFile(full, (err, data) => {
    if (err) return error(res, 404, '페이지를 찾을 수 없습니다.');
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, publicState());
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: update\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && p === '/api/admin') {
      if (!isAdmin(req)) return error(res, 401, '운영자 PIN이 올바르지 않습니다.');
      return json(res, 200, adminState());
    }
    if (req.method === 'POST' && p === '/api/submit') {
      if (!throttle(req, 'submit')) return error(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      if (state.paused) return error(res, 403, '현재 미션 제출이 마감되었습니다.');
      const body = await readBody(req);
      const id = String(body.id || '');
      const name = String(body.name || '').trim();
      const missions = Array.isArray(body.missions) ? body.missions.map(m => String(m).trim()) : [];
      if (!/^[a-f0-9-]{20,80}$/i.test(id)) return error(res, 400, '참가자 식별값이 올바르지 않습니다.');
      if (!name || name.length > 30) return error(res, 400, '이름은 1~30자로 입력해주세요.');
      if (missions.length < 1 || missions.length > 5 || missions.some(m => !m || m.length > 120)) return error(res, 400, '미션을 1~5개 입력해주세요. 각 미션은 120자 이하여야 합니다.');
      if (new Set(missions).size !== missions.length) return error(res, 400, '같은 미션을 중복 입력할 수 없습니다.');
      const existing = state.participants.find(p => p.id === id);
      if (existing && state.draws.length > 0) return error(res, 403, '추첨 시작 후에는 기존 미션을 수정할 수 없습니다.');
      if (!existing && state.participants.length >= MAX_PARTICIPANTS) return error(res, 403, '참가자 정원이 가득 찼습니다.');
      if (existing) { existing.name = name; existing.missions = missions.map((text, i) => ({ id: `${id}:${i}`, text })); existing.updatedAt = new Date().toISOString(); }
      else state.participants.push({ id, name, missions: missions.map((text, i) => ({ id: `${id}:${i}`, text })), updatedAt: new Date().toISOString() });
      save(); broadcast(); return json(res, 200, { ok: true, ...publicState() });
    }
    if (req.method === 'POST' && p.startsWith('/api/admin/')) {
      if (!throttle(req, 'admin', 50)) return error(res, 429, '요청이 너무 많습니다.');
      if (!isAdmin(req)) return error(res, 401, '운영자 PIN이 올바르지 않습니다.');
      const action = p.slice('/api/admin/'.length);
      if (action === 'draw') {
        const taken = new Set(state.draws.map(d => d.id));
        const choices = state.participants.flatMap(p => p.missions.map(m => ({ id: m.id, text: m.text, author: p.name }))).filter(m => !taken.has(m.id));
        if (!choices.length) return error(res, 400, '남은 미션이 없습니다.');
        state.draws.push({ ...choices[crypto.randomInt(choices.length)], drawnAt: new Date().toISOString() });
      } else if (action === 'undo') {
        if (!state.draws.length) return error(res, 400, '취소할 추첨이 없습니다.');
        state.draws.pop();
      } else if (action === 'pause') {
        const body = await readBody(req);
        state.paused = !!body.paused;
      } else if (action === 'reset') {
        const body = await readBody(req);
        if (body.confirm !== 'RESET') return error(res, 400, '초기화 확인값이 올바르지 않습니다.');
        state = { participants: [], draws: [], paused: false, createdAt: new Date().toISOString() };
      } else return error(res, 404, '잘못된 명령입니다.');
      save(); broadcast(); return json(res, 200, adminState());
    }
    if (req.method === 'GET') return staticFile(req, res, p);
    return error(res, 404, '페이지를 찾을 수 없습니다.');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return error(res, 400, err.message || '서버 오류가 발생했습니다.');
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Christmas Mission: http://localhost:${PORT}`);
  if (!process.env.ADMIN_PIN) console.log(`Admin PIN (automatically generated): ${ADMIN_PIN}`);
  else console.log('Admin PIN: configured through environment');
});
