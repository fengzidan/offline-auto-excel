export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "empty"
  | "not_empty";

export interface SourceTable {
  id: string;
  name: string;
  path: string;
  headers: string[];
  rowCount: number;
  headerRow: number;
  headerOk: boolean;
  headerMessage: string;
  kind?: "file" | "folder" | string;
  fileCount?: number;
  samplePath?: string;
  /** 关键字匹配到的实际文件/文件夹名 */
  matchedName?: string;
  /** 使用的匹配关键字 */
  matchKeyword?: string;
}

export interface SourceMatcher {
  /** 步骤里稳定引用的 id，如 src:人员清单 */
  id: string;
  /** 对扫描到的文件/文件夹名做包含匹配（忽略大小写） */
  keyword: string;
  /** 画布显示名，默认用 keyword */
  label?: string;
}

/** 执行前弹窗填写；流程中用 ${显示名} 引用，显示名即传参名 */
export interface PromptField {
  key: string;
  label: string;
  defaultValue?: string;
  /** 默认 true */
  required?: boolean;
}

export interface FolderMerge {
  keyColumn: string;
}

export interface FilterCondition {
  column: string;
  op: FilterOp;
  value: string;
  /**
   * 与上一条件的关系（第一条忽略）。
   * 求值：连续「且」成一组，组与组之间「或」。
   */
  join?: "and" | "or";
}

export interface ResultSpec {
  enabled: boolean;
  fileKey: string;
  sheetName: string;
}

export interface PivotValue {
  field: string;
  aggregation: string;
  alias: string;
}

export interface CalcJoin {
  tableId: string;
  baseKey: string;
  foreignKey: string;
}

export interface CalcColumn {
  outputField: string;
  formula: string;
}

export interface VlookupLookup {
  tableId: string;
  leftKey: string;
  rightKey: string;
  /** Empty = all columns from this table */
  columns: string[];
}

/** 拼版：同一 sheet 上的一张表块 / 格子 */
export interface SideBlock {
  tableId: string;
  /** 空 = 该表全部列 */
  columns?: string[];
}

/** @deprecated 改用 gridRows × gridCols + cells */
export type SideArrange = "horizontal" | "vertical" | "grid";

export interface SortKey {
  column: string;
  direction: "asc" | "desc";
}

export type Operation =
  | {
      type: "filter";
      inputTableId: string;
      conditions: FilterCondition[];
      /** 多条件关系：and=全部满足，or=任一满足；缺省 and */
      matchMode?: "and" | "or";
    }
  | {
      type: "pivot";
      inputTableId: string;
      rowFields: string[];
      valueFields: PivotValue[];
      valueField?: string;
      aggregation?: string;
    }
  | {
      type: "calculate";
      baseTableId: string;
      /** @deprecated prefer columns; kept for legacy schemes */
      outputField?: string;
      /** @deprecated prefer columns */
      formula?: string;
      columns: CalcColumn[];
      joins: CalcJoin[];
    }
  | {
      type: "sort";
      inputTableId: string;
      keys: SortKey[];
    }
  | {
      type: "dedupe";
      inputTableId: string;
      /** 判断行是否重复的列；空 = 整行各列都相同才算重复。重复时保留最先出现的行。 */
      columns: string[];
    }
  | {
      type: "lookupSubtract";
      leftTableId: string;
      rightTableId: string;
      leftKey: string;
      rightKey: string;
      leftValueField: string;
      rightValueField: string;
      outputField: string;
    }
  | {
      type: "sideBySide";
      /** 网格行数，默认 1 */
      gridRows?: number;
      /** 网格列数，默认 2 */
      gridCols?: number;
      /** 行优先格子；tableId 为空表示空格 */
      cells?: SideBlock[];
      /** 表块之间空列数，默认 1 */
      gapCols?: number;
      /** 表块之间空行数，默认 1 */
      gapRows?: number;
      /** @deprecated 由 cells 代替 */
      blocks?: SideBlock[];
      /** @deprecated 恒为网格 */
      arrange?: SideArrange;
      /** @deprecated 见 gridCols */
      gridColumns?: number;
      /** @deprecated 旧版按列拼接 */
      columns?: { tableId: string; column: string }[];
      /** @deprecated 旧版整表横向 */
      tableIds?: string[];
    }
  | {
      type: "vlookup";
      leftTableId: string;
      /** Columns from A. Empty = all */
      leftColumns: string[];
      /** @deprecated prefer lookups */
      leftKey?: string;
      /** @deprecated prefer lookups */
      rightTableId?: string;
      /** @deprecated prefer lookups */
      rightKey?: string;
      /** @deprecated prefer lookups */
      rightColumns?: string[];
      lookups: VlookupLookup[];
    }
  | {
      /** 全量对表：A、B 行都保留 */
      type: "fullJoin";
      leftTableId: string;
      rightTableId: string;
      leftKey: string;
      rightKey: string;
      leftColumns: string[];
      rightColumns: string[];
    }
  | {
      /** 输出：汇总写入结果 Excel */
      type: "output";
      /** 结果文件目录（同步到 pipeline.outputDir） */
      outputDir: string;
      /** 按顺序导出的表；tableId 为上游步骤 outputTableId 或源表 id */
      sheets: OutputSheetRef[];
    }
  | {
      /** 开始：配置源表文件夹 */
      type: "start";
      /** 源数据目录（同步到 pipeline.sourceDir） */
      sourceDir: string;
    };

