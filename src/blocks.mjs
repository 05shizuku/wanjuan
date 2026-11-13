// src/blocks.mjs
import { join } from 'node:path';
import {
  openSync, writeFileSync, fsyncSync, closeSync,
  readFileSync, existsSync, renameSync, unlinkSync, readdirSync,
} from 'node:fs';

export class BlockError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

export class BlocksManager {
  constructor({ store }) {
    this.store = store;
    this.dir = store.dir;
  }

  _rawPath(blockId) { return join(this.dir, `block.${blockId}.raw.jsonl`); }

  // P1 修复：writeFileSync + fsync + close + rename，保证 rename 时内容已落盘
  writeRaw(blockId, messages) {
    const path = this._rawPath(blockId);
    const tmp = path + '.tmp';
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';

    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, lines, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  readRaw(blockId) {
    const path = this._rawPath(blockId);
    if (!existsSync(path)) {
      throw new BlockError('RAW_MISSING', `块 ${blockId} 的原文缺失（rawRef=${path}），请运行 reconcile`);
    }
    const text = readFileSync(path, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
    return out;
  }

  deleteRaw(blockId) {
    const path = this._rawPath(blockId);
    if (existsSync(path)) unlinkSync(path);
  }

  writeBlockMeta(blockId, meta) { return this.store.writeBlock(blockId, meta); }

  readBlockMeta(blockId) {
    const path = join(this.dir, `block.${blockId}.json`);
    if (!existsSync(path)) {
      throw new BlockError('BLOCK_NOT_FOUND', `块 ${blockId} 不存在`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  deleteBlockMeta(blockId) {
    const path = join(this.dir, `block.${blockId}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  getMaxBlockId() {
    if (!existsSync(this.dir)) return 0;
    const files = readdirSync(this.dir).filter((f) => /^block\.b\d+\./.test(f));
    let max = 0;
    for (const f of files) {
      const m = f.match(/^block\.b(\d+)\./);
      if (m) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
    }
    return max;
  }
}