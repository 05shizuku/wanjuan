// src/philosophy.mjs
export const PHILOSOPHY_VERSION = 'v2.1-cn';

export const PHILOSOPHY_KEEP_DROP = `
【折叠指南：你正在执行一次上下文压缩，请绝对遵循以下原则】

必须丢弃（DROP）：
- 冗长的工具执行日志（如 npm run build 的成功输出，仅保留最后 3 行；若有报错，仅保留报错堆栈）。
- 重复读取同一文件的过程（只保留最后一次修改后的完整读取结果）。
- 无意义的对话过程（如用户连续说的“继续”、“好的”、“下一步”）。
- 已经被推翻的探索路径（如“我试试用 A 方案，不行”，请直接丢弃试错过程，仅保留结论“A 方案不可行”）。

必须保留（KEEP）：
- 引用历史消息或块时，必须写明 ID（如 m0012, b0003），绝不要直接复述原话。
- 如果当前任务未完成，必须在摘要最后明确写出“未完成目标：[具体内容]”。
- 所有文件路径必须写全路径（相对于项目根目录）。
- 带行号的具体文件路径和函数签名（例如 src/dsh.mjs:42）。
- 精确的错误字符串（如 ERR_MODULE_NOT_FOUND）。
- 多轮排查后得出的关键结论（例如“发现是因为宿主注入了空 system 消息”）。
- 工具调用的最终参数（不要保留调用过程，只留调用了什么）。

预算紧张时的优先级（从高到低）：
当前目标 > 决策结论 > 核心代码结构 > 精确错误 > 历史教训
`;

export class Philosophy {
  constructor(version = PHILOSOPHY_VERSION) {
    this.version = version;
  }

  getKeepDropRules() {
    return PHILOSOPHY_KEEP_DROP;
  }

  buildNudge({ candidates }) {
    const lines = [];
    lines.push(`[万卷 压缩建议 - ${this.version}]`);
    lines.push('');
    lines.push('这是一条效率提醒，不是溢出警告。你可以根据当前任务状态选择接受或拒绝。');
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