/** 输出节点内的一张 Sheet */
export interface OutputSheetRef {
  tableId: string;
  sheetName: string;
}

export interface Step {
  id: string;
  name: string;
  outputTableId: string;
  operation: Operation;
  result?: ResultSpec | null;
}

export interface Pipeline {
  id: string;
  name: string;
  sourceDir: string;
  outputDir: string;
  headerRows: Record<string, number>;
  steps: Step[];
  /** Final sheet order & names for export */
  outputSheets: OutputSheet[];
  /** 子文件夹累计表：按哪一列用最新文件覆盖旧行 */
  folderMerges: Record<string, FolderMerge>;
  /** 流程图节点坐标（拖拽后持久化） */
  flowPositions?: Record<string, { x: number; y: number }>;
  /** 流程图连线（可拖拽改接；与步骤内表绑定可独立） */
  flowEdges?: FlowEdgeSpec[];
  /** 源表模糊匹配：稳定 id ← 关键字 */
  sourceMatchers?: SourceMatcher[];
  /** 每次跑数前填写的业务参数（流程中用 ${显示名} 引用，如月份、机构） */
  promptFields?: PromptField[];
}

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface OutputSheet {
  stepId: string;
  sheetName: string;
}

export interface SchemeSummary {
  id: string;
  name: string;
  sourceDir: string;
  updatedAt: string;
}

export interface PreviewData {
  headers: string[];
  rows: string[][];
  totalRows: number;
  /** Per-column group for header color (表对表: 0=A, 1=B) */
  headerGroups?: number[];
  /** 拼版等多表 sheet：额外表头色带（row 为 sheet 行号） */
  headerBands?: { row: number; col: number; groups: number[] }[];
}

export interface RawSheetPreview {
  rows: string[][];
  totalRows: number;
}

export interface ExecuteResult {
  outputFiles: string[];
  sheetNames: string[];
  message: string;
}

export function newId(): string {
  return crypto.randomUUID();
}

function producerNodeId(
  tableId: string,
  steps: Pick<Step, "id" | "outputTableId">[],
): string {
  const tid = tableId.trim();
  if (!tid) return tid;
  return steps.find((s) => s.outputTableId === tid)?.id ?? tid;
}

export function createEmptyPipeline(name = "未命名方案"): Pipeline {
  const p: Pipeline = {
    id: newId(),
    name,
    sourceDir: "",
    outputDir: "",
    headerRows: {},
    steps: [],
    outputSheets: [],
    folderMerges: {},
    flowPositions: {},
    flowEdges: [],
    sourceMatchers: [],
    promptFields: [],
  };
  return normalizePipeline(p);
}

/** 操作指引用固定方案 id，重复打开会重置为最简示例 */
export const GUIDE_DEMO_SCHEME_ID = "ae-guide-demo";

/** 内置最简示例：开始 → 筛选 → 输出，并带一个「月份」初始数据 */
export function createGuideDemoPipeline(): Pipeline {
  const startId = "guide-start";
  const filterId = "guide-filter";
  const outputId = "guide-output";
  const filterOut = "tmp:guide-filter";
  const monthKey = "月份";
  const monthNodeId = `prompt:${monthKey}`;

  const start: Step = {
    id: startId,
    name: "开始",
    outputTableId: "tmp:guide-start",
    operation: { type: "start", sourceDir: "" },
    result: { enabled: false, fileKey: "main", sheetName: "" },
  };
  const filter: Step = {
    id: filterId,
    name: "筛选示例",
    outputTableId: filterOut,
    operation: {
      type: "filter",
      inputTableId: "",
      conditions: [
        {
          column: "",
          op: "contains",
          value: `\${${monthKey}}`,
          join: "and",
        },
      ],
      matchMode: "and",
    },
    result: {
      enabled: true,
      fileKey: "main",
      sheetName: "筛选结果",
    },
  };
  const output: Step = {
    id: outputId,
    name: "输出",
    outputTableId: "tmp:guide-output",
    operation: {
      type: "output",
      outputDir: "",
      sheets: [{ tableId: filterOut, sheetName: "筛选结果" }],
    },
    result: { enabled: false, fileKey: "main", sheetName: "" },
  };

  return normalizePipeline({
    id: GUIDE_DEMO_SCHEME_ID,
    name: "入门示例",
    sourceDir: "",
    outputDir: "",
    headerRows: {},
    steps: [start, filter, output],
    outputSheets: [
      { stepId: filterId, sheetName: "筛选结果" },
    ],
    folderMerges: {},
    flowPositions: {
      [startId]: { x: 280, y: 48 },
      [filterId]: { x: 280, y: 380 },
      [outputId]: { x: 280, y: 540 },
      [monthNodeId]: { x: 600, y: 48 },
    },
    flowEdges: [
      {
        id: `${filterId}->${outputId}`,
        source: filterId,
        target: outputId,
      },
      {
        id: `${monthNodeId}->${filterId}`,
        source: monthNodeId,
        target: filterId,
      },
    ],
    sourceMatchers: [],
    promptFields: [
      { key: monthKey, label: monthKey, defaultValue: "", required: true },
    ],
  });
}

