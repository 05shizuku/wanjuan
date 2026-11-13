// src/philosophy.mjs
// 哲学文本（KEEP/DROP）与 nudge 注入话术。
// 版本化：v1。修改措辞会影响模型行为，需在账本记 cfg 事件。

export const PHILOSOPHY_VERSION = 'v1';

export const PHILOSOPHY_KEEP_DROP = `
[KEEP 规则]
- 带行号的路径、签名与承重代码行
- 精确的错误串与异常堆栈
- 带有理由的决策 (为什么选 A 不选 B)
- 精确的数值、配置项、环境变量
- 目标的演化过程
- 必要的历史消息引用 (mNNNNN)

[DROP 规则]
- 用完即弃的日志、重复读取的输出
- 死胡同（保留教训即可，丢弃具体过程）
- 冗长的过程叙述
- 已经完成的工具调用的中间结果

[预算紧张时的优先级]
目标 > 决策 > 工件 > 结论 > 教训
`;

export class Philosophy {
  constructor(version = PHILOSOPHY_VERSION) {
    this.version = version;
  }

  getKeepDropRules() {
    return PHILOSOPHY_KEEP_DROP;
  }

  // 生成注入给模型的 nudge 文本
  // 严禁包含当前的填充比例（如“还有 80% 空间”），防止模型锚定。
  buildNudge({ candidates }) {
    const lines = [];
    lines.push(`[万卷 压缩建议 - ${this.version}]`);
    lines.push('');
    lines.push('这是一条效率提醒，不是溢出警告。你可以根据当前任务状态选择，也可以拒绝。');
    lines.push('如果你认为应当压缩，请调用 `compress` 工具；如果不需要，可以直接忽略或调用 `decline_compress`。');
    lines.push('');
    lines.push('当前推荐的候选区间：');
    
    if (candidates.length === 0) {
      lines.push('（暂无符合条件的区间）');
    } else {
      candidates.forEach((c) => {
        lines.push(`- 区间 ${c.range[0]} ~ ${c.range[1]}：${c.msgCount} 条消息，约 ${c.srcTok} tokens。主题：${c.topics || '未标注'}`);
      });
    }

    lines.push('');
    lines.push('【摘要提取指南】');
    lines.push(this.getKeepDropRules());

    return lines.join('\n');
  }
}