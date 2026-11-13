// src/estimate.mjs
// 唯一 token 估算函数。三段管线：raw → ×khat → ×1.05 偏置。
// 校准作用域 (provider, model)，键 = JSON.stringify([p, m])。
// khat：n<5 贝叶斯混合（m=5），n>=5 用纯 observed（防先验 <1 吃掉偏置）。
// history_sys/history_dev 全会话只计一次（防 #6474 重复计费）。
// 未知模型明着降级 128K + warn，绝不悄悄钳 output。
// 失败 loud：所有拒绝更新/降级都进 degraded 列表，不静默。
// M1 单价全为 1（models.json 的 unitPrice），est_raw 即分类计数之和。

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
    this.countedHistory = new Set();
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

  getCalibrationState(provider, model) {
    const rec = this.calib.get(this._key(provider, model));
    const n = rec?.n ?? 0;
    return { n, calibrating: n < MIN_SAMPLES };
  }

  observeUsage({ provider, model, usageInputTokens, estRaw }) {
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
    const observed = usageInputTokens / estRaw; // KAHAT-SAMPLE-DIVISION
    const key = this._key(provider, model);
    const rec = this.calib.get(key) ?? { khatObserved: observed, n: 0 };
    rec.khatObserved = rec.n === 0 ? observed : (1 - PRIOR_ALPHA) * rec.khatObserved + PRIOR_ALPHA * observed;
    rec.n += 1;
    this.calib.set(key, rec);
    return true;
  }

  estimate(request, { provider, model }) {
    const info = this._lookupModel(provider, model);
    const counts = {
      text: 0, tool: 0, sys: 0, dev: 0, history_sys: 0, history_dev: 0,
    };

    for (const m of request.messages) {
      const tok = m.tok ?? 0;
      const cls = m.cls;
      const isHistory = m.history === true;

      if (cls === 'sys' && isHistory) {
        if (this.countedHistory.has('history_sys')) continue;
        this.countedHistory.add('history_sys');
        counts.history_sys += tok;
      } else if (cls === 'dev' && isHistory) {
        if (this.countedHistory.has('history_dev')) continue;
        this.countedHistory.add('history_dev');
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