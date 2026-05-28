import { describe, expect, it } from "vitest";

import { mergeSorted } from "./sorted-merge.js";

function collect<T>(iterable: Iterable<T>): T[] {
  return [...iterable];
}

describe("mergeSorted", () => {
  it("merges empty lists", () => {
    expect(collect(mergeSorted([], []))).toEqual([]);
    expect(collect(mergeSorted([], [1, 2, 3]))).toEqual([1, 2, 3]);
    expect(collect(mergeSorted([1, 2, 3], []))).toEqual([1, 2, 3]);
  });

  it("merges single-element lists", () => {
    expect(collect(mergeSorted([1], [2]))).toEqual([1, 2]);
    expect(collect(mergeSorted([2], [1]))).toEqual([1, 2]);
  });

  it("merges equal-length lists with linear strategy", () => {
    expect(collect(mergeSorted([1, 3, 5], [2, 4, 6]))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("merges highly asymmetric lists", () => {
    const larger = Array.from({ length: 10_000 }, (_, index) => index);
    const merged = collect(mergeSorted(larger, [5_000.5]));

    expect(merged).toHaveLength(10_001);
    expect(merged[5_000]).toBe(5_000);
    expect(merged[5_001]).toBe(5_000.5);
    expect(merged[5_002]).toBe(5_001);
  });

  it("merges duplicates without dropping values", () => {
    expect(collect(mergeSorted([1, 2, 2, 4], [2, 2, 3]))).toEqual([1, 2, 2, 2, 2, 3, 4]);
  });

  it("handles disjoint and interleaved ranges", () => {
    expect(collect(mergeSorted([1, 2, 3], [10, 11, 12]))).toEqual([1, 2, 3, 10, 11, 12]);
    expect(collect(mergeSorted([1, 4, 7], [2, 3, 8]))).toEqual([1, 2, 3, 4, 7, 8]);
  });

  it("supports custom comparators", () => {
    const descending = (left: number, right: number) => right - left;
    const merged = collect(mergeSorted([9, 7, 5], [8, 6, 4], descending));
    expect(merged).toEqual([9, 8, 7, 6, 5, 4]);
  });

  it("supports iterator and generator inputs", () => {
    function* odds(): IterableIterator<number> {
      yield 1;
      yield 3;
      yield 5;
      yield 7;
    }

    function* evens(): IterableIterator<number> {
      yield 2;
      yield 4;
      yield 6;
      yield 8;
    }

    expect(collect(mergeSorted(odds(), evens()))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("preserves stability across both lists", () => {
    const left = [
      { key: 1, id: "a1" },
      { key: 1, id: "a2" },
      { key: 2, id: "a3" },
      { key: 2, id: "a4" },
      { key: 3, id: "a5" },
    ];
    const right = [
      { key: 1, id: "b1" },
      { key: 2, id: "b2" },
      { key: 2, id: "b3" },
      { key: 3, id: "b4" },
    ];

    const merged = collect(mergeSorted(left, right, (l, r) => l.key - r.key));
    expect(merged.map((entry) => entry.id)).toEqual([
      "a1",
      "a2",
      "b1",
      "a3",
      "a4",
      "b2",
      "b3",
      "a5",
      "b4",
    ]);
  });

  it("handles larger asymmetric arrays where galloping is selected", () => {
    const small = Array.from({ length: 16 }, (_, index) => index * 7 + 3);
    const large = Array.from({ length: 1_000 }, (_, index) => index);
    const merged = collect(mergeSorted(small, large));

    expect(merged).toHaveLength(1_016);
    expect(merged[0]).toBe(0);
    expect(merged[merged.length - 1]).toBe(999);
    for (let index = 1; index < merged.length; index += 1) {
      expect(merged[index - 1]).toBeLessThanOrEqual(merged[index]);
    }
  });
});
