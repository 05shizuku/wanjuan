// src/gate.mjs — v0.9.0-m5.3：水位→动作分类（纯函数，DESIGN M5「gate 入口拆分」兑现）
// 旧 Gate 类（增速门：grown ≥ baseThreshold×0.45 才 nudge）已被 M5.2 的 accept/reject
// 降频生命周期取代——增长阈值语义退役（数据驱动的拒绝降频比增长门槛更贴合真机）。
// 拆分意图保留：0.80/0.95 阈值单点化在此，dsh 只消费动作分类，不再散落魔法数。

export function classifyWaterMark(usageRatio, { highWaterMark = 0.80, criticalWaterMark = 0.95 } = {}) {
  if (usageRatio >= criticalWaterMark) return 'emergency'; // ≥95%：强制保护性折叠
  if (usageRatio >= highWaterMark) return 'nudge';          // ≥80%：nudge 通道
  return 'silent';
}
