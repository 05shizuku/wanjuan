// src/compress.mjs
import { InvariantError } from './ledger.mjs';

export class Compressor {
  constructor({ ledger, blocks }) {
    this.ledger = ledger;
    this.blocks = blocks;
    this._counter = null; // 懒初始化：首次 compress 时从磁盘扫 max
  }

  _nextBlockId() {
    if (this._counter === null) {
      this._counter = this.blocks.getMaxBlockId();
    }
    this._counter += 1;
    return `b${this._counter}`;
  }

  compress({ range, summary, topics = [], tier = 1, sumTok = 0 }) {
    const [startId, endId] = range;
    const activeMsgs = this.ledger.getActiveMessages();

    const startIndex = activeMsgs.findIndex((m) => m.id === startId);
    const endIndex = activeMsgs.findIndex((m) => m.id === endId);

    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
      throw new InvariantError('归属唯一', `区间 ${range} 无效或不存在于活跃消息中`);
    }

    const toFold = activeMsgs.slice(startIndex, endIndex + 1);
    const blockId = this._nextBlockId();
    const srcTok = toFold.reduce((s, m) => s + (m.tok || 0), 0);
    const rawRef = `block.${blockId}.raw.jsonl`;

    this.blocks.writeRaw(blockId, toFold);

    try {
      this.blocks.writeBlockMeta(blockId, {
        id: blockId, tier, range, srcTok, sumTok,
        summary, topics, rawRef, createdAt: Date.now(),
      });
      this.ledger.recordFold({ block: blockId, range, srcTok, sumTok, tier, rawRef });
      return blockId;
    } catch (err) {
      this.blocks.deleteRaw(blockId);
      this.blocks.deleteBlockMeta(blockId);
      throw err;
    }
  }
}