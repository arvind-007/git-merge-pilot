/**
 * Test helper: builds a GitHub-style unified diff (hunks only, no file headers) between two
 * texts using an LCS line diff with `context` lines of context.
 */
export function makePatch(before: string, after: string, context = 3): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i]!, ai: i, bi: j });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ t: '+', s: b[j]!, ai: i, bi: j });
      j++;
    } else {
      ops.push({ t: '-', s: a[i]!, ai: i, bi: j });
      i++;
    }
  }
  const changed = ops.map((o, idx) => (o.t !== ' ' ? idx : -1)).filter((x) => x >= 0);
  if (changed.length === 0) return '';
  // group into hunks
  const groups: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length - 1, changed[0]! + context);
  for (const c of changed.slice(1)) {
    if (c - context <= end + 1) end = Math.min(ops.length - 1, c + context);
    else {
      groups.push([start, end]);
      start = Math.max(0, c - context);
      end = Math.min(ops.length - 1, c + context);
    }
  }
  groups.push([start, end]);
  const out: string[] = [];
  for (const [s, e] of groups) {
    const slice = ops.slice(s, e + 1);
    const oldCount = slice.filter((o) => o.t !== '+').length;
    const newCount = slice.filter((o) => o.t !== '-').length;
    const first = slice[0]!;
    const oldStart = oldCount === 0 ? first.ai : first.ai + 1;
    const newStart = newCount === 0 ? first.bi : first.bi + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
  }
  return out.join('\n');
}
