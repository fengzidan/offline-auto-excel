import type { Pipeline, SourceMatcher, SourceTable } from "./types";
import { stepInputIds, syncAllIncomingEdges, syncStartSourceEdges } from "./flowOps";
import { promptFieldNodeId } from "./runtimeParams";

function basenameParts(pathOrName: string): string[] {
  const base = pathOrName
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop();
  if (!base) return [];
  const stem = base.replace(/\.[^.]+$/, "");
  const out = [base];
  if (stem && stem !== base) out.push(stem);
  if (stem && !stem.startsWith("src:")) out.push(`src:${stem}`);
  return out;
}

function portableToken(key: string): string {
  return key
    .replace(/^src:/, "")
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * 导出时保留的源表：仅被后续加工/输出步骤实际引用的源表。
 * 只挂在开始节点、未进入任何步骤的表不导出。
 */
export function flowchartSourceIds(
  pipeline: Pipeline,
  _sources?: SourceTable[] | null,
): Set<string> {
  const steps = pipeline.steps ?? [];
  const stepIds = new Set(steps.map((s) => s.id));
  const stepOutputs = new Set(
    steps.map((s) => s.outputTableId).filter(Boolean),
  );
  const promptIds = new Set(
    (pipeline.promptFields ?? [])
      .map((f) => promptFieldNodeId(f.key.trim() || f.label?.trim() || ""))
      .filter(Boolean),
  );
  const matcherIds = new Set(
    (pipeline.sourceMatchers ?? []).map((m) => m.id.trim()).filter(Boolean),
  );
  const kept = new Set<string>();

  const consider = (raw: string) => {
    const id = raw.trim();
    if (!id) return;
    if (stepIds.has(id) || stepOutputs.has(id) || promptIds.has(id)) return;
    if (matcherIds.has(id) || id.startsWith("src:")) kept.add(id);
  };

  for (const step of steps) {
    if (step.operation.type === "start") continue;
    for (const tid of stepInputIds(step.operation)) {
      consider(tid);
    }
  }

  // 连线上：源表 → 加工步骤（开始→源表不算「用到」）
  const startId = steps.find((s) => s.operation.type === "start")?.id;
  for (const e of pipeline.flowEdges ?? []) {
    const src = e.source?.trim();
    const tgt = e.target?.trim();
    if (!src || !tgt) continue;
    if (startId && src === startId) continue;
    if (!stepIds.has(tgt) || tgt === startId) continue;
    if (stepIds.has(src) || promptIds.has(src)) continue;
    consider(src);
  }

  return kept;
}

/** Write portable header-row keys for one source / matcher. */
function putHeaderRow(
  into: Record<string, number>,
  row: number,
  keys: Array<string | undefined | null>,
) {
  if (!(row > 0)) return;
  for (const raw of keys) {
    const k = String(raw ?? "").trim();
    if (!k) continue;
    into[k] = row;
    if (k.includes("/") || k.includes("\\")) {
      for (const part of basenameParts(k)) into[part] = row;
    }
  }
}

function headerRowsFromSources(
  sources: SourceTable[],
  keptIds: Set<string>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const t of sources) {
    if (!keptIds.has(t.id)) continue;
    if (!t.headerOk || !(t.headerRow > 0)) continue;
    putHeaderRow(next, t.headerRow, [
      t.path,
      t.id,
      t.matchKeyword,
      t.matchedName,
      t.name,
      ...basenameParts(t.path || t.matchedName || t.name || ""),
    ]);
  }
  return next;
}

/**
 * 只保留已用源表相关的表头行；用精确 token 匹配，避免把未使用表的键模糊带进来。
 */
