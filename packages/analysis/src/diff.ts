import type { DiffHunk, DiffLine, LineRange, NumberedLine } from './types.ts';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses a unified diff for a single file (e.g. a GitHub `patch`) into hunks with
 * old/new line numbers. File headers (`diff --git`, `---`, `+++`, `index`) before the first
 * hunk are ignored, as are `\ No newline at end of file` markers. Malformed input never
 * throws; lines outside a hunk are skipped.
 */
export function parseUnifiedDiff(patch: string | null | undefined): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const rawLines = patch.split('\n');
  // A trailing newline produces an empty last element which is not a diff line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      const oldStart = Number(header[1]);
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: (header[5] ?? '').trim(),
        lines: [],
        added: [],
        removed: [],
      };
      hunks.push(current);
      oldLine = oldStart;
      newLine = newStart;
      oldRemaining = oldLines;
      newRemaining = newLines;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    // Once both sides are consumed, anything else belongs to a following file header.
    if (oldRemaining <= 0 && newRemaining <= 0) {
      current = null;
      continue;
    }
    const marker = line[0];
    const content = line.slice(1);
    let entry: DiffLine;
    if (marker === '+') {
      entry = { type: 'add', content, newLine };
      current.added.push({ line: newLine, content });
      newLine++;
      newRemaining--;
    } else if (marker === '-') {
      entry = { type: 'del', content, oldLine };
      current.removed.push({ line: oldLine, content });
      oldLine++;
      oldRemaining--;
    } else {
      // ' ' context, or an empty line that lost its leading space.
      entry = { type: 'context', content: marker === ' ' ? content : line, oldLine, newLine };
      oldLine++;
      newLine++;
      oldRemaining--;
      newRemaining--;
    }
    current.lines.push(entry);
  }
  return hunks;
}

/** All added lines (new-file numbering) across hunks. */
export function addedLines(hunks: readonly DiffHunk[]): NumberedLine[] {
  return hunks.flatMap((h) => h.added);
}

/** All removed lines (old-file numbering) across hunks. */
export function removedLines(hunks: readonly DiffHunk[]): NumberedLine[] {
  return hunks.flatMap((h) => h.removed);
}

/**
 * Old-file (base) line ranges touched by each hunk: the span of removed lines, or the
 * insertion point for pure additions. Used to detect overlapping edits between PRs.
 */
export function touchedOldRanges(hunks: readonly DiffHunk[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const h of hunks) {
    let start = Infinity;
    let end = -Infinity;
    let prevOld = h.oldStart - 1;
    let afterDel = false;
    for (const l of h.lines) {
      if (l.type === 'del' && l.oldLine !== undefined) {
        start = Math.min(start, l.oldLine);
        end = Math.max(end, l.oldLine);
        prevOld = l.oldLine;
        afterDel = true;
      } else if (l.type === 'context' && l.oldLine !== undefined) {
        prevOld = l.oldLine;
        afterDel = false;
      } else if (l.type === 'add' && !afterDel) {
        // Pure insertion between prevOld and prevOld + 1 (replacements stay on the deleted span).
        start = Math.min(start, Math.max(prevOld, 1));
        end = Math.max(end, prevOld + 1);
      }
    }
    if (start !== Infinity) ranges.push({ start, end: Math.max(start, end) });
  }
  return mergeRanges(ranges);
}

/** Merges overlapping/adjacent ranges; result is sorted. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** True when any range of `a` intersects any range of `b`. */
export function rangesOverlap(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  for (const x of a) for (const y of b) if (x.start <= y.end && y.start <= x.end) return true;
  return false;
}

/** A text fragment reconstructed from hunks, with a map from fragment line to file line. */
export interface HunkFragment {
  text: string;
  /** lineMap[i] = file line number of fragment line i+1. */
  lineMap: number[];
}

/**
 * Reconstructs the visible old/new text of each hunk (context + removed / context + added).
 * Used to run extractors on diffs when full file content is unavailable.
 */
export function hunkFragments(hunks: readonly DiffHunk[]): {
  old: HunkFragment[];
  new: HunkFragment[];
} {
  const olds: HunkFragment[] = [];
  const news: HunkFragment[] = [];
  for (const h of hunks) {
    const o: HunkFragment = { text: '', lineMap: [] };
    const n: HunkFragment = { text: '', lineMap: [] };
    const oLines: string[] = [];
    const nLines: string[] = [];
    for (const l of h.lines) {
      if (l.type !== 'add' && l.oldLine !== undefined) {
        oLines.push(l.content);
        o.lineMap.push(l.oldLine);
      }
      if (l.type !== 'del' && l.newLine !== undefined) {
        nLines.push(l.content);
        n.lineMap.push(l.newLine);
      }
    }
    o.text = oLines.join('\n');
    n.text = nLines.join('\n');
    olds.push(o);
    news.push(n);
  }
  return { old: olds, new: news };
}
