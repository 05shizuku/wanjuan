// src/compress.mjs
// L3 执行：折叠（手动模式，无门）。
// 核心流程：校验区间 -> 写 raw -> 写 block meta -> 记 fold 事件。
// 失败原子性：如果 raw 写入成功但后续失败，清理 raw，不留孤儿。

import { InvariantError } from './ledger.mjs';

export class Compressor {
  constructor({ ledger, blocks }) {
    this.ledger = ledger;
    this.blocks = blocks;
    this.blockCounter = 0;
  }

  _nextBlockId() {
    this.blockCounter += 1;
    return `b${this.blockCounter}`;
  }

  // 手动压缩区间
  compress({ range, summary, topics = [], tier = 1, sumTok = 0 }) {
    const [startId, endId] = range;
    const activeMsgs = this.ledger.getActiveMessages();

    // 1. 校验区间连续性和合法性
    const startIndex = activeMsgs.findIndex((m) => m.id === startId);
    const endIndex = activeMsgs.findIndex((m) => m.id === endId);

    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
      throw new InvariantError('归属唯一', `区间 ${range} 无效或不存在于活跃消息中`);
    }

    const toFold = activeMsgs.slice(startIndex, endIndex + 1);
    const blockId = this._nextBlockId();
    const srcTok = toFold.reduce((s, m) => s + (m.tok || 0), 0);
    const rawRef = `block.${blockId}.raw.jsonl`;

    // 2. 先写 raw 原文（第二事实源）
    // 如果这里失败，会直接抛出，不会影响账本
    this.blocks.writeRaw(blockId, toFold);

    try {
      // 3. 写 block meta 元数据
      this.blocks.writeBlockMeta(blockId, {
        id: blockId,
        tier,
        range,
        srcTok,
        sumTok,
        summary,
        topics,
        rawRef,
        createdAt: Date.now(),
      });

      // 4. 记录 fold 事件（账本状态变更）
      this.ledger.recordFold({
        block: blockId,
        range,
        srcTok,
        sumTok,
        tier,
        rawRef,
      });

      return blockId;
    } catch (err) {
      // 原子性兜底：如果账本记录失败，删掉刚写的 raw 和 meta
      this.blocks.deleteRaw(blockId);
      this.blocks.deleteBlockMeta(blockId);
      throw err;
    }
  }
}