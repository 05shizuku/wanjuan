// src/restore.mjs
import { join } from 'node:path';
import { BlockError } from './blocks.mjs';

export class Restorer {
  constructor({ ledger, blocks }) {
    this.ledger = ledger;
    this.blocks = blocks;
  }

  decompress(blockId, mode = 'context') {
    // v0.7.7 P2-1(D)：blockId 白名单——模型可传 ../ 构造路径穿越读目录外文件；
    // 块 id 本来就是 b<数字> 生成，不匹配直接拒绝（在 API 边界拦截，工具层免重复校验）。
    if (!/^b\d+$/.test(String(blockId ?? ''))) {
      throw new BlockError('BAD_BLOCK_ID', `blockId 必须是 b<数字> 形式（如 b1），已拒绝：${String(blockId).slice(0, 40)}`);
    }
    const block = this.ledger.getBlock(blockId);
    if (!block) {
      throw new BlockError('BLOCK_NOT_FOUND', `块 ${blockId} 不存在于账本中`);
    }

    // 父块递归展开
    if (block.children && block.children.length > 0) {
      // v0.7.6 P2(C1)：子块已全部展开过时返回幂等提示，而非递归抛 BLOCK_NOT_FOUND。
      const gone = block.children.filter((c) => !this.ledger.getBlock(c));
      if (gone.length === block.children.length) {
        return `块 ${blockId} 的子块已全部展开过（无剩余可恢复内容）`;
      }
      const allMsgs = [];
      for (const childId of block.children) {
        if (!this.ledger.getBlock(childId)) continue; // 已展开的子块跳过
        allMsgs.push(...this.decompress(childId, mode));
      }
      // v0.6.25：聚合后按 seq 升序——子块各自有序不代表拼接有序
      return allMsgs.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    }

    const rawMsgs = this.blocks.readRaw(blockId);

    if (mode === 'context') {
      // 让账本跟上宿主（尾部追加后这些消息重新 active）
      this.ledger.recordUnfold({ block: blockId, why: 'context' });
      // v0.6.25：按 seq 升序返回——readRaw 按写入顺序读出，模型必须看到时间线连贯的历史
      return rawMsgs.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
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
    const metaErrors = []; // v0.8.3 R1b：meta 读失败不再静默吞块——调用方必须看到排除名单
    for (const b of blocks) {
      if (b.promotedInto) continue;
      let meta;
      try { meta = this.blocks.readBlockMeta(b.id); } catch { metaErrors.push(b.id); continue; }
      const inSummary = (meta.summary || '').toLowerCase().includes(q);
      const inTopics = (meta.topics || []).some((t) => t.toLowerCase().includes(q));
      if (inSummary || inTopics) {
        matches.push({
          id: b.id, tier: b.tier, summary: meta.summary,
          topics: meta.topics, srcTok: b.srcTok, sumTok: b.sumTok,
        });
      }
    }
    return { matches, metaErrors };
  }
}