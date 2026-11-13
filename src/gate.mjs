// src/gate.mjs
// 增速门：决定何时触发 nudge。
// 规则：
// - grown < 50K 且 用量 < 85% -> silent
// - 85% <= 用量 < 95% -> 门限降至 0.45x (22.5K)
// - 用量 >= 95% -> 紧急路径，门限为 0 (强制触发)

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

  // 计算判定结果
  // currentEst: 当前估算值 (estFinal)
  // lastFoldEst: 上次折叠点的估算值
  // window: 模型窗口大小
  check({ currentEst, lastFoldEst, window }) {
    const grown = currentEst - lastFoldEst;
    const usageRatio = currentEst / window;

    // 紧急路径：>= 95%
    if (usageRatio >= this.criticalWaterMark) {
      return {
        action: 'emergency',
        grown,
        usageRatio,
        threshold: 0,
        shouldNudge: true,
      };
    }

    // 高水位：85% - 95%
    if (usageRatio >= this.highWaterMark) {
      const dynamicThreshold = this.baseThreshold * this.emergencyRatio;
      return {
        action: grown >= dynamicThreshold ? 'nudge' : 'silent',
        grown,
        usageRatio,
        threshold: dynamicThreshold,
        shouldNudge: grown >= dynamicThreshold,
      };
    }

    // 正常水位：< 85%
    return {
      action: grown >= this.baseThreshold ? 'nudge' : 'silent',
      grown,
      usageRatio,
      threshold: this.baseThreshold,
      shouldNudge: grown >= this.baseThreshold,
    };
  }
}