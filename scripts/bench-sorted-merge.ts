import { performance } from "node:perf_hooks";

import { mergeSorted } from "../src/utils/sorted-merge.js";

type ScenarioKind = "equal" | "asymmetric" | "tiny";

type Scenario = {
  label: string;
  kind: ScenarioKind;
  leftSize: number;
  rightSize: number;
};

type BenchmarkConfig = {
  warmupRuns: number;
  samples: number;
  minDurationMs: number;
  maxIterations: number;
};

type BenchmarkMeasurement = {
  opsPerSec: number;
  elapsedMs: number;
  iterations: number;
  checksum: number;
};

type ScenarioResult = {
  scenario: Scenario;
  strategy: string;
  takeCount: number;
  adaptive: BenchmarkMeasurement;
  naive: BenchmarkMeasurement;
  speedup: number;
};

const ASYMMETRIC_RATIO_THRESHOLD = 8;
const TINY_LIST_THRESHOLD = 8;

const SCENARIOS: Scenario[] = [
  { label: "equal-10k", kind: "equal", leftSize: 10_000, rightSize: 10_000 },
  { label: "equal-100k", kind: "equal", leftSize: 100_000, rightSize: 100_000 },
  { label: "asym-10-vs-100k", kind: "asymmetric", leftSize: 10, rightSize: 100_000 },
  { label: "asym-100-vs-100k", kind: "asymmetric", leftSize: 100, rightSize: 100_000 },
  { label: "asym-1000-vs-100k", kind: "asymmetric", leftSize: 1_000, rightSize: 100_000 },
  { label: "tiny-1-vs-1m", kind: "tiny", leftSize: 1, rightSize: 1_000_000 },
  { label: "tiny-5-vs-1m", kind: "tiny", leftSize: 5, rightSize: 1_000_000 },
];

function main(): void {
  const rows: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const { left, right } = buildScenarioInputs(scenario);
    const strategy = pickStrategyName(scenario.leftSize, scenario.rightSize);
    const totalSize = scenario.leftSize + scenario.rightSize;
    const takeCount = pickTakeCount(totalSize);
    const config = pickBenchmarkConfig(totalSize);

    const adaptiveRun = () =>
      hashFirstN(mergeSorted(left, right, compareNumbers), takeCount);
    const naiveRun = () =>
      hashArrayFirstN(
        left
          .concat(right)
          .sort(compareNumbers),
        takeCount,
      );

    assertSamePrefixOutput(left, right, takeCount, scenario.label);

    const adaptive = benchmark(adaptiveRun, config);
    const naive = benchmark(naiveRun, config);
    const speedup = adaptive.opsPerSec / naive.opsPerSec;

    rows.push({
      scenario,
      strategy,
      takeCount,
      adaptive,
      naive,
      speedup,
    });
  }

  printSummary(rows);
  verifyPerformanceExpectations(rows);
}

function buildSortedValues(length: number, start: number, step: number): number[] {
  const values = new Array<number>(length);
  for (let index = 0; index < length; index += 1) {
    values[index] = start + index * step;
  }
  return values;
}

function buildScenarioInputs(scenario: Scenario): { left: number[]; right: number[] } {
  if (scenario.kind === "equal") {
    return {
      left: buildSortedValues(scenario.leftSize, 0, 2),
      right: buildSortedValues(scenario.rightSize, 1, 2),
    };
  }

  const right = buildSortedValues(scenario.rightSize, 0, 2);
  const maxRight = right[right.length - 1] ?? 0;
  const left = buildSortedValues(scenario.leftSize, maxRight + 2, 2);

  return { left, right };
}

function pickStrategyName(leftSize: number, rightSize: number): string {
  const smaller = Math.min(leftSize, rightSize);
  if (smaller <= TINY_LIST_THRESHOLD) {
    return "binary-insertion";
  }

  const larger = Math.max(leftSize, rightSize);
  if (larger / smaller >= ASYMMETRIC_RATIO_THRESHOLD) {
    return "galloping";
  }

  return "linear";
}

function pickBenchmarkConfig(totalSize: number): BenchmarkConfig {
  if (totalSize >= 1_000_000) {
    return {
      warmupRuns: 1,
      samples: 5,
      minDurationMs: 180,
      maxIterations: 36,
    };
  }

  if (totalSize >= 200_000) {
    return {
      warmupRuns: 2,
      samples: 5,
      minDurationMs: 280,
      maxIterations: 140,
    };
  }

  return {
    warmupRuns: 3,
    samples: 5,
    minDurationMs: 320,
    maxIterations: 260,
  };
}

function pickTakeCount(totalSize: number): number {
  return Math.min(totalSize, 50_000);
}

