// 轻量内存 Prometheus registry（不依赖 prom-client 的全局进程状态）。
// 支持 Counter / Gauge / Histogram，渲染为 Prometheus 文本格式（# HELP / # TYPE）。
// 设计原则：依赖极简、输出跳过 NaN/Inf、标签值做转义。

export type LabelValues = Record<string, string>;

/** Prometheus 文本格式的标签值转义：反斜杠、换行、双引号。 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** 用于在内部 Map 里区分不同标签组合的稳定 key。 */
function seriesKey(labelNames: string[], labels: LabelValues): string {
  return labelNames.map((n) => `${n}=${labels[n] ?? ""}`).join(",");
}

/** 渲染 `{a="x",b="y"}` 形式的标签段；无标签时返回空串。 */
function renderLabels(labelNames: string[], labels: LabelValues, extra?: LabelValues): string {
  const parts: string[] = [];
  for (const n of labelNames) {
    parts.push(`${n}="${escapeLabelValue(labels[n] ?? "")}"`);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}="${escapeLabelValue(v)}"`);
    }
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[],
  ) {}
  abstract readonly type: "counter" | "gauge" | "histogram";
  abstract render(): string[];
}

export class Counter extends Metric {
  readonly type = "counter" as const;
  private values = new Map<string, { labels: LabelValues; value: number }>();

  inc(labels: LabelValues = {}, value = 1): void {
    if (!isFiniteNumber(value)) return;
    const key = seriesKey(this.labelNames, labels);
    const cur = this.values.get(key);
    if (cur) cur.value += value;
    else this.values.set(key, { labels, value });
  }

  render(): string[] {
    const lines: string[] = [];
    for (const { labels, value } of this.values.values()) {
      if (!isFiniteNumber(value)) continue;
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines;
  }
}

export class Gauge extends Metric {
  readonly type = "gauge" as const;
  private values = new Map<string, { labels: LabelValues; value: number }>();

  set(labels: LabelValues = {}, value = 0): void {
    if (!isFiniteNumber(value)) return;
    this.values.set(seriesKey(this.labelNames, labels), { labels, value });
  }

  add(delta: number, labels: LabelValues = {}): void {
    if (!isFiniteNumber(delta)) return;
    const key = seriesKey(this.labelNames, labels);
    const cur = this.values.get(key);
    if (cur) cur.value += delta;
    else this.values.set(key, { labels, value: delta });
  }

  inc(labels: LabelValues = {}): void {
    this.add(1, labels);
  }

  dec(labels: LabelValues = {}): void {
    this.add(-1, labels);
  }

  render(): string[] {
    const lines: string[] = [];
    for (const { labels, value } of this.values.values()) {
      if (!isFiniteNumber(value)) continue;
      lines.push(`${this.name}${renderLabels(this.labelNames, labels)} ${value}`);
    }
    return lines;
  }
}

interface HistogramSeries {
  labels: LabelValues;
  counts: number[]; // 累积桶计数，与 buckets 一一对应
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  readonly type = "histogram" as const;
  private series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, labelNames: string[], readonly buckets: number[]) {
    super(name, help, labelNames);
  }

  observe(labels: LabelValues, value: number): void {
    if (!isFiniteNumber(value)) return;
    const key = seriesKey(this.labelNames, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i]++;
    }
    s.sum += value;
    s.count++;
  }

  render(): string[] {
    const lines: string[] = [];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels(this.labelNames, s.labels, { le: String(this.buckets[i]) })} ${s.counts[i]}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, s.labels, { le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, s.labels)} ${s.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private metrics: Metric[] = [];

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const c = new Counter(name, help, labelNames);
    this.metrics.push(c);
    return c;
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const g = new Gauge(name, help, labelNames);
    this.metrics.push(g);
    return g;
  }

  histogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram {
    const h = new Histogram(name, help, labelNames, buckets);
    this.metrics.push(h);
    return h;
  }

  /** 渲染所有指标为 Prometheus 文本格式。 */
  render(): string {
    const blocks: string[] = [];
    for (const metric of this.metrics) {
      const lines = metric.render();
      if (lines.length === 0) continue;
      blocks.push(`# HELP ${metric.name} ${metric.help}`);
      blocks.push(`# TYPE ${metric.name} ${metric.type}`);
      blocks.push(...lines);
    }
    return blocks.length ? blocks.join("\n") + "\n" : "";
  }
}