/** Keep outputSheets in sync with the output node (or legacy result flags). */
export function syncOutputSheets(pipeline: Pipeline): OutputSheet[] {
  const outStep = pipeline.steps.find((s) => s.operation.type === "output");
  if (outStep && outStep.operation.type === "output") {
    const next: OutputSheet[] = [];
    for (const sh of outStep.operation.sheets ?? []) {
      const tid = sh.tableId?.trim();
      if (!tid) continue;
      const producer = pipeline.steps.find(
        (s) => s.outputTableId === tid && s.operation.type !== "output",
      );
      if (!producer) continue;
      next.push({
        stepId: producer.id,
        sheetName: sh.sheetName?.trim() || producer.name,
      });
    }
    return next;
  }
  const enabled = pipeline.steps.filter((s) => s.result?.enabled);
  const existing = pipeline.outputSheets ?? [];
  const next: OutputSheet[] = [];
  for (const o of existing) {
    const step = enabled.find((s) => s.id === o.stepId);
    if (!step) continue;
    next.push({
      stepId: o.stepId,
      sheetName: step.result?.sheetName || o.sheetName || step.name,
    });
  }
  for (const s of [...enabled].reverse()) {
    if (!next.some((o) => o.stepId === s.id)) {
      next.unshift({
        stepId: s.id,
        sheetName: s.result?.sheetName || s.name,
      });
    }
  }
  return next;
}

/** Sync pipeline.sourceDir from the start node. */
export function syncPipelineFromStartStep(pipeline: Pipeline): Pipeline {
  const start = pipeline.steps.find((s) => s.operation.type === "start");
  if (!start || start.operation.type !== "start") return pipeline;
  const sourceDir = start.operation.sourceDir?.trim() || pipeline.sourceDir;
  return { ...pipeline, sourceDir };
}

/** Sync pipeline.outputDir / outputSheets / result flags from the output node. */
export function syncPipelineFromOutputStep(pipeline: Pipeline): Pipeline {
  const outStep = pipeline.steps.find((s) => s.operation.type === "output");
  if (!outStep || outStep.operation.type !== "output") {
    return { ...pipeline, outputSheets: syncOutputSheets(pipeline) };
  }
  const op = outStep.operation;
  const outputSheets = syncOutputSheets(pipeline);
  const steps = pipeline.steps.map((s) => {
    if (s.operation.type === "output") return s;
    const sheet = outputSheets.find((o) => o.stepId === s.id);
    if (sheet) {
      return {
        ...s,
        result: {
          enabled: true,
          fileKey: s.result?.fileKey || "main",
          sheetName: sheet.sheetName || s.name,
        },
      };
    }
    if (s.result?.enabled) {
      return {
        ...s,
        result: { ...s.result, enabled: false },
      };
    }
    return s;
  });
  return {
    ...pipeline,
    steps,
    outputDir: op.outputDir?.trim() || pipeline.outputDir,
    outputSheets,
  };
}

/** Normalize legacy single-formula calculate steps to `columns[]`. */
export function normalizeCalculateColumns(
  op: Extract<Operation, { type: "calculate" }>,
): Extract<Operation, { type: "calculate" }> {
  let columns = (op.columns ?? []).filter(
    (c) => c && (c.outputField?.trim() || c.formula?.trim()),
  );
  if (columns.length === 0) {
    columns = [
      {
        outputField: op.outputField?.trim() || "计算结果",
        formula: op.formula ?? "=",
      },
    ];
  }
  const first = columns[0];
  return {
    ...op,
    columns,
    outputField: first.outputField,
    formula: first.formula,
  };
}

export function normalizeVlookupLookups(
  op: Extract<Operation, { type: "vlookup" }>,
): Extract<Operation, { type: "vlookup" }> {
  let lookups = (op.lookups ?? []).filter((l) => l && l.tableId?.trim());
  if (lookups.length === 0 && op.rightTableId?.trim()) {
    lookups = [
      {
        tableId: op.rightTableId,
        leftKey: op.leftKey ?? "",
        rightKey: op.rightKey ?? "",
        columns: op.rightColumns ?? [],
      },
    ];
  }
  if (lookups.length === 0) {
    lookups = [{ tableId: "", leftKey: "", rightKey: "", columns: [] }];
  }
  const first = lookups[0];
  return {
    ...op,
    lookups,
    leftKey: first.leftKey,
    rightTableId: first.tableId,
    rightKey: first.rightKey,
    rightColumns: first.columns,
  };
}

