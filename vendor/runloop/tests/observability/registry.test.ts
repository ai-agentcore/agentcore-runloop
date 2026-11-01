import { describe, it, expect } from "vitest";
import { MetricsRegistry } from "@/observability/registry.js";

describe("MetricsRegistry", () => {
  describe("Counter", () => {
    it("accumulates and renders labelled series", () => {
      const reg = new MetricsRegistry();
      const c = reg.counter("c_total", "help c", ["a"]);
      c.inc({ a: "x" });
      c.inc({ a: "x" }, 2);
      c.inc({ a: "y" });
      const lines = c.render().sort();
      expect(lines).toContain('c_total{a="x"} 3');
      expect(lines).toContain('c_total{a="y"} 1');
    });

    it("renders no-label series without braces", () => {
      const reg = new MetricsRegistry();
      const c = reg.counter("c_total", "h");
      c.inc();
      expect(c.render()).toEqual(["c_total 1"]);
    });

    it("skips non-finite increments", () => {
      const reg = new MetricsRegistry();
      const c = reg.counter("c_total", "h");
      c.inc({}, NaN);
      c.inc({}, Infinity);
      expect(c.render()).toEqual([]);
    });
  });

  describe("Gauge", () => {
    it("supports set / add / inc / dec", () => {
      const reg = new MetricsRegistry();
      const g = reg.gauge("g", "h");
      g.set({}, 5);
      g.inc();
      g.dec();
      g.add(3);
      expect(g.render()).toEqual(["g 8"]);
    });

    it("add creates a new series when absent", () => {
      const reg = new MetricsRegistry();
      const g = reg.gauge("g", "h", ["k"]);
      g.add(2, { k: "v" });
      expect(g.render()).toEqual(['g{k="v"} 2']);
    });

    it("skips non-finite set/add", () => {
      const reg = new MetricsRegistry();
      const g = reg.gauge("g", "h");
      g.set({}, NaN);
      g.add(Infinity);
      expect(g.render()).toEqual([]);
    });
  });

  describe("Histogram", () => {
    it("renders cumulative buckets, +Inf, sum and count", () => {
      const reg = new MetricsRegistry();
      const h = reg.histogram("h_seconds", "h", ["op"], [0.5, 1, 2]);
      h.observe({ op: "x" }, 0.3);
      h.observe({ op: "x" }, 1.5);
      const lines = h.render();
      expect(lines).toContain('h_seconds_bucket{op="x",le="0.5"} 1');
      expect(lines).toContain('h_seconds_bucket{op="x",le="1"} 1');
      expect(lines).toContain('h_seconds_bucket{op="x",le="2"} 2');
      expect(lines).toContain('h_seconds_bucket{op="x",le="+Inf"} 2');
      expect(lines).toContain('h_seconds_sum{op="x"} 1.8');
      expect(lines).toContain('h_seconds_count{op="x"} 2');
    });

    it("skips non-finite observations", () => {
      const reg = new MetricsRegistry();
      const h = reg.histogram("h", "h", [], [1]);
      h.observe({}, NaN);
      expect(h.render()).toEqual([]);
    });
  });

  describe("render()", () => {
    it("emits # HELP / # TYPE headers and skips empty metrics", () => {
      const reg = new MetricsRegistry();
      const c = reg.counter("used_total", "used help");
      reg.counter("unused_total", "unused help"); // never incremented → skipped
      c.inc();
      const out = reg.render();
      expect(out).toContain("# HELP used_total used help");
      expect(out).toContain("# TYPE used_total counter");
      expect(out).toContain("used_total 1");
      expect(out).not.toContain("unused_total");
      expect(out.endsWith("\n")).toBe(true);
    });

    it("returns empty string when nothing recorded", () => {
      expect(new MetricsRegistry().render()).toBe("");
    });

    it("escapes label values", () => {
      const reg = new MetricsRegistry();
      const c = reg.counter("c", "h", ["m"]);
      c.inc({ m: 'a"b\\c\nd' });
      expect(c.render()[0]).toBe('c{m="a\\"b\\\\c\\nd"} 1');
    });
  });
});
