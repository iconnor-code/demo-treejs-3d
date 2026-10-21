// client.js — 外部控制程序演示：依次发送路径点，方块沿路径移动
//
//   node client.js [square|spiral|helix|wave]   BASE_URL 环境变量可覆盖，默认 http://localhost:3000
//   square/spiral 为平面路径，helix/wave 的 y 随点变化（三维移动）
//
// 逻辑：WS 连接 /ws/controller → 等 hello 确认页面在线 →
//       [发 target → 等服务器推送 state.arrived → 下一点] → 完成退出
import WebSocket from 'ws';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws/controller`;
const fail = (msg) => { console.error('client:', msg); process.exit(1); };

const PATHS = {
  square: {
    speed: 3,
    points: [[6, 0.5, 6], [6, 0.5, -6], [-6, 0.5, -6], [-6, 0.5, 6], [0, 0.5, 0]],
  },
  spiral: {
    speed: 2.5,
    points: Array.from({ length: 26 }, (_, i) => {
      const r = 0.5 + i * 0.35, a = i * 0.7;
      return [+(Math.cos(a) * r).toFixed(2), 0.5, +(Math.sin(a) * r).toFixed(2)];
    }),
  },
  // 三维路径：y 随点变化，展示方块在空间中移动（y ≥ 0.5，防插入地面）
  helix: {
    speed: 2.5,
    points: Array.from({ length: 32 }, (_, i) => {
      const r = 0.5 + i * 0.22, a = i * 0.6, y = 0.5 + i * 0.28;
      return [+(Math.cos(a) * r).toFixed(2), +y.toFixed(2), +(Math.sin(a) * r).toFixed(2)];
    }),
  },
  wave: {
    speed: 3,
    points: Array.from({ length: 25 }, (_, i) => {
      const x = -8 + i * (16 / 24);
      return [+x.toFixed(2), +(3 + 2.5 * Math.sin(i * 0.55)).toFixed(2), +(3 * Math.cos(i * 0.28)).toFixed(2)];
    }),
  },
};

// 消息等待器：waitFor(谓词, 超时) 取下一条匹配的服务器消息；不匹配的先攒着
function createReader(ws) {
  const pending = [];
  const waiters = new Set();
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    for (const w of waiters) {
      if (w.pred(m)) { waiters.delete(w); clearTimeout(w.timer); w.resolve(m); return; }
    }
    pending.push(m);
  });
  return (pred, timeoutMs, what) => new Promise((resolve, reject) => {
    const i = pending.findIndex(pred);
    if (i >= 0) return resolve(pending.splice(i, 1)[0]);
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      waiters.delete(w);
      reject(new Error(`等待 ${what} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    waiters.add(w);
  });
}

async function main() {
  const shape = process.argv[2] ?? 'square';
  const { speed, points } = PATHS[shape] ?? fail(`未知路径 "${shape}"（可选 square | spiral | helix | wave）`);

  const ws = new WebSocket(WS_URL);
  const waitFor = createReader(ws);
  let finished = false;
  ws.on('error', () => fail(`无法连接服务器 ${WS_URL}，先 npm start`));
  ws.on('close', () => { if (!finished) fail('与服务器的连接断开'); });
  ws.on('message', (raw) => {
    // 页面掉线即时失败，而不是等到段超时
    const m = JSON.parse(raw.toString());
    if (m.type === 'pages' && m.count === 0) fail('浏览器页面连接丢失');
  });

  const hello = await waitFor((m) => m.type === 'hello', 5000, '服务器响应');
  if (!hello.pageConnected) fail(`浏览器页面未连接：请先打开 ${BASE}，再运行本脚本`);
  let cur = hello.cube;
  console.log(`路径: ${shape}（${points.length} 个点, speed=${speed}）`);

  for (let i = 0; i < points.length; i++) {
    const [x, y, z] = points[i];
    const t0 = Date.now();
    process.stdout.write(`[${i + 1}/${points.length}] → (${x}, ${y}, ${z}) … `);

    ws.send(JSON.stringify({ type: 'target', x, y, z, speed }));
    const ack = await waitFor((m) => m.type === 'target-ack', 5000, 'target 确认');
    if (!ack.ok) fail(`target 被拒绝: ${ack.error}`);

    // 段超时 = 理论耗时 × 3 + 8s（留足渲染/推送余量）；期间页面掉线由 pages 消息兜底
    const dist = Math.hypot(x - cur.x, y - cur.y, z - cur.z);
    const deadline = (dist / speed) * 1000 * 3 + 8000;
    await waitFor((m) => m.type === 'state' && m.arrived, deadline, '到达');
    cur = { x, y, z };
    console.log(`done ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log('✔ 路径完成');
  finished = true;
  ws.close();
}

main().catch((e) => fail(e.message));