/** Keep at most one start and one output; merge sheets from duplicate outputs. */
function dedupeStartAndOutputSteps(steps: Step[]): {
  steps: Step[];
  removedIds: Set<string>;
} {
  const starts = steps.filter((s) => s.operation.type === "start");
  const outputs = steps.filter((s) => s.operation.type === "output");
  if (starts.length <= 1 && outputs.length <= 1) {
    return { steps, removedIds: new Set() };
  }

  const keepStart =
    starts.find(
      (s) => s.operation.type === "start" && s.operation.sourceDir.trim(),
    ) ?? starts[0];

  let keepOut =
    outputs.find(
      (s) => s.operation.type === "output" && s.operation.outputDir.trim(),
    ) ?? outputs[0];

  if (keepOut && keepOut.operation.type === "output") {
    const sheets: OutputSheetRef[] = [...keepOut.operation.sheets];
    let outputDir = keepOut.operation.outputDir;
    for (const s of outputs) {
      if (s.id === keepOut.id || s.operation.type !== "output") continue;
      if (!outputDir.trim() && s.operation.outputDir.trim()) {
        outputDir = s.operation.outputDir;
      }
      for (const sh of s.operation.sheets) {
        if (!sheets.some((x) => x.tableId === sh.tableId)) sheets.push(sh);
      }
    }
    keepOut = {
      ...keepOut,
      operation: { ...keepOut.operation, outputDir, sheets },
    };
  }

  const removedIds = new Set<string>();
  for (const s of starts) {
    if (keepStart && s.id !== keepStart.id) removedIds.add(s.id);
  }
  for (const s of outputs) {
    if (keepOut && s.id !== keepOut.id) removedIds.add(s.id);
  }
  if (removedIds.size === 0) return { steps, removedIds };

  const next = steps
    .filter((s) => !removedIds.has(s.id))
    .map((s) => {
      if (keepOut && s.id === keepOut.id) return keepOut;
      if (keepStart && s.id === keepStart.id) return keepStart;
      return s;
    });
  return { steps: next, removedIds };
}

export function normalizePipelineWithMeta(pipeline: Pipeline): {
  pipeline: Pipeline;
  createdStartId: string | null;
} {
  let steps: Step[] = pipeline.steps.map((s) => {
    if (s.operation.type === "filter") {
      const mode: "and" | "or" = s.operation.matchMode === "or" ? "or" : "and";
      const conditions = (s.operation.conditions ?? []).map((c, i) => ({
        ...c,
        join:
          i === 0
            ? ("and" as const)
            : c.join === "or" || c.join === "and"
              ? c.join
              : mode,
      }));
      return {
        ...s,
        operation: {
          ...s.operation,
          matchMode: mode,
          conditions,
        },
      };
    }
    if (s.operation.type === "calculate") {
      return { ...s, operation: normalizeCalculateColumns(s.operation) };
    }
    if (s.operation.type === "vlookup") {
      return { ...s, operation: normalizeVlookupLookups(s.operation) };
    }
    if (s.operation.type === "sideBySide") {
      return { ...s, operation: normalizeSideBySide(s.operation) };
    }
    if (s.operation.type === "output") {
      return {
        ...s,
        operation: {
          type: "output" as const,
          outputDir: s.operation.outputDir ?? pipeline.outputDir ?? "",
          sheets: [...(s.operation.sheets ?? [])],
        },
      };
    }
    if (s.operation.type === "start") {
      return {
        ...s,
        operation: {
          type: "start" as const,
          sourceDir: s.operation.sourceDir ?? pipeline.sourceDir ?? "",
        },
      };
    }
    return s;
  });

  let flowEdges = [...(pipeline.flowEdges ?? [])];
  let flowPositions = { ...(pipeline.flowPositions ?? {}) };
  let createdStartId: string | null = null;

  const deduped = dedupeStartAndOutputSteps(steps);
  steps = deduped.steps;
  if (deduped.removedIds.size > 0) {
    const keepStartId =
      steps.find((s) => s.operation.type === "start")?.id ?? null;
    const keepOutId =
      steps.find((s) => s.operation.type === "output")?.id ?? null;
    const edgeKey = new Set<string>();
    const remapped: FlowEdgeSpec[] = [];
    for (const e of flowEdges) {
      let source = e.source;
      let target = e.target;
      if (deduped.removedIds.has(source) && keepStartId) source = keepStartId;
      if (deduped.removedIds.has(target) && keepOutId) target = keepOutId;
      if (deduped.removedIds.has(source) || deduped.removedIds.has(target)) {
        continue;
      }
      if (source === target) continue;
      const id = source === e.source && target === e.target ? e.id : `${source}->${target}`;
      const key = `${source}|${target}|${e.sourceHandle ?? ""}|${e.targetHandle ?? ""}`;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      remapped.push({
        ...e,
        id,
        source,
        target,
      });
    }
    flowEdges = remapped;
    for (const id of deduped.removedIds) delete flowPositions[id];
  }

  let start = steps.find((s) => s.operation.type === "start");
  if (!start) {
    start = createStep("start");
    if (start.operation.type === "start") {
      start.operation.sourceDir = pipeline.sourceDir || "";
    }
    steps = [start, ...steps];
    // 与 FLOW_LAYOUT 默认纵排一致（避免 types↔flowOps 循环依赖）
    flowPositions[start.id] = flowPositions[start.id] ?? { x: 280, y: 48 };
    createdStartId = start.id;
  } else if (
    start.operation.type === "start" &&
    !start.operation.sourceDir.trim() &&
    pipeline.sourceDir
  ) {
    steps = steps.map((s) =>
      s.id === start!.id && s.operation.type === "start"
        ? {
            ...s,
            operation: {
              ...s.operation,
              sourceDir: pipeline.sourceDir,
            },
          }
        : s,
    );
  }

  let out = steps.find((s) => s.operation.type === "output");
  if (!out) {
    out = createStep("output");
    if (out.operation.type === "output") {
      out.operation.outputDir = pipeline.outputDir || "";
      const sheets: OutputSheetRef[] = [];
      for (const o of pipeline.outputSheets ?? []) {
        const step = steps.find((s) => s.id === o.stepId);
        if (!step || step.operation.type === "output") continue;
        sheets.push({
          tableId: step.outputTableId,
          sheetName: o.sheetName || step.name,
        });
      }
      for (const s of steps) {
        if (s.operation.type === "output" || !s.result?.enabled) continue;
        if (sheets.some((x) => x.tableId === s.outputTableId)) continue;
        sheets.push({
          tableId: s.outputTableId,
          sheetName: s.result?.sheetName || s.name,
        });
      }
      out.operation.sheets = sheets;
    }
    steps = [...steps, out];
    const startX = (start && flowPositions[start.id]?.x) ?? 280;
    const maxY = Math.max(
      230,
      ...Object.values(flowPositions).map((p) => p.y),
      0,
    );
    flowPositions[out.id] = flowPositions[out.id] ?? {
      x: startX,
      y: maxY + 150,
    };
    for (const sh of out.operation.type === "output" ? out.operation.sheets : []) {
      const from = producerNodeId(sh.tableId, steps);
      if (!from || from === out.id) continue;
      const id = `${from}->${out.id}`;
      if (!flowEdges.some((e) => e.id === id)) {
        flowEdges.push({ id, source: from, target: out.id });
      }
    }
  } else if (out.operation.type === "output" && !out.operation.outputDir.trim()) {
    steps = steps.map((s) =>
      s.id === out!.id && s.operation.type === "output"
        ? {
            ...s,
            operation: {
              ...s.operation,
              outputDir: pipeline.outputDir || s.operation.outputDir,
            },
          }
        : s,
    );
  }

  const normalized: Pipeline = {
    ...pipeline,
    flowPositions,
    flowEdges,
    sourceMatchers: pipeline.sourceMatchers ?? [],
    promptFields: pipeline.promptFields ?? [],
    steps,
  };
  const synced = syncPipelineFromStartStep(
    syncPipelineFromOutputStep(normalized),
  );
  return { pipeline: synced, createdStartId };
}

