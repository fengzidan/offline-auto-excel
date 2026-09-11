import type { SourceMatcher, SourceTable } from "./types";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Default fuzzy keyword from a file/folder name:
 * split by _ - . spaces, strip digits from each part, pick the longest Chinese segment.
 * e.g. 人员清单_202603 → 人员清单；南通中支-赔付支出明细_08 → 赔付支出明细
 */
export function defaultSourceKeyword(fileName: string): string {
  const base = fileName
    .replace(/^.*[/\\]/, "")
    .replace(/\.[^.]+$/, "")
    .trim();
  if (!base) return "";

  const parts = base
    .split(/[_\-.．。－—\s／/]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const cleaned = parts
    .map((p) => p.replace(/[0-9０-９]+/g, "").trim())
    .filter(Boolean);

  const chineseParts = cleaned.filter((p) => /[\u4e00-\u9fff]/.test(p));
  const pool = chineseParts.length > 0 ? chineseParts : cleaned;

  if (pool.length === 0) {
    const flat = base.replace(/[_\-.．。－—\s／/0-9０-９]+/g, "");
    return flat || base;
  }

  return pool.reduce((best, cur) =>
    cur.length > best.length ? cur : best,
  );
}

/** Score how well a scanned table matches a keyword (higher is better). */
export function scoreSourceKeyword(table: SourceTable, keyword: string): number {
  const kw = norm(keyword);
  if (!kw) return 0;
  const name = norm(table.name);
  const path = norm(table.path);
  if (name === kw) return 1000;
  if (name.includes(kw)) return 500 + Math.min(kw.length, 100);
  if (path.includes(kw)) return 200 + Math.min(kw.length, 100);
  return 0;
}

/**
 * Apply user-defined keywords: bind stable matcher.id to the best scanned table
 * whose name/path contains the keyword. Unmatched matchers become placeholder
 * sources; remaining scanned tables stay available.
 */
export function applySourceMatchers(
  scanned: SourceTable[],
  matchers: SourceMatcher[] | undefined,
): SourceTable[] {
  const list = (matchers ?? []).filter((m) => m.keyword?.trim() && m.id?.trim());
  if (list.length === 0) return scanned;

  // Longer keywords first, so "赔付支出明细" beats "赔付"
  const ordered = [...list].sort(
    (a, b) => b.keyword.trim().length - a.keyword.trim().length,
  );
  const claimed = new Set<string>();
  const bound: SourceTable[] = [];

  for (const m of ordered) {
    const kw = m.keyword.trim();
    let best: SourceTable | null = null;
    let bestScore = 0;
    for (const t of scanned) {
      if (claimed.has(t.id) || claimed.has(t.path)) continue;
      const score = scoreSourceKeyword(t, kw);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best && bestScore > 0) {
      claimed.add(best.id);
      claimed.add(best.path);
      bound.push({
        ...best,
        id: m.id,
        name: m.label?.trim() || m.keyword.trim(),
        matchedName: best.name,
        matchKeyword: kw,
      });
    } else {
      bound.push({
        id: m.id,
        name: m.label?.trim() || m.keyword.trim(),
        path: "",
        headers: [],
        rowCount: 0,
        headerRow: 1,
        headerOk: false,
        headerMessage: `未匹配到名称含「${kw}」的源表/文件夹`,
        kind: "file",
        matchKeyword: kw,
        matchedName: "",
      });
    }
  }

  const leftovers = scanned.filter(
    (t) => !claimed.has(t.id) && !claimed.has(t.path),
  );
  return [...bound, ...leftovers];
}

/** For each scanned table not yet covered, add a matcher with auto default keyword. */
export function ensureSourceMatchers(
  scanned: SourceTable[],
  matchers: SourceMatcher[] | undefined,
): SourceMatcher[] {
  const prev = [...(matchers ?? [])];
  const byId = new Set(prev.map((m) => m.id));
  const claimed = new Set<string>();

  const existing = prev.filter((m) => m.keyword?.trim() && m.id?.trim());
  const ordered = [...existing].sort(
    (a, b) => b.keyword.trim().length - a.keyword.trim().length,
  );
  for (const m of ordered) {
    let best: SourceTable | null = null;
    let bestScore = 0;
    for (const t of scanned) {
      if (claimed.has(t.id) || claimed.has(t.path)) continue;
      const score = scoreSourceKeyword(t, m.keyword);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best && bestScore > 0) {
      claimed.add(best.id);
      claimed.add(best.path);
    }
  }

  let changed = false;
  for (const t of scanned) {
    if (byId.has(t.id)) continue;
    if (claimed.has(t.id) || claimed.has(t.path)) continue;
    const keyword = defaultSourceKeyword(t.name);
    if (!keyword) continue;
    prev.push({ id: t.id, keyword, label: keyword });
    byId.add(t.id);
    claimed.add(t.id);
    claimed.add(t.path);
    changed = true;
  }
  return changed ? prev : (matchers ?? prev);
}

export function upsertSourceMatcher(
  matchers: SourceMatcher[] | undefined,
  next: SourceMatcher,
): SourceMatcher[] {
  const id = next.id.trim();
  const keyword = next.keyword.trim();
  const prev = matchers ?? [];
  if (!id) return prev;
  if (!keyword) return prev.filter((m) => m.id !== id);
  const label = next.label?.trim() || keyword;
  const item: SourceMatcher = { id, keyword, label };
  const idx = prev.findIndex((m) => m.id === id);
  if (idx < 0) return [...prev, item];
  const copy = [...prev];
  copy[idx] = item;
  return copy;
}

export function matchersEqual(
  a: SourceMatcher[] | undefined,
  b: SourceMatcher[] | undefined,
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (
      aa[i].id !== bb[i].id ||
      aa[i].keyword !== bb[i].keyword ||
      (aa[i].label ?? "") !== (bb[i].label ?? "")
    ) {
      return false;
    }
  }
  return true;
}

/** 方案已登记但当前扫不到对应文件 */
export function isSourceFileMissing(
  s: Pick<SourceTable, "matchKeyword" | "matchedName"> & {
    path?: string | null;
  },
): boolean {
  const kw = s.matchKeyword?.trim();
  if (!kw) return false;
  if (!String(s.matchedName ?? "").trim()) return true;
  if (!String(s.path ?? "").trim()) return true;
  return false;
}

/**
 * 画布上保留：表头已就绪，或方案里已有但文件缺失的源表。
 * 仅扫到、尚未配表头的不自动上画布。
 */
export function shouldShowSourceOnCanvas(s: SourceTable): boolean {
  if (s.headerOk) return true;
  return isSourceFileMissing(s);
}

export function canvasSourceIds(sources: SourceTable[]): string[] {
  return sources.filter(shouldShowSourceOnCanvas).map((s) => s.id);
}
