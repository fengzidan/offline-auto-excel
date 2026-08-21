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
}

export interface FolderMerge {
  keyColumn: string;
}

export interface FilterCondition {
  column: string;
  op: FilterOp;
  value: string;
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

export interface SortKey {
  column: string;
  direction: "asc" | "desc";
}

export type Operation =
  | {
      type: "filter";
      inputTableId: string;
      conditions: FilterCondition[];
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
      outputField: string;
      formula: string;
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
      /** Columns that define uniqueness. Empty = all columns. */
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
      columns: { tableId: string; column: string }[];
      tableIds?: string[];
    }
  | {
      type: "vlookup";
      leftTableId: string;
      rightTableId: string;
      leftKey: string;
      rightKey: string;
      /** Empty = all columns from A */
      leftColumns: string[];
      /** Empty = all columns from B */
      rightColumns: string[];
    };

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

export function createEmptyPipeline(name = "未命名方案"): Pipeline {
  return {
    id: newId(),
    name,
    sourceDir: "",
    outputDir: "",
    headerRows: {},
    steps: [],
    outputSheets: [],
    folderMerges: {},
  };
}

/** Keep outputSheets in sync with steps marked as results; preserve order. */
export function syncOutputSheets(pipeline: Pipeline): OutputSheet[] {
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
  // New result steps prepended (newer first, matches previous 倒序 feel)
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
          conditions: [{ column: "", op: "not_contains", value: "" }],
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
          outputField: "计算结果",
          formula: "=",
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
        name: "列去重",
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
          rightTableId: "",
          leftKey: "",
          rightKey: "",
          leftColumns: [],
          rightColumns: [],
        },
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
    calc.operation.outputField = "新增保费";
    calc.operation.formula = `=[${pivot.outputTableId}!保费变化量不含税_求和]-[${hist?.id ?? ""}!保费]`;
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
    const cols: { tableId: string; column: string }[] = [];
    const pushTable = (id: string, headers: string[]) => {
      if (!id) return;
      if (cols.length) cols.push({ tableId: "", column: "" }); // spacer
      for (const h of headers) cols.push({ tableId: id, column: h });
    };
    // headers unknown at template time; leave empty for user to pick, keep table ids as hint via empty
    if (hist?.id) {
      cols.push({ tableId: hist.id, column: hist.headers[0] || "" });
      cols.push({ tableId: "", column: "" });
    }
    cols.push({ tableId: pivot.outputTableId, column: "业务员代码" });
    cols.push({ tableId: pivot.outputTableId, column: "业务员名称" });
    cols.push({ tableId: pivot.outputTableId, column: "保费变化量不含税_求和" });
    cols.push({ tableId: "", column: "" });
    cols.push({ tableId: calc.outputTableId, column: "新增保费" });
    side.operation.columns = cols.filter((c) => c.tableId || c.column === "");
    void pushTable;
  }

  return [filter, pivot, calc, side];
}
