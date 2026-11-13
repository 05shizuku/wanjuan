// src/blocks.mjs
// L1 块账与原文存储。负责管理 blocks/<id>.raw.jsonl 的读写。
// 核心原则（§5）：先写 raw fsync 成功，再去写 fold 事件。如果 fold 写失败，raw 成为孤儿，由 reconcile 回收。
// 为了防写入一半导致文件损坏，写入 raw 采用「写临时文件 -> rename」的原子替换策略。

import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';

export class BlockError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

export class BlocksManager {
  constructor({ store }) {
    this.store = store; // 复用 Store 的 dir 和 writeBlock
    this.dir = store.dir;
  }

  _rawPath(blockId) {
    return join(this.dir, `block.${blockId}.raw.jsonl`);
  }

  // 原子写入原文：传入的消息数组会被逐行序列化
  writeRaw(blockId, messages) {
    const path = this._rawPath(blockId);
    const tmp = path + '.tmp';
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    
    // 写临时文件并 fsync
    const fd = openSync(tmp, 'w');
    writeFileSync(fd, lines, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    
    // 原子重命名覆盖
    renameSync(tmp, path);
  }

  // 读取原文。如果文件不存在，抛出一致的错误。
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

  // 删除原文（孤儿回收时用）
  deleteRaw(blockId) {
    const path = this._rawPath(blockId);
    if (existsSync(path)) unlinkSync(path);
  }

  // 封装 Store.writeBlock，带尺寸断言（Store 里已有逻辑，这里透传）
  writeBlockMeta(blockId, meta) {
    return this.store.writeBlock(blockId, meta);
  }

  // 读取块元数据（摘要等）
  readBlockMeta(blockId) {
    const path = join(this.dir, `block.${blockId}.json`);
    if (!existsSync(path)) {
      throw new BlockError('BLOCK_NOT_FOUND', `块 ${blockId} 不存在`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  // 删除块元数据（清理失败事务时用）
  deleteBlockMeta(blockId) {
    const path = join(this.dir, `block.${blockId}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}