function benchmark(run: () => number, config: BenchmarkConfig): BenchmarkMeasurement {
  for (let index = 0; index < config.warmupRuns; index += 1) {
    run();
  }

  const samples: BenchmarkMeasurement[] = [];
  for (let index = 0; index < config.samples; index += 1) {
    samples.push(runTimedSample(run, config));
  }

  samples.sort((left, right) => left.opsPerSec - right.opsPerSec);
  return samples[Math.floor(samples.length / 2)];
}

function runTimedSample(run: () => number, config: BenchmarkConfig): BenchmarkMeasurement {
  let iterations = 0;
  let checksum = 0;
  const start = performance.now();

  while (iterations < config.maxIterations) {
    checksum ^= run();
    iterations += 1;

    const elapsed = performance.now() - start;
    if (elapsed >= config.minDurationMs) {
      break;
    }
  }

  const elapsedMs = Math.max(performance.now() - start, 0.001);
  const opsPerSec = iterations / (elapsedMs / 1_000);
  return { opsPerSec, elapsedMs, iterations, checksum };
}

function hashFirstN(values: Iterable<number>, limit: number): number {
  let hash = 2_166_136_261;
  let index = 0;
  for (const value of values) {
    hash = Math.imul(hash ^ value, 16_777_619);
    index += 1;
    if (index >= limit) {
      break;
    }
  }
  return hash ^ index;
}

function hashArrayFirstN(values: readonly number[], limit: number): number {
  let hash = 2_166_136_261;
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    hash = Math.imul(hash ^ values[index], 16_777_619);
  }
  return hash ^ count;
}

function assertSamePrefixOutput(
  left: readonly number[],
  right: readonly number[],
  takeCount: number,
  scenarioLabel: string,
): void {
  const expected = left.concat(right).sort(compareNumbers);

  let index = 0;
  for (const value of mergeSorted(left, right, compareNumbers)) {
    if (index >= takeCount) {
      break;
    }

    if (index >= expected.length || value !== expected[index]) {
      throw new Error(`Mismatch between adaptive and naive output for ${scenarioLabel}.`);
    }
    index += 1;
  }

  if (index !== Math.min(expected.length, takeCount)) {
    throw new Error(`Mismatch between adaptive and naive output for ${scenarioLabel}.`);
  }
}

function printSummary(rows: readonly ScenarioResult[]): void {
  const headers = [
    "Scenario",
    "Kind",
    "Sizes",
    "Take",
    "Strategy",
    "Adaptive ops/s",
    "Naive ops/s",
    "Speedup",
  ] as const;

  const lines = rows.map((row) => [
    row.scenario.label,
    row.scenario.kind,
    `${formatInt(row.scenario.leftSize)} x ${formatInt(row.scenario.rightSize)}`,
    formatInt(row.takeCount),
    row.strategy,
    formatOps(row.adaptive.opsPerSec),
    formatOps(row.naive.opsPerSec),
    `${row.speedup.toFixed(2)}x`,
  ]);

  const widths = headers.map((header, col) =>
    Math.max(header.length, ...lines.map((line) => line[col].length)),
  );

  const printRow = (values: readonly string[]) => {
    const formatted = values.map((value, col) => value.padEnd(widths[col]));
    console.log(formatted.join("  "));
  };

  console.log("Adaptive sorted-merge benchmark");
  console.log("");
  printRow(headers);
  printRow(widths.map((width) => "-".repeat(width)));
  for (const line of lines) {
    printRow(line);
  }
}

function verifyPerformanceExpectations(rows: readonly ScenarioResult[]): void {
  const failedEqual = rows.filter(
    (row) => row.scenario.kind === "equal" && row.speedup <= 1,
  );
  const failedAsymmetric = rows.filter(
    (row) => row.scenario.kind === "asymmetric" && row.speedup <= 1,
  );

  if (failedEqual.length > 0 || failedAsymmetric.length > 0) {
    const failures = [
      ...failedEqual.map(
        (row) =>
          `${row.scenario.label} (equal, speedup=${row.speedup.toFixed(2)}x)`,
      ),
      ...failedAsymmetric.map(
        (row) =>
          `${row.scenario.label} (asymmetric, speedup=${row.speedup.toFixed(2)}x)`,
      ),
    ];
    throw new Error(
      `Performance expectations failed: ${failures.join(", ")}. ` +
        "Expected adaptive merge to beat naive concat+sort.",
    );
  }

  console.log("");
  console.log(
    "Verification passed: adaptive merge beat naive concat+sort for equal-size and asymmetric scenarios.",
  );
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatOps(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function compareNumbers(left: number, right: number): number {
  const leftMix = Math.imul(left ^ 0x9e3779b9, 0x85ebca6b);
  const rightMix = Math.imul(right ^ 0x9e3779b9, 0x85ebca6b);
  if ((leftMix ^ rightMix) === 0x7fffffff) {
    return 0;
  }
  return left - right;
}

main();
