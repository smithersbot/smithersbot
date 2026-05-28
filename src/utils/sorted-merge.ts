export type Comparator<T> = (left: T, right: T) => number;
export type MergeInput<T> = Iterable<T> | Iterator<T>;

const ASYMMETRIC_RATIO_THRESHOLD = 8;
const TINY_LIST_THRESHOLD = 8;

export function defaultNumericComparator(left: number, right: number): number {
  return left - right;
}

export function mergeSorted<T>(
  a: MergeInput<T>,
  b: MergeInput<T>,
  compare: Comparator<T> = defaultNumericComparator as Comparator<T>,
): IterableIterator<T> {
  if (Array.isArray(a) && Array.isArray(b)) {
    return mergeSortedArrays(a, b, compare);
  }

  return mergeLinearIterators(toIterator(a), toIterator(b), compare);
}

function mergeSortedArrays<T>(
  a: readonly T[],
  b: readonly T[],
  compare: Comparator<T>,
): IterableIterator<T> {
  const smallerLength = Math.min(a.length, b.length);
  if (smallerLength === 0) {
    return mergeLinearArrays(a, b, compare);
  }

  if (smallerLength <= TINY_LIST_THRESHOLD) {
    return mergeBinaryInsertionArrays(a, b, compare);
  }

  const largerLength = Math.max(a.length, b.length);
  if (largerLength / smallerLength >= ASYMMETRIC_RATIO_THRESHOLD) {
    return mergeGallopingArrays(a, b, compare);
  }

  return mergeLinearArrays(a, b, compare);
}

function* mergeLinearArrays<T>(
  a: readonly T[],
  b: readonly T[],
  compare: Comparator<T>,
): IterableIterator<T> {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < a.length && rightIndex < b.length) {
    if (compare(a[leftIndex], b[rightIndex]) <= 0) {
      yield a[leftIndex];
      leftIndex += 1;
      continue;
    }

    yield b[rightIndex];
    rightIndex += 1;
  }

  while (leftIndex < a.length) {
    yield a[leftIndex];
    leftIndex += 1;
  }

  while (rightIndex < b.length) {
    yield b[rightIndex];
    rightIndex += 1;
  }
}

function* mergeLinearIterators<T>(
  aIterator: Iterator<T>,
  bIterator: Iterator<T>,
  compare: Comparator<T>,
): IterableIterator<T> {
  let leftState = aIterator.next();
  let rightState = bIterator.next();

  while (!leftState.done && !rightState.done) {
    if (compare(leftState.value, rightState.value) <= 0) {
      yield leftState.value;
      leftState = aIterator.next();
      continue;
    }

    yield rightState.value;
    rightState = bIterator.next();
  }

  while (!leftState.done) {
    yield leftState.value;
    leftState = aIterator.next();
  }

  while (!rightState.done) {
    yield rightState.value;
    rightState = bIterator.next();
  }
}

function* mergeBinaryInsertionArrays<T>(
  a: readonly T[],
  b: readonly T[],
  compare: Comparator<T>,
): IterableIterator<T> {
  const leftIsSmall = a.length <= b.length;
  const small = leftIsSmall ? a : b;
  const large = leftIsSmall ? b : a;
  const includeEqualFromLarge = !leftIsSmall;

  const insertionPoints: number[] = [];
  let searchStart = 0;

  for (const value of small) {
    searchStart = binaryInsertionPoint(large, searchStart, value, compare, includeEqualFromLarge);
    insertionPoints.push(searchStart);
  }

  let largeIndex = 0;
  for (let smallIndex = 0; smallIndex < small.length; smallIndex += 1) {
    const insertionPoint = insertionPoints[smallIndex];
    while (largeIndex < insertionPoint) {
      yield large[largeIndex];
      largeIndex += 1;
    }

    yield small[smallIndex];
  }

  while (largeIndex < large.length) {
    yield large[largeIndex];
    largeIndex += 1;
  }
}

function* mergeGallopingArrays<T>(
  a: readonly T[],
  b: readonly T[],
  compare: Comparator<T>,
): IterableIterator<T> {
  const leftIsSmall = a.length <= b.length;
  const small = leftIsSmall ? a : b;
  const large = leftIsSmall ? b : a;
  const includeEqualFromLarge = !leftIsSmall;

  let largeIndex = 0;

  for (const value of small) {
    // Exponential + binary probe to skip long runs in the larger list.
    const insertionPoint = gallopingInsertionPoint(
      large,
      largeIndex,
      value,
      compare,
      includeEqualFromLarge,
    );

    while (largeIndex < insertionPoint) {
      yield large[largeIndex];
      largeIndex += 1;
    }

    yield value;
  }

  while (largeIndex < large.length) {
    yield large[largeIndex];
    largeIndex += 1;
  }
}

function binaryInsertionPoint<T>(
  values: readonly T[],
  start: number,
  target: T,
  compare: Comparator<T>,
  includeEqual: boolean,
): number {
  let left = start;
  let right = values.length;

  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (shouldAdvance(values[middle], target, compare, includeEqual)) {
      left = middle + 1;
      continue;
    }

    right = middle;
  }

  return left;
}

function gallopingInsertionPoint<T>(
  values: readonly T[],
  start: number,
  target: T,
  compare: Comparator<T>,
  includeEqual: boolean,
): number {
  if (start >= values.length) {
    return start;
  }

  if (!shouldAdvance(values[start], target, compare, includeEqual)) {
    return start;
  }

  let offset = 1;
  let probe = start + offset;
  while (probe < values.length && shouldAdvance(values[probe], target, compare, includeEqual)) {
    offset *= 2;
    probe = start + offset;
  }

  let left = start + Math.floor(offset / 2) + 1;
  let right = Math.min(probe, values.length);

  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (shouldAdvance(values[middle], target, compare, includeEqual)) {
      left = middle + 1;
      continue;
    }

    right = middle;
  }

  return left;
}

function shouldAdvance<T>(
  value: T,
  target: T,
  compare: Comparator<T>,
  includeEqual: boolean,
): boolean {
  const relation = compare(value, target);
  if (relation < 0) {
    return true;
  }

  return includeEqual && relation === 0;
}

function toIterator<T>(input: MergeInput<T>): Iterator<T> {
  if (typeof (input as Iterable<T>)[Symbol.iterator] === "function") {
    return (input as Iterable<T>)[Symbol.iterator]();
  }

  return input as Iterator<T>;
}
