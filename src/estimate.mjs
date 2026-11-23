import { readFileSync, writeFileSync, renameSync } from 'node:fs';
// src/estimate.mjs
const BIAS = 1.05;
const PRIOR_WEIGHT_M = 5;
const PRIOR_ALPHA = 0.2;
const MIN_SAMPLES = 5;
const UNKNOWN_WINDOW = 128_000;
const UNKNOWN_OUTPUT = 8_192;

const CLS_KEYS = ['text', 'tool', 'sys', 'dev', 'history_sys', 'history_dev'];

export class Estimator {
  constructor({ models = {}, onWarn } = {}) {
    this.models = models;
    this.onWarn = onWarn ?? (() => {});
    this.calib = new Map();
    this.degraded = [];
  }

  getDegraded() { return [...this.degraded]; }
  clearDegraded() { this.degraded = []; }

  _degrade(kind) {
    if (!this.degraded.includes(kind)) this.degraded.push(kind);
  }

  _warn(msg) { this.onWarn(msg); }

  _lookupModel(provider, model) {
    const p = this.models[provider];
    if (!p || !p[model]) {
      this._warn(`模型窗口未知: ${provider}/${model}，按 128K 保守预算`);
      this._degrade('unknown-model');
      return { window: UNKNOWN_WINDOW, output: UNKNOWN_OUTPUT, khatPrior: 1.0 };
    }
    return p[model];
  }

  _key(provider, model) {
    return JSON.stringify([provider, model]);
  }

  getKhat(provider, model) {
    const info = this._lookupModel(provider, model);
    const prior = info.khatPrior ?? 1.0;
    const rec = this.calib.get(this._key(provider, model));
    if (!rec || rec.n === 0) return prior;
    if (rec.n < MIN_SAMPLES) {
      return (rec.n * rec.khatObserved + PRIOR_WEIGHT_M * prior) / (rec.n + PRIOR_WEIGHT_M);
    }
    return rec.khatObserved;
  }

  // v0.7.9 P1-2：挂载 k̂ 校准持久化文件——EMA 状态跨重启回灌，重启不再冷启动
  // （README「已知局限」冷启动两条的根）。30s 节流落盘，崩溃最多丢 30s 样本。
  attachCalibFile(path) {
    if (this.calibFile) return;
    this.calibFile = path;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      for (const [k, rec] of Object.entries(raw)) this.calib.set(k, rec);
    } catch {}
  }

  getCalibrationState(provider, model) {
    const rec = this.calib.get(this._key(provider, model));
    const n = rec?.n ?? 0;
    return { n, calibrating: n < MIN_SAMPLES };
  }

  observeUsage({ provider, model, usageInputTokens, estRaw, baseline = 0 }) {
    if (!(estRaw > 0)) {
      this._warn(`khat 更新被拒: estRaw=${estRaw}`);
      this._degrade('bad-est-raw');
      return false;
    }
    if (!(usageInputTokens > 0)) {
      this._warn(`khat 更新被拒: usage=${usageInputTokens}`);
      this._degrade('bad-usage');
      return false;
    }
    // v0.7 baseline 附加量模型：k̂ 只吸收「估算误差」（残差 = input − baseline，应 ≈ estRaw），
    // 结构性开销（system/tools/挂载前历史）由 baseline 加法吸收——两者解耦，EMA 快速收敛。
    // input 低于 baseline（宿主压缩了账本不知道的内容）时残差按 0 处理（k̂ 不会变负）。
    // v0.6.30 的 [0.5, 5.0] 钳制保留为安全网（baseline 模型下应极少触发——可观测信号）。
    const residual = Math.max(0, usageInputTokens - baseline);
    const rawObserved = residual / estRaw; // KAHAT-SAMPLE-DIVISION（CI：本文件唯一除法）
    const observed = Math.max(0.5, Math.min(5.0, rawObserved));
    if (rawObserved !== observed) this._degrade('khat-observed-clipped');
    const key = this._key(provider, model);
    const rec = this.calib.get(key) ?? { khatObserved: observed, n: 0 };
    rec.khatObserved = rec.n === 0 ? observed : (1 - PRIOR_ALPHA) * rec.khatObserved + PRIOR_ALPHA * observed;
    rec.n += 1;
    this.calib.set(key, rec);
    // v0.7.9 P1-2：节流落盘（30s）
    if (this.calibFile && Date.now() - (this._calibLastSave ?? 0) > 30 * 1000) {
      this._calibLastSave = Date.now();
      try {
        const obj = {};
        for (const [k, v] of this.calib) obj[k] = v;
        const tpath = this.calibFile + '.tmp';
        writeFileSync(tpath, JSON.stringify(obj), 'utf8');
        renameSync(tpath, this.calibFile);
      } catch {}
    }
    return true;
  }

  estimate(request, { provider, model }) {
    const info = this._lookupModel(provider, model);
    const counts = {
      text: 0, tool: 0, sys: 0, dev: 0, history_sys: 0, history_dev: 0,
    };
    // P1 修复：countedHistory 移入函数内，每次调用独立
    const countedHistory = new Set();

    for (const m of request.messages) {
      // v0.7.6 P2(C1)：负 tok（宿主直传任意值）会使 estFinal 为负 → fits 恒真 → 水位失效。钳 0 + 记 degrade。
      if ((m.tok ?? 0) < 0) this._degrade('negative-tok');
      const tok = Math.max(0, m.tok ?? 0);
      const cls = m.cls;
      const isHistory = m.history === true;

      if (cls === 'sys' && isHistory) {
        if (countedHistory.has('history_sys')) continue;
        countedHistory.add('history_sys');
        counts.history_sys += tok;
      } else if (cls === 'dev' && isHistory) {
        if (countedHistory.has('history_dev')) continue;
        countedHistory.add('history_dev');
        counts.history_dev += tok;
      } else if (CLS_KEYS.includes(cls)) {
        counts[cls] += tok;
      } else {
        this._warn(`未知消息分类: ${cls}，按 text 计`);
        this._degrade('unknown-cls');
        counts.text += tok;
      }
    }

    const estRaw = CLS_KEYS.reduce((s, k) => s + counts[k], 0);
    const khat = this.getKhat(provider, model);
    const estCal = estRaw * khat;
    const estFinal = Math.ceil(estCal * BIAS);
    const { calibrating } = this.getCalibrationState(provider, model);

    return {
      counts, estRaw, khat, estCal, estFinal, calibrating,
      window: info.window, output: info.output,
    };
  }

  fits(request, { provider, model, nudgeReserve = 0 }) {
    const r = this.estimate(request, { provider, model });
    if (nudgeReserve < 0) {
      this._warn(`nudgeReserve 为负: ${nudgeReserve}`);
      this._degrade('bad-nudge-reserve');
      nudgeReserve = 0;
    }
    return r.estFinal <= r.window - r.output - nudgeReserve;
  }
}