import type { FlowEdgeSpec, Operation, Step } from "./types";
import {
  promptFieldNodeId,
  stepPromptFieldKeys,
} from "./runtimeParams";

/** 默认自上而下布局（避免节点堆叠） */
export const FLOW_LAYOUT = {
  colX: 280,
  startY: 48,
  sourceOffsetY: 170,
  sourceGapX: 230,
  stepStartY: 380,
  stepGapY: 150,
  fieldOffsetX: 320,
  fieldGapY: 110,
  overlapX: 190,
  overlapY: 120,
} as const;

export function defaultStartPos() {
  return { x: FLOW_LAYOUT.colX, y: FLOW_LAYOUT.startY };
}

export function defaultSourcePos(
  i: number,
  startPos?: { x: number; y: number } | null,
  sourceCount = 1,
) {
  const base = startPos ?? defaultStartPos();
  const count = Math.max(sourceCount, 1);
  const centered = i - (count - 1) / 2;
  return {
    x: base.x + centered * FLOW_LAYOUT.sourceGapX,
    y: base.y + FLOW_LAYOUT.sourceOffsetY,
  };
}

export function defaultStepPos(i: number, colX: number = FLOW_LAYOUT.colX) {
  return {
    x: colX,
    y: FLOW_LAYOUT.stepStartY + i * FLOW_LAYOUT.stepGapY,
  };
}

export function defaultOutputPos(
  transformCount: number,
  colX: number = FLOW_LAYOUT.colX,
) {
  return {
    x: colX,
    y: FLOW_LAYOUT.stepStartY + Math.max(transformCount, 0) * FLOW_LAYOUT.stepGapY,
  };
}

export function defaultFieldPos(i: number, startPos?: { x: number; y: number } | null) {
  const base = startPos ?? defaultStartPos();
  return {
    x: base.x + FLOW_LAYOUT.fieldOffsetX,
    y: base.y + i * FLOW_LAYOUT.fieldGapY,
  };
}

/** 若 preferred 与已有节点过近，则沿主列向下找空位 */
export function findFreeFlowPosition(
  preferred: { x: number; y: number },
  occupied: Record<string, { x: number; y: number }> | undefined,
  ignoreId?: string,
): { x: number; y: number } {
  const positions = Object.entries(occupied ?? {})
    .filter(([id]) => id !== ignoreId)
    .map(([, p]) => p);
  let pos = { ...preferred };
  for (let n = 0; n < 48; n++) {
    const hit = positions.some(
      (p) =>
        Math.abs(p.x - pos.x) < FLOW_LAYOUT.overlapX &&
        Math.abs(p.y - pos.y) < FLOW_LAYOUT.overlapY,
    );
    if (!hit) return pos;
    pos = {
      x: preferred.x,
      y: preferred.y + (n + 1) * FLOW_LAYOUT.stepGapY,
    };
  }
  return pos;
}

/** Table ids this step reads from. */
export function stepInputIds(op: Operation): string[] {
  switch (op.type) {
    case "filter":
    case "pivot":
    case "sort":
    case "dedupe":
      return op.inputTableId ? [op.inputTableId] : [];
    case "calculate":
      return [
        op.baseTableId,
        ...(op.joins ?? []).map((j) => j.tableId),
      ].filter(Boolean);
    case "lookupSubtract":
      return [op.leftTableId, op.rightTableId].filter(Boolean);
    case "sideBySide": {
      const fromCells = (op.cells ?? [])
        .map((c) => c.tableId)
        .filter(Boolean);
      if (fromCells.length) return [...new Set(fromCells)];
      const fromBlocks = (op.blocks ?? [])
        .map((b) => b.tableId)
        .filter(Boolean);
      if (fromBlocks.length) return [...new Set(fromBlocks)];
      if (op.columns?.length) {
        return [...new Set(op.columns.map((c) => c.tableId).filter(Boolean))];
      }
      return (op.tableIds ?? []).filter(Boolean);
    }
    case "vlookup": {
      const ids = [op.leftTableId];
      for (const lu of op.lookups ?? []) {
        if (lu.tableId) ids.push(lu.tableId);
      }
      if (op.rightTableId) ids.push(op.rightTableId);
      return [...new Set(ids.filter(Boolean))];
    }
    case "fullJoin":
      return [op.leftTableId, op.rightTableId].filter(Boolean);
    case "output":
      return [...new Set((op.sheets ?? []).map((s) => s.tableId).filter(Boolean))];
    case "start":
      return [];
  }
}