function headerRowsFromPipeline(
  headerRows: Record<string, number> | undefined,
  keptMatchers: SourceMatcher[],
  keptIds: Set<string>,
): Record<string, number> {
  const allowedExact = new Set<string>();
  const allowedTokens = new Set<string>();

  const addAllowed = (raw?: string) => {
    const k = String(raw ?? "").trim();
    if (!k) return;
    allowedExact.add(k);
    for (const part of basenameParts(k)) {
      allowedExact.add(part);
      const t = portableToken(part);
      if (t.length >= 2) allowedTokens.add(t);
    }
    const t = portableToken(k);
    if (t.length >= 2) allowedTokens.add(t);
  };

  for (const id of keptIds) addAllowed(id);
  for (const m of keptMatchers) {
    addAllowed(m.id);
    addAllowed(m.keyword);
    addAllowed(m.label);
  }

  const matchesAllowed = (key: string): boolean => {
    if (allowedExact.has(key)) return true;
    for (const part of basenameParts(key)) {
      if (allowedExact.has(part)) return true;
    }
    const token = portableToken(key);
    return token.length >= 2 && allowedTokens.has(token);
  };

  const next: Record<string, number> = {};
  for (const [key, row] of Object.entries(headerRows ?? {})) {
    if (!(row > 0)) continue;
    if (!matchesAllowed(key)) continue;
    if (key.includes("/") || key.includes("\\")) {
      putHeaderRow(next, row, [key]);
      continue;
    }
    next[key] = row;
  }

  for (const m of keptMatchers) {
    const id = m.id.trim();
    if (!id) continue;
    const candidates = [
      id,
      m.keyword?.trim(),
      m.label?.trim(),
      ...basenameParts(id),
      ...basenameParts(m.keyword ?? ""),
    ].filter(Boolean) as string[];
    let found = 0;
    for (const c of candidates) {
      if (next[c] > 0) {
        found = next[c];
        break;
      }
      const fromOrig = headerRows?.[c];
      if (fromOrig && fromOrig > 0) {
        found = fromOrig;
        break;
      }
    }
    if (!(found > 0)) {
      const idToken = portableToken(id);
      const kwToken = portableToken(m.keyword ?? "");
      for (const [key, row] of Object.entries({ ...headerRows, ...next })) {
        if (!(row > 0)) continue;
        const token = portableToken(key);
        if (!token) continue;
        if (idToken && token === idToken) {
          found = row;
          break;
        }
        if (kwToken && token === kwToken) {
          found = row;
          break;
        }
      }
    }
    if (found > 0) {
      putHeaderRow(next, found, [id, m.keyword, m.label]);
    }
  }

  return next;
}

export function buildExportHeaderRows(
  pipeline: Pipeline,
  sources: SourceTable[] | null | undefined,
  keptIds: Set<string>,
  keptMatchers: SourceMatcher[],
): Record<string, number> {
  const fromPipeline = headerRowsFromPipeline(
    pipeline.headerRows,
    keptMatchers,
    keptIds,
  );
  const fromSources = headerRowsFromSources(
    (sources ?? []).filter((s) => keptIds.has(s.id)),
    keptIds,
  );
  return { ...fromPipeline, ...fromSources };
}

/**
 * 导出前裁剪：去掉未进入后续流程的源表及其表头/坐标/连线。
 */
export function prunePipelineForExport(
  pipeline: Pipeline,
  sources?: SourceTable[] | null,
): Pipeline {
  const keptIds = flowchartSourceIds(pipeline, sources);
  const sourceMatchers = (pipeline.sourceMatchers ?? []).filter((m) =>
    keptIds.has(m.id.trim()),
  );

  const folderMerges: Pipeline["folderMerges"] = {};
  for (const [id, merge] of Object.entries(pipeline.folderMerges ?? {})) {
    if (keptIds.has(id)) folderMerges[id] = merge;
  }

  const headerRows = buildExportHeaderRows(
    pipeline,
    sources,
    keptIds,
    sourceMatchers,
  );

  const stepIds = new Set(pipeline.steps.map((s) => s.id));
  const promptIds = new Set(
    (pipeline.promptFields ?? [])
      .map((f) => promptFieldNodeId(f.key.trim() || f.label?.trim() || ""))
      .filter(Boolean),
  );
  const nodeIds = new Set<string>([...stepIds, ...promptIds, ...keptIds]);

  const flowPositions: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of Object.entries(pipeline.flowPositions ?? {})) {
    if (nodeIds.has(id)) flowPositions[id] = pos;
  }

  let flowEdges = (pipeline.flowEdges ?? []).filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );
  flowEdges = syncStartSourceEdges(
    flowEdges,
    pipeline.steps,
    [...keptIds],
  );
  flowEdges = syncAllIncomingEdges(
    flowEdges,
    pipeline.steps,
    pipeline.promptFields,
  );

  return {
    ...pipeline,
    sourceMatchers,
    folderMerges,
    headerRows,
    flowPositions,
    flowEdges,
  };
}