/** Normalize scheme; returns pipeline only (start/output nodes ensured). */
export function normalizePipeline(pipeline: Pipeline): Pipeline {
  return normalizePipelineWithMeta(pipeline).pipeline;
}

function normalizeSideBySide(
  op: Extract<Operation, { type: "sideBySide" }>,
): Extract<Operation, { type: "sideBySide" }> {
  let gridRows = op.gridRows ?? 0;
  let gridCols = op.gridCols ?? op.gridColumns ?? 0;
  let cells = [...(op.cells ?? [])];

  if (cells.length === 0 && op.blocks && op.blocks.length > 0) {
    const blocks = op.blocks.filter((b) => b.tableId);
    const arrange = op.arrange ?? "horizontal";
    if (arrange === "vertical") {
      gridRows = blocks.length || 1;
      gridCols = 1;
      cells = blocks.map((b) => ({ tableId: b.tableId, columns: b.columns ?? [] }));
    } else if (arrange === "grid") {
      gridCols = Math.max(1, op.gridColumns ?? op.gridCols ?? 2);
      gridRows = Math.max(1, Math.ceil(blocks.length / gridCols) || 1);
      cells = blocks.map((b) => ({ tableId: b.tableId, columns: b.columns ?? [] }));
    } else {
      gridRows = 1;
      gridCols = Math.max(1, blocks.length || 2);
      cells = blocks.map((b) => ({ tableId: b.tableId, columns: b.columns ?? [] }));
    }
  } else if (cells.length === 0 && op.tableIds && op.tableIds.length > 0) {
    gridRows = 1;
    gridCols = Math.max(1, op.tableIds.length);
    cells = op.tableIds.filter(Boolean).map((tableId) => ({ tableId, columns: [] }));
  } else if (cells.length === 0 && op.columns && op.columns.length > 0) {
    const blocks: SideBlock[] = [];
    let cur: SideBlock | null = null;
    for (const c of op.columns) {
      if (!c.tableId || !c.column) {
        cur = null;
        continue;
      }
      if (!cur || cur.tableId !== c.tableId) {
        cur = { tableId: c.tableId, columns: [c.column] };
        blocks.push(cur);
      } else {
        cur.columns = [...(cur.columns ?? []), c.column];
      }
    }
    gridRows = 1;
    gridCols = Math.max(1, blocks.length || 2);
    cells = blocks;
  }

  if (!gridRows) gridRows = 1;
  if (!gridCols) gridCols = 2;
  const size = gridRows * gridCols;
  while (cells.length < size) cells.push({ tableId: "", columns: [] });
  if (cells.length > size) cells = cells.slice(0, size);

  const blocks = cells.filter((c) => c.tableId.trim());

  return {
    ...op,
    gridRows,
    gridCols,
    cells,
    gapCols: 1,
    gapRows: 1,
    arrange: "grid",
    gridColumns: gridCols,
    blocks,
  };
}

