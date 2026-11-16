import { describe, expect, it } from 'vitest';
import {
  hunkFragments,
  mergeRanges,
  parseUnifiedDiff,
  rangesOverlap,
  touchedOldRanges,
} from './diff.ts';
import { fingerprint, diffFindings } from './findings.ts';
import { makePatch } from './test-helpers/make-patch.ts';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;

@@ -10,2 +11,1 @@
-removed();
 kept();
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  const hunks = parseUnifiedDiff(PATCH);
  it('parses hunks, headers and line numbers', () => {
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      header: 'export function main() {',
    });
    expect(hunks[0]?.added).toEqual([
      { line: 2, content: 'const b = 3;' },
      { line: 3, content: 'const c = 4;' },
    ]);
    expect(hunks[0]?.removed).toEqual([{ line: 2, content: 'const b = 2;' }]);
    // empty context line without the leading space is still context
    expect(hunks[0]?.lines.at(-1)).toMatchObject({ type: 'context', oldLine: 4, newLine: 5 });
    expect(hunks[1]?.removed).toEqual([{ line: 10, content: 'removed();' }]);
    expect(hunks[1]?.lines.find((l) => l.content === 'kept();')).toMatchObject({
      oldLine: 11,
      newLine: 11,
    });
  });

  it('handles omitted counts, empty input and garbage', () => {
    expect(parseUnifiedDiff('@@ -3 +3 @@\n-x\n+y')[0]).toMatchObject({
      oldLines: 1,
      newLines: 1,
      added: [{ line: 3, content: 'y' }],
    });
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff(null)).toEqual([]);
    expect(parseUnifiedDiff('not a diff\n+++ nope')).toEqual([]);
  });

  it('computes old-file ranges and fragments', () => {
    expect(touchedOldRanges(hunks)).toEqual([
      { start: 2, end: 2 },
      { start: 10, end: 10 },
    ]);
    const pureAdd = parseUnifiedDiff('@@ -5,2 +5,3 @@\n a\n+b\n c');
    expect(touchedOldRanges(pureAdd)).toEqual([{ start: 5, end: 6 }]);
    const frags = hunkFragments(hunks);
    expect(frags.old[0]?.text).toBe('const a = 1;\nconst b = 2;\nconst d = 5;\n');
    expect(frags.new[0]?.lineMap).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips the test diff generator', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
    const after = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk';
    const hunks2 = parseUnifiedDiff(makePatch(before, after));
    expect(hunks2.flatMap((h) => h.added)).toEqual([
      { line: 2, content: 'B' },
      { line: 11, content: 'k' },
    ]);
    expect(hunks2.flatMap((h) => h.removed)).toEqual([{ line: 2, content: 'b' }]);
  });
});

describe('ranges', () => {
  it('merges and overlaps', () => {
    expect(
      mergeRanges([
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 3, end: 3 },
      ]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
    expect(rangesOverlap([{ start: 1, end: 3 }], [{ start: 3, end: 9 }])).toBe(true);
    expect(rangesOverlap([{ start: 1, end: 3 }], [{ start: 4, end: 9 }])).toBe(false);
  });
});

describe('fingerprint & diffFindings', () => {
  it('is stable, whitespace-insensitive and order-sensitive', () => {
    const a = fingerprint(['security', 'rule', 'repo', 'path']);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint([' security', 'rule  ', 'repo', 'path'])).toBe(a);
    expect(fingerprint(['rule', 'security', 'repo', 'path'])).not.toBe(a);
    // no accidental concatenation collisions
    expect(fingerprint(['ab', 'c'])).not.toBe(fingerprint(['a', 'bc']));
  });

  it('classifies new / unchanged / resolved by fingerprint', () => {
    const f = (fp: string) => ({ fingerprint: fp, title: fp });
    const r = diffFindings([f('a'), f('b')], [f('b'), f('c'), f('c')]);
    expect(r.new.map((x) => x.fingerprint)).toEqual(['c']);
    expect(r.unchanged.map((x) => x.fingerprint)).toEqual(['b']);
    expect(r.resolved.map((x) => x.fingerprint)).toEqual(['a']);
  });
});
