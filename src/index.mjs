// src/index.mjs
// 万卷 M1 聚合出口。所有对外能力从这里 import。
// createWanjuan({ dir }) 把六个模块串成一个可直接用的实例。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Estimator } from './estimate.mjs';
import { Store } from './store.mjs';
import { Ledger } from './ledger.mjs';
import { Observer } from './observe.mjs';
import { Fingerprinter } from './fingerprint.mjs';
import { Diagnoser } from './diagnose.mjs';

export { Estimator } from './estimate.mjs';
export { Store, canonical, hashCanonical } from './store.mjs';
export { Ledger, InvariantError } from './ledger.mjs';
export { Observer } from './observe.mjs';
export { Fingerprinter } from './fingerprint.mjs';
export { Diagnoser, classifyMiss } from './diagnose.mjs';
export { buildReport, reportFromDisk } from './report.mjs';

export const DEFAULT_MODELS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./models.json', import.meta.url)), 'utf8')
);

export function createWanjuan({
  dir,
  models = DEFAULT_MODELS,
  snapshotBudget,
  segBytes,
  sampleEvery,
} = {}) {
  if (!dir) throw new Error('createWanjuan: dir 必填');
  const store = new Store({ dir, snapshotBudget, segBytes });
  const ledger = new Ledger({ store });
  const estimator = new Estimator({ models });
  const observer = new Observer({ estimator });
  const fingerprinter = new Fingerprinter({ ledger, sampleEvery });
  const diagnoser = new Diagnoser({ dir });
  return { dir, store, ledger, estimator, observer, fingerprinter, diagnoser };
}