export function createStep(
  type: Operation["type"],
  inputTableId = "",
): Step {
  const id = newId();
  const base = {
    id,
    outputTableId: `tmp:${id.slice(0, 8)}`,
    result: {
      enabled: false,
      fileKey: "main",
      sheetName: "",
    } as ResultSpec,
  };

  switch (type) {
    case "filter":
      return {
        ...base,
        name: "筛选",
        operation: {
          type: "filter",
          inputTableId,
          conditions: [{ column: "", op: "not_contains", value: "", join: "and" }],
          matchMode: "and",
        },
      };
    case "pivot":
      return {
        ...base,
        name: "透视表",
        operation: {
          type: "pivot",
          inputTableId,
          rowFields: [],
          valueFields: [],
        },
      };
    case "calculate":
      return {
        ...base,
        name: "计算",
        operation: {
          type: "calculate",
          baseTableId: inputTableId,
          columns: [{ outputField: "计算结果", formula: "=" }],
          joins: [],
        },
      };
    case "sort":
      return {
        ...base,
        name: "排序",
        operation: {
          type: "sort",
          inputTableId,
          keys: [{ column: "", direction: "asc" }],
        },
      };
    case "dedupe":
      return {
        ...base,
        name: "列数据去重",
        operation: {
          type: "dedupe",
          inputTableId,
          columns: [],
        },
      };
    case "lookupSubtract":
      return {
        ...base,
        name: "计算(旧)",
        operation: {
          type: "lookupSubtract",
          leftTableId: inputTableId,
          rightTableId: "",
          leftKey: "",
          rightKey: "",
          leftValueField: "",
          rightValueField: "",
          outputField: "新增保费",
        },
      };
    case "sideBySide":
      return {
        ...base,
        name: "拼版",
        operation: {
          type: "sideBySide",
          gridRows: 1,
          gridCols: 2,
          cells: [
            { tableId: "", columns: [] },
            { tableId: "", columns: [] },
          ],
          gapCols: 1,
          gapRows: 1,
          arrange: "grid",
          gridColumns: 2,
          blocks: [],
          columns: [],
          tableIds: [],
        },
      };
    case "vlookup":
      return {
        ...base,
        name: "表对表",
        operation: {
          type: "vlookup",
          leftTableId: inputTableId,
          leftColumns: [],
          lookups: [
            {
              tableId: "",
              leftKey: "",
              rightKey: "",
              columns: [],
            },
          ],
        },
      };
    case "fullJoin":
      return {
        ...base,
        name: "全量对表",
        operation: {
          type: "fullJoin",
          leftTableId: inputTableId,
          rightTableId: "",
          leftKey: "",
          rightKey: "",
          leftColumns: [],
          rightColumns: [],
        },
      };
    case "output":
      return {
        ...base,
        name: "输出",
        operation: {
          type: "output",
          outputDir: "",
          sheets: inputTableId
            ? [{ tableId: inputTableId, sheetName: "" }]
            : [],
        },
        result: { enabled: false, fileKey: "main", sheetName: "" },
      };
    case "start":
      return {
        ...base,
        name: "开始",
        operation: {
          type: "start",
          sourceDir: "",
        },
        result: { enabled: false, fileKey: "main", sheetName: "" },
      };
  }
}

export function createNicheDemoSteps(sourceTables: SourceTable[]): Step[] {
  const niche =
    sourceTables.find((t) => t.name.includes("利基")) ?? sourceTables[0];
  const hist =
    sourceTables.find((t) => t.name.includes("2025") || t.name.includes("同月")) ??
    sourceTables[1];

  const filter = createStep("filter", niche?.id ?? "");
  filter.name = "筛选利基清单";
  filter.result = {
    enabled: true,
    fileKey: "main",
    sheetName: "利基清单_已筛选",
  };
  if (filter.operation.type === "filter") {
    filter.operation.conditions = [
      { column: "二级机构", op: "not_contains", value: "江苏苏州支公司" },
      { column: "渠道", op: "not_contains", value: "DIY" },
    ];
  }

  const pivot = createStep("pivot", filter.outputTableId);
  pivot.name = "业务员保费透视";
  pivot.result = {
    enabled: true,
    fileKey: "main",
    sheetName: "保费求和透视",
  };
  if (pivot.operation.type === "pivot") {
    pivot.operation.rowFields = ["业务员代码", "业务员名称"];
    pivot.operation.valueFields = [
      {
        field: "保费变化量不含税",
        aggregation: "sum",
        alias: "",
      },
    ];
  }

  const calc = createStep("calculate", pivot.outputTableId);
  calc.name = "计算新增保费";
  calc.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "新增保费",
  };
  if (calc.operation.type === "calculate") {
    calc.operation.baseTableId = pivot.outputTableId;
    calc.operation.columns = [
      {
        outputField: "新增保费",
        formula: `=[${pivot.outputTableId}!保费变化量不含税_求和]-[${hist?.id ?? ""}!保费]`,
      },
    ];
    calc.operation.joins = hist
      ? [
          {
            tableId: hist.id,
            baseKey: "业务员代码",
            foreignKey: "业务员代码",
          },
        ]
      : [];
  }

  const side = createStep("sideBySide");
  side.name = "拼版输出";
  side.result = {
    enabled: true,
    fileKey: "main",
    sheetName: "拼版_同期透视新增",
  };
  if (side.operation.type === "sideBySide") {
    const cells: SideBlock[] = [
      hist?.id ? { tableId: hist.id } : { tableId: "", columns: [] },
      {
        tableId: pivot.outputTableId,
        columns: ["业务员代码", "业务员名称", "保费变化量不含税_求和"],
      },
      {
        tableId: calc.outputTableId,
        columns: ["新增保费"],
      },
      { tableId: "", columns: [] },
    ];
    side.operation.gridRows = 2;
    side.operation.gridCols = 2;
    side.operation.gridColumns = 2;
    side.operation.cells = cells;
    side.operation.arrange = "grid";
    side.operation.gapCols = 1;
    side.operation.gapRows = 1;
    side.operation.blocks = cells.filter((c) => c.tableId);
    side.operation.columns = [];
    side.operation.tableIds = [];
  }

  return [filter, pivot, calc, side];
}

