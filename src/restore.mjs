// src/restore.mjs
// L3 执行：恢复（decompress）与检索（search）。
// decompress：从 raw.jsonl 读出原文，返回给宿主（宿主负责尾部追加）。
// search：块粒度检索，搜 summary 和 topics。

import { BlockError } from './blocks.mjs';

export class Restorer {
  constructor({ ledger, blocks }) {
    this.ledger = ledger;
    this.blocks = blocks;
  }

  // 恢复指定块的原文
  // mode: 'context' (返回消息数组，供宿主尾部追加) / 'file' (返回文件路径)
  decompress(blockId, mode = 'context') {
    const block = this.ledger.getBlock(blockId);
    if (!block) {
      throw new BlockError('BLOCK_NOT_FOUND', `块 ${blockId} 不存在于账本中`);
    }

    // 如果块已晋升（有 children），递归展开
    if (block.children && block.children.length > 0) {
      const allMsgs = [];
      for (const childId of block.children) {
        const childMsgs = this.decompress(childId, mode);
        if (Array.isArray(childMsgs)) {
          allMsgs.push(...childMsgs);
        }
      }
      return allMsgs;
    }

    // 叶子块：直接读 raw
    const rawMsgs = this.blocks.readRaw(blockId);

    if (mode === 'context') {
      return rawMsgs;
    } else if (mode === 'file') {
      // 模拟写入文件，直接返回 raw 的路径
      return `./blocks/${block.rawRef}`;
    } else {
      throw new Error(`未知的 decompress mode: ${mode}`);
    }
  }

  // 块粒度检索
  search(query) {
    const q = query.toLowerCase();
    const blocks = this.ledger.listBlocks();
    const matches = [];

    for (const b of blocks) {
      // 只搜当前的叶子块（已被晋升的父块不直接参与搜索，搜子块即可）
      if (b.promotedInto) continue;

      const meta = this.blocks.readBlockMeta(b.id);
      const inSummary = (meta.summary || '').toLowerCase().includes(q);
      const inTopics = (meta.topics || []).some((t) => t.toLowerCase().includes(q));

      if (inSummary || inTopics) {
        matches.push({
          id: b.id,
          tier: b.tier,
          summary: meta.summary,
          topics: meta.topics,
          srcTok: b.srcTok,
          sumTok: b.sumTok,
        });
      }
    }

    return matches;
  }
}