/** 当前可用的表 id：已扫描且文件仍在的源表 + 各步骤输出临时表 */
export function availableTableIds(
  sources: {
    id: string;
    path?: string;
    matchKeyword?: string;
    matchedName?: string;
  }[],
  steps: { outputTableId: string }[],
): Set<string> {
  const ids = new Set<string>();
  for (const s of sources) {
    if (!s.id) continue;
    const kw = s.matchKeyword?.trim();
    if (kw && !String(s.matchedName ?? "").trim()) continue;
    if (kw && !String(s.path ?? "").trim()) continue;
    ids.add(s.id);
  }
  for (const s of steps) {
    if (s.outputTableId) ids.add(s.outputTableId);
  }
  return ids;
}

/** 步骤已配置、但当前已不存在的输入表 */
export function missingStepInputIds(
  op: Operation,
  available: Set<string>,
): string[] {
  return stepInputIds(op).filter((id) => !!id && !available.has(id));
}

/** Resolve a table id to flowchart node id (producer step, or source table id). */
export function edgeSourceNodeId(
  tableId: string,
  steps: Pick<Step, "id" | "outputTableId">[],
): string {
  const tid = tableId.trim();
  if (!tid) return tid;
  const producer = steps.find((s) => s.outputTableId === tid);
  return producer?.id ?? tid;
}

/** Incoming sources implied by table inputs + `${prompt}` usages. */
export function desiredIncomingSources(
  step: Step,
  steps: Step[],
  /** When set, only wire prompt edges for these keys (skip not-yet-created fields). */
  knownPromptKeys?: Set<string> | null,
): string[] {
  const fromTables = stepInputIds(step.operation)
    .map((tid) => edgeSourceNodeId(tid, steps))
    .filter((from) => from && from !== step.id);
  const fromPrompts = stepPromptFieldKeys(step.operation)
    .filter((key) => !knownPromptKeys || knownPromptKeys.has(key))
    .map((key) => promptFieldNodeId(key));
  return [...new Set([...fromTables, ...fromPrompts])];
}

/** Default edge anchors: leave from bottom, enter at top. */
export const DEFAULT_EDGE_SOURCE_HANDLE = "s-bottom";
export const DEFAULT_EDGE_TARGET_HANDLE = "t-top";

function withDefaultHandles(
  spec: Pick<FlowEdgeSpec, "sourceHandle" | "targetHandle"> & {
    id: string;
    source: string;
    target: string;
  },
): FlowEdgeSpec {
  return {
    ...spec,
    sourceHandle: spec.sourceHandle || DEFAULT_EDGE_SOURCE_HANDLE,
    targetHandle: spec.targetHandle || DEFAULT_EDGE_TARGET_HANDLE,
  };
}

function knownPromptKeySet(
  promptFields?: { key?: string }[] | null,
): Set<string> | null {
  if (!promptFields) return null;
  return new Set(
    promptFields.map((f) => f.key?.trim()).filter((k): k is string => !!k),
  );
}