/**
 * 编制人数核对方案（分公司下发编制 + 中支保费规模编制）。
 *
 * 源表约定（按文件名模糊匹配）：
 * - 人员清单：含 中心/一级部/岗位/员工工号（「中心」作为机构口径；若列名是「机构」请在步骤里改）
 * - 编制/下发：部门、岗位、总公司下发编制
 * - 保费：机构、今年保费计划（万）
 * - 规模编制对照 D：规模档次、保费下限（万）、保费上限（万）、岗位、编制人数
 */
export function createStaffingQuotaSteps(sourceTables: SourceTable[]): Step[] {
  const find = (...keys: string[]) =>
    sourceTables.find((t) => keys.some((k) => t.name.includes(k)));

  const staff =
    find("人员", "清单", "花名册") ?? sourceTables[0];
  const quotaB =
    find("编制", "下发") ?? sourceTables[1];
  const premiumC =
    find("保费", "中支") ?? sourceTables[2];
  const scaleD =
    find("规模", "档次", "对照") ?? sourceTables[3];

  const orgCol = staff?.headers.includes("机构")
    ? "机构"
    : staff?.headers.includes("中心")
      ? "中心"
      : "中心";

  // —— 1. 全量：按机构/一级部/岗位统计实际在岗人数 ——
  const pivotAll = createStep("pivot", staff?.id ?? "");
  pivotAll.name = "1.按机构岗位统计人数";
  pivotAll.result = {
    enabled: true,
    fileKey: "main",
    sheetName: "全量_机构岗位人数",
  };
  if (pivotAll.operation.type === "pivot") {
    pivotAll.operation.rowFields = [orgCol, "一级部", "岗位"];
    pivotAll.operation.valueFields = [
      {
        field: "员工工号",
        aggregation: "count",
        alias: "实际在岗人数",
      },
    ];
  }

  // —— 2. 分公司：筛「产险江苏分公司」 ——
  const filterHq = createStep("filter", pivotAll.outputTableId);
  filterHq.name = "2.筛选产险江苏分公司";
  filterHq.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "分公司_人数",
  };
  if (filterHq.operation.type === "filter") {
    filterHq.operation.conditions = [
      { column: orgCol, op: "eq", value: "产险江苏分公司" },
    ];
  }

  // —— 3. 用 B 表 SUMIFS 取下发编制（部门+岗位双条件） ——
  const calcB = createStep("calculate", filterHq.outputTableId);
  calcB.name = "3.匹配分公司下发编制";
  calcB.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "分公司_对接编制",
  };
  if (calcB.operation.type === "calculate") {
    const bId = quotaB?.id ?? "src:分公司编制";
    calcB.operation.baseTableId = filterHq.outputTableId;
    calcB.operation.columns = [
      {
        outputField: "总公司下发编制",
        formula: `=SUMIFS([${bId}!总公司下发编制],[${bId}!部门],[一级部],[${bId}!岗位],[岗位])`,
      },
    ];
    calcB.operation.joins = [];
  }

  // —— 4. 超编 = 实际在岗 - 总公司下发编制 ——
  const calcHq = createStep("calculate", calcB.outputTableId);
  calcHq.name = "4.计算分公司超编";
  calcHq.result = {
    enabled: true,
    fileKey: "main",
    sheetName: "分公司_超编情况",
  };
  if (calcHq.operation.type === "calculate") {
    calcHq.operation.baseTableId = calcB.outputTableId;
    calcHq.operation.columns = [
      {
        outputField: "超编情况",
        formula: "=[实际在岗人数]-[总公司下发编制]",
      },
    ];
    calcHq.operation.joins = [];
  }

  // —— 5. 中支：从全量人数中排除分公司 ——
  const filterBranch = createStep("filter", pivotAll.outputTableId);
  filterBranch.name = "5.筛选中支机构人数";
  filterBranch.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "中支_人数",
  };
  if (filterBranch.operation.type === "filter") {
    filterBranch.operation.conditions = [
      { column: orgCol, op: "neq", value: "产险江苏分公司" },
    ];
  }

  // —— 6. 对接 C 表保费 ——
  const vlookupC = createStep("vlookup", filterBranch.outputTableId);
  vlookupC.name = "6.对接中支保费计划";
  vlookupC.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "中支_对接保费",
  };
  if (vlookupC.operation.type === "vlookup") {
    vlookupC.operation.leftTableId = filterBranch.outputTableId;
    vlookupC.operation.leftColumns = [
      orgCol,
      "一级部",
      "岗位",
      "实际在岗人数",
    ];
    vlookupC.operation.lookups = [
      {
        tableId: premiumC?.id ?? "",
        leftKey: orgCol,
        rightKey: "机构",
        columns: ["今年保费计划（万）", "去年保费收入（万）"],
      },
    ];
  }

  // —— 7. 按保费划档（阈值与 D 表「规模档次」一致，可按实际调整） ——
  const calcBand = createStep("calculate", vlookupC.outputTableId);
  calcBand.name = "7.计算保费规模档次";
  calcBand.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "中支_规模档次",
  };
  if (calcBand.operation.type === "calculate") {
    calcBand.operation.baseTableId = vlookupC.outputTableId;
    calcBand.operation.columns = [
      {
        outputField: "规模档次",
        // 请与 D 表规模档次取值保持一致；阈值可按业务调整
        formula:
          '=IF([今年保费计划（万）]<5000,"5000万以下",IF([今年保费计划（万）]<10000,"5000-10000万","10000万及以上"))',
      },
    ];
    calcBand.operation.joins = [];
  }

  // —— 8. 用 D 表 SUMIFS 取应编人数 ——
  const calcQuota = createStep("calculate", calcBand.outputTableId);
  calcQuota.name = "8.匹配规模对应编制";
  calcQuota.result = {
    enabled: false,
    fileKey: "main",
    sheetName: "中支_应编人数",
  };
  if (calcQuota.operation.type === "calculate") {
    const dId = scaleD?.id ?? "src:规模编制对照";
    calcQuota.operation.baseTableId = calcBand.outputTableId;
    calcQuota.operation.columns = [
      {
        outputField: "应编人数",
        formula: `=SUMIFS([${dId}!编制人数],[${dId}!规模档次],[规模档次],[${dId}!岗位],[岗位])`,
      },
    ];
    calcQuota.operation.joins = [];
  }

  // —— 9. 中支超/少编 ——
  const calcBranchGap = createStep("calculate", calcQuota.outputTableId);
  calcBranchGap.name = "9.计算中支超少编";
  calcBranchGap.result = {
    enabled: true,
    fileKey: "main",
    sheetName: "中支_超少编情况",
  };
  if (calcBranchGap.operation.type === "calculate") {
    calcBranchGap.operation.baseTableId = calcQuota.outputTableId;
    calcBranchGap.operation.columns = [
      {
        outputField: "超少编",
        formula: "=[实际在岗人数]-[应编人数]",
      },
    ];
    calcBranchGap.operation.joins = [];
  }

  return [
    pivotAll,
    filterHq,
    calcB,
    calcHq,
    filterBranch,
    vlookupC,
    calcBand,
    calcQuota,
    calcBranchGap,
  ];
}

