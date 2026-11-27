// src/index.mjs
// 万卷 M3 聚合出口。所有对外能力从这里 import。
// createWanjuan({ dir }) 把所有模块串成一个可直接用的实例。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Estimator } from './estimate.mjs';
import { Store } from './store.mjs';
import { Ledger } from './ledger.mjs';
import { Diagnoser } from './diagnose.mjs';
import { BlocksManager } from './blocks.mjs';
import { Compressor } from './compress.mjs';
import { Restorer } from './restore.mjs';
import { classifyWaterMark } from './gate.mjs';
import { NudgeManager } from './nudge.mjs';

export { Estimator } from './estimate.mjs';
export { Store } from './store.mjs'; // v0.8.5 P2-13：快照接口随死代码一并移除
export { Ledger, InvariantError } from './ledger.mjs';
export { Diagnoser, classifyMiss } from './diagnose.mjs';
export { buildReport, reportFromDisk } from './report.mjs';
export { BlocksManager, BlockError } from './blocks.mjs';
export { Compressor } from './compress.mjs';
export { Restorer } from './restore.mjs';
export { classifyWaterMark } from './gate.mjs'; // v0.9.0-m5.3：水位→动作分类（Gate 增速门语义退役）
export { NudgeManager } from './nudge.mjs';
export { estimateTok } from './tokenizer.mjs';
export { Philosophy, PHILOSOPHY_KEEP_DROP } from './philosophy.mjs';

export const DEFAULT_MODELS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./models.json', import.meta.url)), 'utf8')
);

export function createWanjuan({
  dir,
  models = DEFAULT_MODELS,
  snapshotBudget,
  segBytes,
  readOnly, // v0.8.0 根锁：只读降级实例
  nudgeOptions,
  compactionThreshold,
} = {}) {
  if (!dir) throw new Error('createWanjuan: dir 必填');
  
  const store = new Store({ dir, snapshotBudget, segBytes, readOnly });
  const ledger = new Ledger({ store, compactionThreshold });
  const estimator = new Estimator({ models });
  const diagnoser = new Diagnoser({ dir, readOnly });
  const blocks = new BlocksManager({ store });
  const compressor = new Compressor({ ledger, blocks });
  const restorer = new Restorer({ ledger, blocks });
  const nudge = new NudgeManager(nudgeOptions);
  
  return { 
    dir, store, ledger, estimator,
    diagnoser, blocks, compressor, restorer,
    nudge
  };
}