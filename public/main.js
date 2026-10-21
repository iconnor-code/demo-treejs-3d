// main.js — Three.js 场景 + WebSocket 订阅 + 移动循环 + 轨迹 + 状态回报
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// 场景基础
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141c);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(10, 9, 12);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;   // 不许把相机钻到地面以下

// 地面 + 网格
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x1b212c, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(40, 40, 0x2e3a4e, 0x232b38);
grid.position.y = 0.001;                       // 防 z-fighting
scene.add(grid);

// 光照
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(8, 12, 6);
sun.castShadow = true;
sun.shadow.camera.left = sun.shadow.camera.bottom = -15;
sun.shadow.camera.right = sun.shadow.camera.top = 15;
scene.add(sun);

// 方块（本体看不出旋转，顶部加个小锥指示朝向，锥尖指 +Z 即"前方"）
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xff8a3d }),
);
cube.position.set(0, 0.5, 0);
cube.castShadow = true;
const nose = new THREE.Mesh(
  new THREE.ConeGeometry(0.12, 0.35),
  new THREE.MeshStandardMaterial({ color: 0xffd08a }),
);
nose.rotation.x = Math.PI / 2;                  // 锥尖从 +Y 转向 +Z
nose.position.set(0, 0.75, 0);
cube.add(nose);
scene.add(cube);

// 目标标记：目标点小球 + 目标→地面垂直参考线（读出高度）+ 地面投影处脉动圆环
const marker = new THREE.Mesh(
  new THREE.SphereGeometry(0.15),
  new THREE.MeshBasicMaterial({ color: 0x4fc3f7 }),
);
const markerRing = new THREE.Mesh(
  new THREE.RingGeometry(0.45, 0.55),
  new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
);
markerRing.rotation.x = -Math.PI / 2;
const dropGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const dropLine = new THREE.Line(dropGeo, new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.35 }));
marker.visible = markerRing.visible = dropLine.visible = false;
scene.add(marker, markerRing, dropLine);

// 方块 → 目标连线（两点线，每帧更新第二点）
const linkGeo = new THREE.BufferGeometry().setFromPoints([cube.position, cube.position]);
const linkLine = new THREE.Line(linkGeo, new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.4 }));
linkLine.visible = false;
scene.add(linkLine);

// 轨迹：预分配缓冲 + drawRange 增长（THREE.Line 动态追加的标准做法）
const MAX_POINTS = 5000;
const trailPos = new Float32Array(MAX_POINTS * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailPos.set([0, 0.5, 0]);                      // 起点
trailGeo.setDrawRange(0, 1);
let trailCount = 1;
const lastTrail = new THREE.Vector3(0, 0.5, 0);
scene.add(new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x4fc3f7 })));

// ---------------------------------------------------------------------------
// 状态与 WebSocket
// ---------------------------------------------------------------------------
let target = null;          // 最近收到的目标 {seq, x, y, z, speed}
let lastSeq = 0;            // 已应用的最大 seq（重连 init 重放同 seq → 忽略）
let moving = false;
let hudWs = 'connecting…';
let ws = null;

function reportState() {
  if (ws?.readyState !== WebSocket.OPEN) return;  // 断线时静默，重连后心跳补上
  ws.send(JSON.stringify({
    type: 'state',
    x: cube.position.x, y: cube.position.y, z: cube.position.z,
    moving, seq: lastSeq,
  }));
}
setInterval(reportState, 500);   // 心跳：空闲时也报 → 外部程序拿到最新位置与 arrived

function applyTarget(t) {
  if (!t || t.seq <= lastSeq) return;           // seq 去重，重放不回退
  lastSeq = t.seq;
  target = t;
  moving = true;
  marker.position.set(t.x, t.y, t.z);
  markerRing.position.set(t.x, 0.02, t.z);       // 圆环始终贴地：目标的水平投影
  dropGeo.setFromPoints([marker.position, new THREE.Vector3(t.x, 0, t.z)]);
  marker.visible = markerRing.visible = dropLine.visible = linkLine.visible = true;
  reportState();                                // 收到即报，服务器 cube.seq 尽快对齐
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/page`);
  ws.onopen = () => { hudWs = 'connected'; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'init') {
      // init 是服务器当前纪元的权威快照：服务器重启后 seq 从 0 重新计数，
      // 本地残留的旧 lastSeq 会让所有新目标被当作重放丢弃，必须先清零
      lastSeq = 0;
      applyTarget(m.target);   // 连接即重放快照，断线重连不丢目标
    } else if (m.type === 'target') applyTarget(m);
  };
  ws.onclose = () => {
    hudWs = 'reconnecting…';
    setTimeout(connect, 2000);                   // 原生 WS 不自动重连，自己补上
  };
}
connect();

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
setInterval(() => {
  const p = cube.position;
  const tgt = target
    ? `(${target.x}, ${target.y}, ${target.z}) speed=${target.speed}`
    : '—';
  hud.textContent =
    `ws:     ${hudWs}\n` +
    `seq:    ${lastSeq}\n` +
    `target: ${tgt}\n` +
    `moving: ${moving}\n` +
    `pos:    (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
}, 250);

// ---------------------------------------------------------------------------
// 移动循环
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const ARRIVE_EPS = 0.01;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);   // 钳制：后台标签恢复时不瞬移穿靶

  if (target && moving) {
    const dx = target.x - cube.position.x;
    const dy = target.y - cube.position.y;
    const dz = target.z - cube.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = target.speed * dt;
    if (dist <= Math.max(step, ARRIVE_EPS)) {   // 本帧跨过目标 → 吸附并到达
      cube.position.set(target.x, target.y, target.z);
      moving = false;
      marker.visible = markerRing.visible = dropLine.visible = linkLine.visible = false;
      reportState();                            // 到达立即回报 → 推给外部程序的 arrived 及时翻转
    } else {
      cube.position.x += (dx / dist) * step;
      cube.position.y += (dy / dist) * step;
      cube.position.z += (dz / dist) * step;
      cube.rotation.y = Math.atan2(dx, dz);     // 前方=+Z 约定，朝向移动方向
      linkGeo.setFromPoints([cube.position, new THREE.Vector3(target.x, target.y, target.z)]);
      if (trailCount < MAX_POINTS && lastTrail.distanceTo(cube.position) >= 0.15) {
        const i = trailCount * 3;
        trailPos[i] = cube.position.x;
        trailPos[i + 1] = cube.position.y;
        trailPos[i + 2] = cube.position.z;
        trailCount += 1;
        trailGeo.setDrawRange(0, trailCount);
        trailGeo.attributes.position.needsUpdate = true;
        lastTrail.copy(cube.position);
      }
    }
  }

  // 目标标记脉动
  const t = clock.elapsedTime;
  const s = 1 + 0.15 * Math.sin(4 * t);
  markerRing.scale.set(s, s, s);

  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