/** 约定文件名对应的源表占位（与 schemes/人力分析.json 一致；导入后源文件名须匹配） */
function manpowerSourceStubs(): SourceTable[] {
  const stub = (
    name: string,
    headers: string[],
  ): SourceTable => ({
    id: `src:${name}`,
    name,
    path: "",
    headers,
    rowCount: 0,
    headerRow: 1,
    headerOk: true,
    headerMessage: "",
    kind: "file",
    fileCount: 1,
    samplePath: "",
  });
  return [
    stub("人员清单", [
      "员工工号",
      "姓名",
      "职位",
      "职位级别",
      "中心",
      "一级部",
      "处/室/项目组",
      "岗位编码",
      "岗位",
      "在岗时间(当前)",
      "岗位成本属性",
      "职级序列",
      "子序列",
      "职务名称",
      "任职结束日期",
      "出生日期",
      "年龄",
    ]),
    stub("分公司下发编制", ["部门", "岗位", "总公司下发编制"]),
    stub("中支保费", ["机构", "今年保费计划（万）", "去年保费收入（万）"]),
    stub("规模编制对照", [
      "规模档次",
      "保费下限（万）",
      "保费上限（万）",
      "岗位",
      "编制人数",
    ]),
  ];
}

/** 生成「人力分析」方案（用于写出 schemes/人力分析.json） */
export function createManpowerAnalysisPipeline(): Pipeline {
  const p = createEmptyPipeline("人力分析");
  p.steps = createStaffingQuotaSteps(manpowerSourceStubs());
  p.outputSheets = syncOutputSheets(p);
  return p;
}