/** Edges implied by each step's configured input tables and prompt fields. */
export function derivedFlowEdges(
  steps: Step[],
  promptFields?: { key?: string }[] | null,
): FlowEdgeSpec[] {
  const known = knownPromptKeySet(promptFields);
  const specs: FlowEdgeSpec[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const from of desiredIncomingSources(step, steps, known)) {
      const id = `${from}->${step.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push(
        withDefaultHandles({
          id,
          source: from,
          target: step.id,
        }),
      );
    }
  }
  return specs;
}

/**
 * After a step is configured: make incoming edges match its input tables
 * and prompt-field usages. Preserves handle positions on edges that remain.
 */
export function syncIncomingEdgesForStep(
  flowEdges: FlowEdgeSpec[] | undefined,
  steps: Step[],
  stepId: string,
  promptFields?: { key?: string }[] | null,
): FlowEdgeSpec[] {
  const step = steps.find((s) => s.id === stepId);
  if (!step) return flowEdges ?? [];

  const known = knownPromptKeySet(promptFields);
  const desired = new Set(desiredIncomingSources(step, steps, known));

  const others = (flowEdges ?? []).filter((e) => e.target !== stepId);
  const kept: FlowEdgeSpec[] = [];
  for (const e of flowEdges ?? []) {
    if (e.target !== stepId) continue;
    if (desired.has(e.source)) kept.push(withDefaultHandles(e));
  }
  for (const from of desired) {
    if (kept.some((e) => e.source === from)) continue;
    kept.push(
      withDefaultHandles({
        id: `${from}->${stepId}`,
        source: from,
        target: stepId,
      }),
    );
  }
  return [...others, ...kept];
}

/** Re-sync incoming edges for every step (table + prompt usages). */
export function syncAllIncomingEdges(
  flowEdges: FlowEdgeSpec[] | undefined,
  steps: Step[],
  promptFields?: { key?: string }[] | null,
): FlowEdgeSpec[] {
  let edges = flowEdges ?? [];
  for (const s of steps) {
    edges = syncIncomingEdgesForStep(edges, steps, s.id, promptFields);
  }
  return edges;
}

/** Merge saved edges with derived ones (prefer saved handles). */
export function resolveFlowEdges(
  flowEdges: FlowEdgeSpec[] | undefined,
  steps: Step[],
  sourceIds: string[] = [],
  promptFields?: { key?: string }[] | null,
): FlowEdgeSpec[] {
  const derived = derivedFlowEdges(steps, promptFields);
  const stepIds = new Set(steps.map((s) => s.id));
  const sourceSet = new Set(sourceIds);
  const allowedTarget = (id: string) =>
    stepIds.has(id) || sourceSet.has(id) || id.startsWith("src:");

  let merged: FlowEdgeSpec[];
  if (!flowEdges?.length) {
    merged = derived.filter((e) => stepIds.has(e.target));
  } else {
    const byKey = new Map<string, FlowEdgeSpec>();
    for (const e of flowEdges) {
      const key = e.id || `${e.source}->${e.target}`;
      byKey.set(key, { ...e, id: key });
    }
    for (const d of derived) {
      if (!byKey.has(d.id)) byKey.set(d.id, d);
    }
    // Drop stale prompt→step edges that are no longer referenced
    const derivedIds = new Set(derived.map((d) => d.id));
    for (const [id, e] of [...byKey.entries()]) {
      if (!e.source.startsWith("prompt:")) continue;
      if (!derivedIds.has(id)) byKey.delete(id);
    }
    merged = [...byKey.values()].filter((e) => allowedTarget(e.target));
  }

  return syncStartSourceEdges(merged, steps, sourceIds);
}

/**
 * Keep start → source-table edges in sync with the current scan results.
 * Preserves manually adjusted handle positions on existing edges.
 */
export function syncStartSourceEdges(
  flowEdges: FlowEdgeSpec[] | undefined,
  steps: Step[],
  sourceIds: string[],
): FlowEdgeSpec[] {
  const start = steps.find((s) => s.operation.type === "start");
  const stepIds = new Set(steps.map((s) => s.id));
  if (!start) {
    return (flowEdges ?? []).filter(
      (e) => stepIds.has(e.target) || !e.target.startsWith("src:"),
    );
  }
  const startId = start.id;
  const desired = new Set(sourceIds.filter(Boolean));
  const prevByTarget = new Map<string, FlowEdgeSpec>();
  for (const e of flowEdges ?? []) {
    if (e.source !== startId) continue;
    if (stepIds.has(e.target)) continue;
    prevByTarget.set(e.target, e);
  }
  const others = (flowEdges ?? []).filter((e) => {
    if (e.source !== startId) return true;
    if (stepIds.has(e.target)) return true;
    return false;
  });
  const added: FlowEdgeSpec[] = [];
  for (const sid of desired) {
    if (sid === startId) continue;
    const prev = prevByTarget.get(sid);
    added.push(
      withDefaultHandles({
        id: `${startId}->${sid}`,
        source: startId,
        target: sid,
        sourceHandle: prev?.sourceHandle,
        targetHandle: prev?.targetHandle,
      }),
    );
  }
  return [...others, ...added];
}

export function flowEdgesEqual(
  a?: FlowEdgeSpec[] | null,
  b?: FlowEdgeSpec[] | null,
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const handle = (h: string | null | undefined, fallback: string) =>
    h || fallback;
  const key = (e: FlowEdgeSpec) =>
    `${e.id}\0${e.source}\0${e.target}\0${handle(e.sourceHandle, DEFAULT_EDGE_SOURCE_HANDLE)}\0${handle(e.targetHandle, DEFAULT_EDGE_TARGET_HANDLE)}`;
  const sa = aa.map(key).sort();
  const sb = bb.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

export function flowPositionsEqual(
  a?: Record<string, { x: number; y: number }> | null,
  b?: Record<string, { x: number; y: number }> | null,
): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  const keysA = Object.keys(aa);
  const keysB = Object.keys(bb);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const p = aa[k];
    const q = bb[k];
    if (!q || p.x !== q.x || p.y !== q.y) return false;
  }
  return true;
}

/** Bind upstream table as this step's primary / next input. */
export function applyFlowLink(op: Operation, tableId: string): Operation {
  const tid = tableId.trim();
  if (!tid) return op;

  switch (op.type) {
    case "filter":
    case "pivot":
    case "sort":
    case "dedupe":
      return { ...op, inputTableId: tid };
    case "calculate":
      return { ...op, baseTableId: tid };
    case "lookupSubtract":
      if (!op.leftTableId || op.leftTableId === tid) {
        return { ...op, leftTableId: tid };
      }
      return { ...op, rightTableId: tid };
    case "vlookup": {
      if (!op.leftTableId || op.leftTableId === tid) {
        return { ...op, leftTableId: tid };
      }
      const lookups = [...(op.lookups ?? [])];
      if (lookups.some((l) => l.tableId === tid)) return op;
      lookups.push({
        tableId: tid,
        leftKey: "",
        rightKey: "",
        columns: [],
      });
      return { ...op, lookups };
    }
    case "fullJoin":
      if (!op.leftTableId || op.leftTableId === tid) {
        return { ...op, leftTableId: tid };
      }
      return { ...op, rightTableId: tid };
    case "sideBySide": {
      const gridRows = Math.max(1, op.gridRows ?? 1);
      const gridCols = Math.max(1, op.gridCols ?? op.gridColumns ?? 2);
      const size = gridRows * gridCols;
      let cells = [...(op.cells ?? [])];
      while (cells.length < size) cells.push({ tableId: "", columns: [] });
      if (!cells.some((c) => c.tableId === tid)) {
        const empty = cells.findIndex((c) => !c.tableId.trim());
        if (empty >= 0) {
          cells[empty] = { tableId: tid, columns: [] };
        } else {
          cells.push({ tableId: tid, columns: [] });
        }
      }
      cells = cells.slice(0, Math.max(size, cells.length));
      const nextCols =
        cells.length > size
          ? Math.max(gridCols, Math.ceil(cells.length / gridRows))
          : gridCols;
      const nextSize = gridRows * nextCols;
      while (cells.length < nextSize) cells.push({ tableId: "", columns: [] });
      cells = cells.slice(0, nextSize);
      const blocks = cells.filter((c) => c.tableId.trim());
      return {
        ...op,
        cells,
        blocks,
        gridRows,
        gridCols: nextCols,
        gridColumns: nextCols,
        gapCols: 1,
        gapRows: 1,
        tableIds: [...new Set([...(op.tableIds ?? []), tid])],
      };
    }
    case "output": {
      if (op.sheets.some((s) => s.tableId === tid)) return op;
      return {
        ...op,
        sheets: [...op.sheets, { tableId: tid, sheetName: "" }],
      };
    }
    case "start":
      return op;
  }
}

/** Remove a linked table from the step inputs. */
export function applyFlowUnlink(op: Operation, tableId: string): Operation {
  const tid = tableId.trim();
  if (!tid) return op;

  switch (op.type) {
    case "filter":
    case "pivot":
    case "sort":
    case "dedupe":
      return op.inputTableId === tid ? { ...op, inputTableId: "" } : op;
    case "calculate":
      return {
        ...op,
        baseTableId: op.baseTableId === tid ? "" : op.baseTableId,
        joins: (op.joins ?? []).filter((j) => j.tableId !== tid),
      };
    case "lookupSubtract":
      return {
        ...op,
        leftTableId: op.leftTableId === tid ? "" : op.leftTableId,
        rightTableId: op.rightTableId === tid ? "" : op.rightTableId,
      };
    case "vlookup":
      return {
        ...op,
        leftTableId: op.leftTableId === tid ? "" : op.leftTableId,
        rightTableId: op.rightTableId === tid ? "" : op.rightTableId,
        lookups: (op.lookups ?? []).filter((l) => l.tableId !== tid),
      };
    case "fullJoin":
      return {
        ...op,
        leftTableId: op.leftTableId === tid ? "" : op.leftTableId,
        rightTableId: op.rightTableId === tid ? "" : op.rightTableId,
      };
    case "sideBySide": {
      const cells = (op.cells ?? []).map((c) =>
        c.tableId === tid ? { tableId: "", columns: [] } : c,
      );
      return {
        ...op,
        cells,
        blocks: cells.filter((c) => c.tableId.trim()),
        gapCols: 1,
        gapRows: 1,
        tableIds: (op.tableIds ?? []).filter((id) => id !== tid),
        columns: (op.columns ?? []).filter((c) => c.tableId !== tid),
      };
    }
    case "output":
      return {
        ...op,
        sheets: op.sheets.filter((s) => s.tableId !== tid),
      };
    case "start":
      return op;
  }
}

/** Directed upstream + downstream from `startId` (not the full undirected component). */
export function collectFlowPath(
  startId: string,
  edges: { id: string; source: string; target: string }[],
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const outgoing = new Map<string, { other: string; edgeId: string }[]>();
  const incoming = new Map<string, { other: string; edgeId: string }[]>();
  const link = (
    map: Map<string, { other: string; edgeId: string }[]>,
    from: string,
    to: string,
    edgeId: string,
  ) => {
    if (!map.has(from)) map.set(from, []);
    map.get(from)!.push({ other: to, edgeId });
  };
  for (const e of edges) {
    link(outgoing, e.source, e.target, e.id);
    link(incoming, e.target, e.source, e.id);
  }
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!startId) return { nodeIds, edgeIds };
  nodeIds.add(startId);

  const walk = (
    seed: string,
    map: Map<string, { other: string; edgeId: string }[]>,
  ) => {
    const stack = [seed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const { other, edgeId } of map.get(cur) ?? []) {
        edgeIds.add(edgeId);
        if (!nodeIds.has(other)) {
          nodeIds.add(other);
          stack.push(other);
        }
      }
    }
  };
  walk(startId, outgoing);
  walk(startId, incoming);
  return { nodeIds, edgeIds };
}

/** Only immediate upstream + downstream neighbors (one hop). */
export function collectFlowNeighbors(
  rootId: string,
  edges: { id: string; source: string; target: string }[],
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!rootId) return { nodeIds, edgeIds };
  nodeIds.add(rootId);
  for (const e of edges) {
    if (e.source === rootId) {
      edgeIds.add(e.id);
      nodeIds.add(e.target);
    } else if (e.target === rootId) {
      edgeIds.add(e.id);
      nodeIds.add(e.source);
    }
  }
  return { nodeIds, edgeIds };
}

export function opLabel(op: Operation): string {
  switch (op.type) {
    case "filter":
      return "筛选";
    case "pivot":
      return "透视";
    case "calculate":
      return "计算";
    case "sort":
      return "排序";
    case "dedupe":
      return "列数据去重";
    case "lookupSubtract":
      return "计算(旧)";
    case "sideBySide":
      return "拼版";
    case "vlookup":
      return "表对表";
    case "fullJoin":
      return "全量对表";
    case "output":
      return "输出";
    case "start":
      return "开始";
  }
}

export function opAccent(type: Operation["type"]): string {
  switch (type) {
    case "filter":
      return "#2f6fed";
    case "pivot":
      return "#c45c26";
    case "calculate":
      return "#0f7b6c";
    case "sort":
      return "#6b5b95";
    case "dedupe":
      return "#8a6d3b";
    case "lookupSubtract":
      return "#0f7b6c";
    case "sideBySide":
      return "#3d7a9c";
    case "vlookup":
      return "#b54768";
    case "fullJoin":
      return "#8b5cf6";
    case "output":
      return "#4f46e5";
    case "start":
      return "#0d9488";
    default:
      return "#5c6b7a";
  }
}
