// server.js — 托管 3D 页面 + WebSocket 服务（页面与外部程序统一走 WS）
//
//   WS /ws/page        浏览器订阅：连接即收 init 快照（重连不丢目标），新目标实时推送；
//                      页面回报 {x,y,z,moving,seq}（500ms 心跳 + 到达即报）
//   WS /ws/controller  外部程序：下发 target / 按需查 status；
//                      服务器主动推送 state（含 arrived）与 pages 在线数，无需轮询
//
// 页面本身仍由 HTTP 静态托管（浏览器加载页面需要 HTTP），业务通讯全部走 WS。
// 方块位置的真实值在浏览器端（rAF 驱动），服务器只保存页面最近回报的状态。
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const threeDir = path.join(__dirname, 'node_modules', 'three');
const PORT = process.env.PORT ?? 3000;
const HOST = process.env.HOST ?? '0.0.0.0';  // 监听所有网卡，局域网设备可直连

// ---------------------------------------------------------------------------
// 内存状态（单进程，重启即清零——demo 取舍，见 README）
// ---------------------------------------------------------------------------
const state = {
  seq: 0,                                   // 目标序号，单调递增；去重与到达判定的锚点
  target: null,                             // 最近一次下发的目标
  cube: { x: 0, y: 0.5, z: 0, moving: false, seq: 0 },  // 浏览器最近回报
};
const pages = new Set();                    // 打开中的页面 WS 连接
const controllers = new Set();              // 打开中的外部程序 WS 连接

function arrivedNow() {
  // arrived 要求页面回报"已执行到最新 seq 且 moving=false"：
  // 直接看 moving 会有竞态——下发后页面还没收到新目标时回报的是旧 moving:false，
  // 会被误判为已到达，导致外部程序瞬间连发路径点。
  return state.target === null
    || (!state.cube.moving && state.cube.seq >= state.target.seq);
}

function statusSnapshot() {
  return {
    seq: state.seq,
    target: state.target,
    cube: { ...state.cube },
    arrived: arrivedNow(),
    pageConnected: pages.size > 0,          // WS 连接即在线，不再需要心跳超时推断
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// 页面回报转发节流：位置取整后整体无变化就不推送（空闲心跳不刷屏，变化仍即时可见）
let lastPushSig = null;
function pushStateToControllers() {
  const snap = statusSnapshot();
  const sig = JSON.stringify([
    snap.seq,
    snap.arrived,
    snap.cube.moving, snap.cube.seq,
    snap.cube.x.toFixed(3), snap.cube.y.toFixed(3), snap.cube.z.toFixed(3),
  ]);
  if (sig === lastPushSig) return;
  lastPushSig = sig;
  for (const c of controllers) send(c, { type: 'state', ...snap });
}

function parseMsg(raw) {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 校验（规则与原 HTTP 版一致）
// ---------------------------------------------------------------------------
function validateTarget(b) {
  if (b == null || typeof b !== 'object' || Array.isArray(b)) {
    return ['payload must be a JSON object'];
  }
  const errs = [];
  for (const k of ['x', 'y', 'z']) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k])) {
      errs.push(`"${k}" must be a finite number`);
    }
  }
  if (typeof b.speed !== 'number' || !Number.isFinite(b.speed)) {
    errs.push('"speed" must be a finite number');
  } else if (b.speed <= 0) {
    // speed=0 永远到不了目标，会让等待到达的一方死锁
    errs.push('"speed" must be > 0');
  }
  return errs;
}

function validState(b) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  return b != null && num(b.x) && num(b.y) && num(b.z)
    && typeof b.moving === 'boolean' && Number.isInteger(b.seq);
}

// ---------------------------------------------------------------------------
// HTTP：仅静态托管
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// 只暴露 three 的两个子目录：build 内 three.module.js → ./three.core.js 相对导入自洽，
// examples/jsm 内 addons 的相对导入也自洽；裸说明符 'three' 由页面 import map 解决。
app.use('/vendor/three/build', express.static(path.join(threeDir, 'build')));
app.use('/vendor/three/jsm', express.static(path.join(threeDir, 'examples', 'jsm')));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// /ws/page — 浏览器页面
// ---------------------------------------------------------------------------
const wssPage = new WebSocketServer({ noServer: true });
wssPage.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  pages.add(ws);
  // 关键：连接建立即重放当前快照，重连/后连的页面不丢目标（页面按 seq 去重）
  send(ws, { type: 'init', seq: state.seq, target: state.target });
  for (const c of controllers) send(c, { type: 'pages', count: pages.size });
  ws.on('message', (raw) => {
    const m = parseMsg(raw);
    if (m?.type !== 'state' || !validState(m)) return;
    Object.assign(state.cube, { x: m.x, y: m.y, z: m.z, moving: m.moving, seq: m.seq });
    // 转发给外部程序：arrived 翻转即时可见，替代轮询；无变化时被节流
    pushStateToControllers();
  });
  ws.on('close', () => {
    pages.delete(ws);
    for (const c of controllers) send(c, { type: 'pages', count: pages.size });
  });
});

// ---------------------------------------------------------------------------
// /ws/controller — 外部程序
// ---------------------------------------------------------------------------
const wssController = new WebSocketServer({ noServer: true });
wssController.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  controllers.add(ws);
  send(ws, { type: 'hello', ...statusSnapshot() });   // 连接即知现状（含页面是否在线）
  ws.on('message', (raw) => {
    const m = parseMsg(raw);
    if (m?.type === 'target') {
      const errs = validateTarget(m);
      if (errs.length) {
        return send(ws, { type: 'target-ack', ok: false, error: errs.join('; ') });
      }
      state.seq += 1;
      state.target = {
        seq: state.seq,
        x: m.x, y: m.y, z: m.z,
        speed: m.speed,
        setAt: new Date().toISOString(),
      };
      for (const p of pages) send(p, { type: 'target', ...state.target });
      send(ws, { type: 'target-ack', ok: true, seq: state.seq, pages: pages.size });
    } else if (m?.type === 'status') {
      send(ws, { type: 'status', ...statusSnapshot() });
    }
  });
  ws.on('close', () => controllers.delete(ws));
});

// 按 URL 分流两个端点
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/ws/page') {
    wssPage.handleUpgrade(req, socket, head, (ws) => wssPage.emit('connection', ws));
  } else if (pathname === '/ws/controller') {
    wssController.handleUpgrade(req, socket, head, (ws) => wssController.emit('connection', ws));
  } else {
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// 空闲连接保活：定时 ping，一个周期无 pong 判死并断开（浏览器/客户端各自触发重连）
// ---------------------------------------------------------------------------
setInterval(() => {
  for (const ws of [...pages, ...controllers]) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, HOST, () => {
  // 0.0.0.0 是监听地址不是可浏览地址，列出各网卡的实际入口（无外部网卡时退回 localhost）
  const urls = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a?.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
  console.log(`server: ${urls.join('  ') || `http://localhost:${PORT}`}  (浏览器打开后运行: npm run demo)`);
});
