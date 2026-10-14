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

/**
 * Source ids that have subsequent process steps (used as a step input).
 * Canvas-only / start→source with no downstream consumer are omitted on export.
 */
export function flowchartSourceIds(
  pipeline: Pipeline,
  _sources?: SourceTable[] | null,
): Set<string> {
  const steps = pipeline.steps ?? [];
  const stepIds = new Set(steps.map((s) => s.id));
  const stepOutputs = new Set(steps.map((s) => s.outputTableId).filter(Boolean));
  const promptIds = new Set(
    (pipeline.promptFields ?? [])
      .map((f) => promptFieldNodeId(f.key.trim() || f.label?.trim() || ""))
      .filter(Boolean),
  );
  const matcherIds = new Set(
    (pipeline.sourceMatchers ?? []).map((m) => m.id.trim()).filter(Boolean),
  );
  const kept = new Set<string>();

  for (const step of steps) {
    if (step.operation.type === "start") continue;
    for (const tid of stepInputIds(step.operation)) {
      const id = tid.trim();
      if (!id) continue;
      if (stepIds.has(id) || stepOutputs.has(id) || promptIds.has(id)) continue;
      // 步骤引用的源表 id（通常 src:… 或 matcher id）
      if (matcherIds.has(id) || id.startsWith("src:")) kept.add(id);
    }
  }

  return kept;
}

function mergeHeaderRowsForKeptSources(
  sources: SourceTable[],
  keptIds: Set<string>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const t of sources) {
    if (!keptIds.has(t.id)) continue;
    if (!t.headerOk || !(t.headerRow > 0)) continue;
    const row = t.headerRow;
    if (t.path?.trim()) next[t.path] = row;
    if (t.id?.trim()) next[t.id] = row;
    const kw = t.matchKeyword?.trim();
    if (kw) next[kw] = row;
    for (const key of basenameParts(t.path || t.matchedName || t.name || "")) {
      next[key] = row;
    }
  }
  return next;
}

function pruneHeaderRowsByMatchers(
  headerRows: Record<string, number> | undefined,
  keptMatchers: SourceMatcher[],
  keptIds: Set<string>,
): Record<string, number> {
  const allowed = new Set<string>();
  for (const id of keptIds) {
    allowed.add(id);
    for (const key of basenameParts(id)) allowed.add(key);
  }
  for (const m of keptMatchers) {
    allowed.add(m.id);
    for (const key of basenameParts(m.id)) allowed.add(key);
    if (m.keyword?.trim()) {
      allowed.add(m.keyword.trim());
      for (const key of basenameParts(m.keyword.trim())) allowed.add(key);
    }
    if (m.label?.trim()) {
      allowed.add(m.label.trim());
      for (const key of basenameParts(m.label.trim())) allowed.add(key);
    }
  }
  const portableTokens = [...allowed]
    .filter((k) => !k.includes("/") && !k.includes("\\"))
    .map((k) =>
      k
        .replace(/^src:/, "")
        .replace(/\.[^.]+$/, "")
        .trim()
        .toLowerCase(),
    )
    .filter((t) => t.length >= 2);

  const next: Record<string, number> = {};
  for (const [key, row] of Object.entries(headerRows ?? {})) {
    if (!(row > 0)) continue;
    if (allowed.has(key)) {
      next[key] = row;
      continue;
    }
    // Keep basename / copy-paste keys that still match a kept keyword
    if (key.includes("/") || key.includes("\\")) continue;
    const token = key
      .replace(/^src:/, "")
      .replace(/\.[^.]+$/, "")
      .trim()
      .toLowerCase();
    if (
      token.length >= 2 &&
      portableTokens.some((t) => token.includes(t) || t.includes(token))
    ) {
      next[key] = row;
    }
  }
  return next;
}

/**
 * 导出前裁剪：去掉无后续流程的源表配置与孤立坐标/连线。
 * 保留步骤、初始数据，以及仍被后续步骤引用的源表。
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

  const canvasSources = (sources ?? []).filter((s) => keptIds.has(s.id));
  const headerRows = canvasSources.length
    ? mergeHeaderRowsForKeptSources(canvasSources, keptIds)
    : pruneHeaderRowsByMatchers(
        pipeline.headerRows,
        sourceMatchers,
        keptIds,
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
