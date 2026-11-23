// src/compress.mjs
import { InvariantError } from './ledger.mjs';

export class Compressor {
  constructor({ ledger, blocks }) {
    this.ledger = ledger;
    this.blocks = blocks;
    this._counter = null;
  }

  _nextBlockId() {
    if (this._counter === null) this._counter = this.blocks.getMaxBlockId();
    this._counter += 1;
    return `b${this._counter}`;
  }

  compress({ range, ids, summary, topics = [], tier = 1, sumTok = 0, seqSpan }) {
    const activeMsgs = this.ledger.getActiveMessages();

    // v0.7.7 P2-2(D)：显式参数校验——此前 ids/range 皆缺时裸 TypeError
    // （"range is not iterable"），模型完全无从下手。
    if (!Array.isArray(ids) && !Array.isArray(range)) {
      throw new InvariantError('参数完备', 'ids 与 range 至少提供一个（二选一）');
    }
    let toFold;
    let foldIds;
    if (Array.isArray(ids)) {
      // M3 精确集合折叠：不依赖 id 字典序（宿主 UUID id 的时间序与字典序无关）
      const want = new Set(ids);
      toFold = activeMsgs.filter((m) => want.has(m.id));
      if (toFold.length !== ids.length || toFold.length === 0) {
        throw new InvariantError('归属唯一', `ids 无一命中或有 ${ids.length - toFold.length} 个不在活跃消息中`);
      }
      foldIds = toFold.map((m) => m.id);
      range = [toFold[0].id, toFold[toFold.length - 1].id]; // 仅作展示用范围
    } else {
      const [startId, endId] = range;
      const startIndex = activeMsgs.findIndex((m) => m.id === startId);
      const endIndex = activeMsgs.findIndex((m) => m.id === endId);

      if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
        throw new InvariantError('归属唯一', `区间 ${range} 无效或不存在于活跃消息中`);
      }

      toFold = activeMsgs.slice(startIndex, endIndex + 1);
      foldIds = toFold.map((m) => m.id); // v0.6.34：range 也走 ids 精确折叠——此前只传 range，
    }                                  // ledger 按字典序解析，折叠集合与 raw 归档不一致（外部用户报告）

    const blockId = this._nextBlockId();
    const srcTok = toFold.reduce((s, m) => s + (m.tok || 0), 0);
    const rawRef = `block.${blockId}.raw.jsonl`;

    // 时间锚：取真实有 at 的消息的最早/最晚
    const ats = toFold.map((m) => m.at).filter((t) => typeof t === 'number' && t > 0);
    const atRange = ats.length > 0 ? [ats.reduce((a, b) => (a < b ? a : b)), ats.reduce((a, b) => (a > b ? a : b))] : null; // v0.7.7 P1-3(D)：reduce 防栈溢出

    this.blocks.writeRaw(blockId, toFold);

    try {
      this.blocks.writeBlockMeta(blockId, {
        id: blockId, tier, range, srcTok, sumTok,
        summary, topics, rawRef, createdAt: Date.now(),
        atRange,
        ...(seqSpan ? { seqSpan } : {}),
        ...(foldIds ? { ids: foldIds } : {}),
      });
      this.ledger.recordFold({
        block: blockId, range, srcTok, sumTok, tier, rawRef, atRange,
        ...(seqSpan ? { seqSpan } : {}),
        ...(foldIds ? { ids: foldIds } : {}),
      });
      return blockId;
    } catch (err) {
      this.blocks.deleteRaw(blockId);
      this.blocks.deleteBlockMeta(blockId);
      throw err;
    }
  }
}