// src/observe.mjs
// L0 观测层。把 estimate 和真实 usage 串起来：
//   beforeRequest → 算估算
//   afterRequest  → 拿 usage 更新 k̂，生成 requests.jsonl 的一行记录
// 失败 loud：无 usage 时 calibOk=false，不更新 k̂，不静默。

export class Observer {
  constructor({ estimator }) {
    this.estimator = estimator;
    this.requests = [];
    this.n = 0;
  }

  beforeRequest({ provider, model, messages }) {
    return this.estimator.estimate({ messages }, { provider, model });
  }

  afterRequest({ provider, model, est, usage }) {
    this.n += 1;
    let calibOk = false;
    if (usage && typeof usage.input_tokens === 'number' && usage.input_tokens > 0) {
      calibOk = this.estimator.observeUsage({
        provider, model,
        usageInputTokens: usage.input_tokens,
        estRaw: est.estRaw,
      });
    }
    const rec = {
      n: this.n,
      provider,
      model,
      input: usage?.input_tokens ?? 0,
      estBy: est.estFinal,
      khat: est.khat,
      calibrating: est.calibrating,
      calibOk,
      degraded: this.estimator.getDegraded(),
    };
    this.requests.push(rec);
    return rec;
  }

  getRequests() { return [...this.requests]; }
  size() { return this.requests.length; }
}