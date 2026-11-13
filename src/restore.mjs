// src/restore.mjs
import { join } from 'node:path';
import { BlockError } from './blocks.mjs';

export class Restorer {
  constructor({ ledger, blocks }) {
    this.ledger = ledger;
    this.blocks = blocks;
  }

  decompress(blockId, mode = 'context') {
    const block = this.ledger.getBlock(blockId);
    if (!block) {
      throw new BlockError('BLOCK_NOT_FOUND', `块 ${blockId} 不存在于账本中`);
    }

    // 父块递归展开
    if (block.children && block.children.length > 0) {
      const allMsgs = [];
      for (const childId of block.children) {
        allMsgs.push(...this.decompress(childId, mode));
      }
      return allMsgs;
    }

    const rawMsgs = this.blocks.readRaw(blockId);

    if (mode === 'context') {
      // 让账本跟上宿主（尾部追加后这些消息重新 active）
      this.ledger.recordUnfold({ block: blockId, why: 'context' });
      return rawMsgs;
    } else if (mode === 'file') {
      // 修：rawRef 是文件名（block.b1.raw.jsonl），正确路径在 blocks.dir 下
      return join(this.blocks.dir, block.rawRef || `block.${blockId}.raw.jsonl`);
    } else {
      throw new Error(`未知的 decompress mode: ${mode}`);
    }
  }

  search(query) {
    const q = query.toLowerCase();
    const blocks = this.ledger.listBlocks();
    const matches = [];
    for (const b of blocks) {
      if (b.promotedInto) continue;
      let meta;
      try { meta = this.blocks.readBlockMeta(b.id); } catch { continue; }
      const inSummary = (meta.summary || '').toLowerCase().includes(q);
      const inTopics = (meta.topics || []).some((t) => t.toLowerCase().includes(q));
      if (inSummary || inTopics) {
        matches.push({
          id: b.id, tier: b.tier, summary: meta.summary,
          topics: meta.topics, srcTok: b.srcTok, sumTok: b.sumTok,
        });
      }
    }
    return matches;
  }
}