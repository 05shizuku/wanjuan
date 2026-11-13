// src/gate.mjs
// 增速门：决定何时触发 nudge。
// A5 修复：所有增长计算一律基于 est_raw（纯结构），与 khat 和 usage 解耦。

export class Gate {
  constructor({
    baseThreshold = 50_000,
    highWaterMark = 0.85,
    criticalWaterMark = 0.95,
    emergencyRatio = 0.45,
  } = {}) {
    this.baseThreshold = baseThreshold;
    this.highWaterMark = highWaterMark;
    this.criticalWaterMark = criticalWaterMark;
    this.emergencyRatio = emergencyRatio;
  }

  // currentEstRaw: 当前原生估算的 est_raw
  // lastFoldEstRaw: 上次折叠点的 est_raw
  // estFinal: 当前最终估算值（用于算 usage 水位）
  // window: 窗口大小
  check({ currentEstRaw, lastFoldEstRaw, estFinal, window }) {
    const grown = currentEstRaw - lastFoldEstRaw;
    const usageRatio = estFinal / window;

    if (usageRatio >= this.criticalWaterMark) {
      return { action: 'emergency', grown, usageRatio, threshold: 0, shouldNudge: true };
    }

    if (usageRatio >= this.highWaterMark) {
      const dynamicThreshold = this.baseThreshold * this.emergencyRatio;
      return {
        action: grown >= dynamicThreshold ? 'nudge' : 'silent',
        grown, usageRatio,
        threshold: dynamicThreshold,
        shouldNudge: grown >= dynamicThreshold,
      };
    }

    return {
      action: grown >= this.baseThreshold ? 'nudge' : 'silent',
      grown, usageRatio,
      threshold: this.baseThreshold,
      shouldNudge: grown >= this.baseThreshold,
    };
  }
}