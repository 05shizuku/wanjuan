// v0.9.0-m5.3：Gate 拆分接线 + Observer/Fingerprinter 终局删除（P2-11 清零）
const fs = require('fs');
function mkRep(state) {
  const done = [];
  return { done, rep(name, oldS, newS) {
    for (const eol of ['\r\n', '\n']) {
      const o = oldS.split('\n').join(eol);
      if (state.s.includes(o)) { state.s = state.s.replace(o, newS.split('\n').join(eol)); done.push(name + ' ✓'); return; }
    }
    done.push(name + ' ✗未命中');
  } };
}
// 1) gate.mjs 重写
fs.writeFileSync('E:/大肥鱼/wanjuan/src/gate.mjs',
`// src/gate.mjs — v0.9.0-m5.3：水位→动作分类（纯函数，DESIGN M5「gate 入口拆分」兑现）
// 旧 Gate 类（增速门：grown ≥ baseThreshold×0.45 才 nudge）已被 M5.2 的 accept/reject
// 降频生命周期取代——增长阈值语义退役（数据驱动的拒绝降频比增长门槛更贴合真机）。
// 拆分意图保留：0.80/0.95 阈值单点化在此，dsh 只消费动作分类，不再散落魔法数。

export function classifyWaterMark(usageRatio, { highWaterMark = 0.80, criticalWaterMark = 0.95 } = {}) {
  if (usageRatio >= criticalWaterMark) return 'emergency'; // ≥95%：强制保护性折叠
  if (usageRatio >= highWaterMark) return 'nudge';          // ≥80%：nudge 通道
  return 'silent';
}
`, 'utf8');
console.log('gate.mjs 重写 ✓');
// 2) 删除死类文件与测试
for (const f of ['src/observe.mjs', 'src/fingerprint.mjs', 'test/observe.test.mjs', 'test/observe.failure.test.mjs', 'test/fingerprint.test.mjs', 'test/fingerprint.failure.test.mjs']) {
  const p = 'E:/大肥鱼/wanjuan/' + f;
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(f + ' 已删除 ✓'); }
}
// 3) gate.test.mjs 重写
fs.writeFileSync('E:/大肥鱼/wanjuan/test/gate.test.mjs',
`// test/gate.test.mjs — v0.9.0-m5.3：classifyWaterMark 边界（替代旧 Gate 增速门测试）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWaterMark } from '../src/gate.mjs';

test('classifyWaterMark：三段边界（0.80/0.95）', () => {
  assert.equal(classifyWaterMark(0.5), 'silent');
  assert.equal(classifyWaterMark(0.79), 'silent');
  assert.equal(classifyWaterMark(0.80), 'nudge');
  assert.equal(classifyWaterMark(0.94), 'nudge');
  assert.equal(classifyWaterMark(0.95), 'emergency');
  assert.equal(classifyWaterMark(1.2), 'emergency');
});

test('classifyWaterMark：阈值可配（不对齐内联值的未来留门）', () => {
  assert.equal(classifyWaterMark(0.7, { highWaterMark: 0.65 }), 'nudge');
  assert.equal(classifyWaterMark(0.9, { criticalWaterMark: 0.85 }), 'emergency');
});
`, 'utf8');
console.log('gate.test.mjs 重写 ✓');
// 4) index.mjs
{
  const p = 'E:/大肥鱼/wanjuan/src/index.mjs';
  const st = { s: fs.readFileSync(p, 'utf8') };
  const r = mkRep(st);
  r.rep('I1', "  const observer = new Observer({ estimator });\n  const fingerprinter = new Fingerprinter({ ledger, sampleEvery });\n", "");
  r.rep('I2', "  const gate = new Gate(gateOptions);\n", "");
  r.rep('I3', "    dir, store, ledger, estimator, observer, \n    fingerprinter, diagnoser, blocks, compressor, restorer,\n    gate, nudge",
    "    dir, store, ledger, estimator,\n    diagnoser, blocks, compressor, restorer,\n    nudge");
  r.rep('I4', "export { Observer } from './observe.mjs';\n", "");
  r.rep('I5', "export { Fingerprinter } from './fingerprint.mjs';\n", "");
  r.rep('I6', "export { Gate } from './gate.mjs';", "export { classifyWaterMark } from './gate.mjs'; // v0.9.0-m5.3：水位→动作分类（Gate 增速门语义退役）");
  r.rep('I7', "  gateOptions,\n", "");
  r.rep('I8', "  sampleEvery,\n", "");
  fs.writeFileSync(p, st.s, 'utf8');
  console.log('--- index.mjs ---\n' + r.done.join('\n'));
}
// 5) index.test.mjs
{
  const p = 'E:/大肥鱼/wanjuan/test/index.test.mjs';
  const st = { s: fs.readFileSync(p, 'utf8') };
  const r = mkRep(st);
  r.rep('T1', "  assert.equal(typeof WJ.Observer, 'function');\n", "");
  r.rep('T2', "  assert.equal(typeof WJ.Fingerprinter, 'function');\n", "");
  r.rep('T3', "  assert.equal(typeof WJ.Gate, 'function');\n", "  assert.equal(typeof WJ.classifyWaterMark, 'function'); // v0.9.0-m5.3");
  r.rep('T4',
    "    const est = wj.observer.beforeRequest({\n      provider: 'deepseek', model: 'deepseek-chat',\n      messages: [{ cls: 'text', tok: 100 }],\n    });\n    assert.equal(est.estRaw, 100);\n\n" +
    "    const rec = wj.observer.afterRequest({\n      provider: 'deepseek', model: 'deepseek-chat',\n      est, usage: { input_tokens: 100, cached: 100 },\n    });\n    assert.equal(rec.calibOk, true);",
    "    // v0.9.0-m5.3：Observer 类退役——k̂ 校准直连 estimator（与生产路径同款）\n" +
    "    const est = wj.estimator.estimate({ messages: [{ cls: 'text', tok: 100 }] }, { provider: 'deepseek', model: 'deepseek-chat' });\n    assert.equal(est.estRaw, 100);\n\n" +
    "    wj.estimator.observeUsage({ provider: 'deepseek', model: 'deepseek-chat', usageInputTokens: 100, estRaw: est.estRaw });\n" +
    "    assert.equal(wj.estimator.getCalibrationState('deepseek', 'deepseek-chat').n, 1);");
  r.rep('T5',
    "test('createWanjuan：fp 与 ledger 共享同一实例', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'wj-idx-'));\n  try {\n    const wj = WJ.createWanjuan({ dir });\n    wj.ledger.recordMsg({ id: 'm1', tok: 10, bytes: 100 });\n    assert.equal(wj.fingerprinter.ledger, wj.ledger);\n    assert.equal(wj.fingerprinter.checkLight(wj.ledger.getActiveMessages()), true);\n  } finally { rmSync(dir, { recursive: true, force: true }); }\n});\n\n",
    "");
  r.rep('T6',
    "    const gateRes = wj.gate.check({\n      currentEstRaw: 130_000,\n      lastFoldEstRaw: 50_000,\n      estFinal: 130_000,\n      window: 200_000\n    });\n    assert.equal(gateRes.action, 'nudge');",
    "    // v0.9.0-m5.3：Gate.check 退役——classifyWaterMark 边界\n    assert.equal(WJ.classifyWaterMark(130_000 / 200_000), 'silent');\n    assert.equal(WJ.classifyWaterMark(0.85), 'nudge');");
  fs.writeFileSync(p, st.s, 'utf8');
  console.log('--- index.test.mjs ---\n' + r.done.join('\n'));
}
// 6) dsh.mjs 接线
{
  const p = 'E:/大肥鱼/wanjuan/src/dsh.mjs';
  const st = { s: fs.readFileSync(p, 'utf8') };
  const r = mkRep(st);
  r.rep('D-import', "import { LockManager } from './lock.mjs'; // v0.8.0 根锁",
    "import { LockManager } from './lock.mjs'; // v0.8.0 根锁\nimport { classifyWaterMark } from './gate.mjs'; // v0.9.0-m5.3：水位→动作分类（阈值单点化）");
  r.rep('D-const', "  const FORCE_FOLD_THRESHOLD = 0.95; // 强折阈值：95%\n", "");
  r.rep('D-wire1', "        if (usageRatio >= FORCE_FOLD_THRESHOLD) {",
    "        if (classifyWaterMark(usageRatio) === 'emergency') { // v0.9.0-m5.3：≥95%（阈值单点化于 gate.mjs）");
  r.rep('D-wire2', "        } else if (usageRatio >= 0.80) {",
    "        } else if (classifyWaterMark(usageRatio) === 'nudge') { // v0.9.0-m5.3：≥80%（阈值单点化于 gate.mjs）");
  fs.writeFileSync(p, st.s, 'utf8');
  console.log('--- dsh.mjs ---\n' + r.done.join('\n'));
}
// 7) README 三行
{
  const p = 'E:/大肥鱼/wanjuan/README.md';
  const st = { s: fs.readFileSync(p, 'utf8') };
  const r = mkRep(st);
  r.rep('R1', "| `gate` | 有测试（2 项）、未接线 | L2 决策层；阈值与 dsh 内联值（0.80/0.95）对齐后接入 |",
    "| `gate` | ✅ **v0.9.0-m5.3 已拆分接线**（`classifyWaterMark` 纯函数，0.80/0.95 阈值单点化；旧增速门语义由 M5.2 降频生命周期取代） | L2 决策层如需增长门可基于此扩展 |");
  r.rep('R2', "| `Observer` | 有测试（7 项）、未接线 | 与 Diagnoser 两套遥测待合并 |",
    "| `Observer` | ❌ **v0.9.0-m5.3 已删除**（薄壳被生产内联超越：k̂ 校准直连 estimator + baseline/degraded/持久化） | — |");
  r.rep('R3', "| `fingerprint` | ✅ 已全线接线（v0.6.19 观察 + **v0.7.1 精确驱逐**） | `turn/end` 限流对账：seq < 表面最小值的零误驱逐（宿主压缩必从最老处",
    "| `fingerprint` 类 | ❌ **v0.9.0-m5.3 类已删除**（M5.1 内联探针为维护版：readOk/drift 护栏 + 驱逐明细审计） | 采样对账算法在 git 历史 |");
  fs.writeFileSync(p, st.s, 'utf8');
  console.log('--- README.md ---\n' + r.done.join('\n'));
}
console.log('== v0.9.0-m5.3 手术完成 ==');
