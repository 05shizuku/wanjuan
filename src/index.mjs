// src/index.mjs
// 万卷 M3 聚合出口。所有对外能力从这里 import。
// createWanjuan({ dir }) 把所有模块串成一个可直接用的实例。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Estimator } from './estimate.mjs';
import { Store } from './store.mjs';
import { Ledger } from './ledger.mjs';
import { Observer } from './observe.mjs';
import { Fingerprinter } from './fingerprint.mjs';
import { Diagnoser } from './diagnose.mjs';
import { BlocksManager } from './blocks.mjs';
import { Compressor } from './compress.mjs';
import { Restorer } from './restore.mjs';
import { Gate } from './gate.mjs';
import { NudgeManager } from './nudge.mjs';

export { Estimator } from './estimate.mjs';
export { Store, canonical, hashCanonical } from './store.mjs';
export { Ledger, InvariantError } from './ledger.mjs';
export { Observer } from './observe.mjs';
export { Fingerprinter } from './fingerprint.mjs';
export { Diagnoser, classifyMiss } from './diagnose.mjs';
export { buildReport, reportFromDisk } from './report.mjs';
export { BlocksManager, BlockError } from './blocks.mjs';
export { Compressor } from './compress.mjs';
export { Restorer } from './restore.mjs';
export { Gate } from './gate.mjs';
export { NudgeManager } from './nudge.mjs';
export { Philosophy, PHILOSOPHY_KEEP_DROP } from './philosophy.mjs';

export const DEFAULT_MODELS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./models.json', import.meta.url)), 'utf8')
);

export function createWanjuan({
  dir,
  models = DEFAULT_MODELS,
  snapshotBudget,
  segBytes,
  sampleEvery,
  gateOptions,
  nudgeOptions,
} = {}) {
  if (!dir) throw new Error('createWanjuan: dir 必填');
  
  const store = new Store({ dir, snapshotBudget, segBytes });
  const ledger = new Ledger({ store });
  const estimator = new Estimator({ models });
  const observer = new Observer({ estimator });
  const fingerprinter = new Fingerprinter({ ledger, sampleEvery });
  const diagnoser = new Diagnoser({ dir });
  const blocks = new BlocksManager({ store });
  const compressor = new Compressor({ ledger, blocks });
  const restorer = new Restorer({ ledger, blocks });
  const gate = new Gate(gateOptions);
  const nudge = new NudgeManager(nudgeOptions);
  
  return { 
    dir, store, ledger, estimator, observer, 
    fingerprinter, diagnoser, blocks, compressor, restorer,
    gate, nudge
  };
}