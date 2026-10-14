import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ErrorInfo,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Handle,
  Position,
  Panel,
  ConnectionMode,
  ConnectionLineType,
  SelectionMode,
  BaseEdge,
  getBezierPath,
  getStraightPath,
  reconnectEdge,
  useReactFlow,
  useNodesState,
  useViewport,
  useEdgesState,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeTypes,
  type OnNodeDrag,
  type OnReconnect,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowEdgeSpec, PromptField, SourceTable, Step } from "./types";
import {
  isSourceFileMissing,
  shouldShowSourceOnCanvas,
  canvasSourceIds,
} from "./sourceMatch";

import {
  collectFlowPath,
  collectFlowNeighbors,
  opAccent,
  opLabel,
  stepInputIds,
  availableTableIds,
  missingStepInputIds,
  resolveFlowEdges,
  DEFAULT_EDGE_SOURCE_HANDLE,
  DEFAULT_EDGE_TARGET_HANDLE,
  flowPositionsEqual,
  defaultStartPos,
  defaultSourcePos,
  defaultStepPos,
  defaultOutputPos,
  defaultFieldPos,
  FLOW_LAYOUT,
} from "./flowOps";

/** 离散缩放档位，避免任意小数倍缩放导致文字栅格发糊 */
const FLOW_ZOOM_STEPS = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5,
] as const;

function nearestFlowZoom(zoom: number): number {
  let best: number = FLOW_ZOOM_STEPS[0];
  let bestDist = Math.abs(zoom - best);
  for (const step of FLOW_ZOOM_STEPS) {
    const d = Math.abs(zoom - step);
    if (d < bestDist) {
      best = step;
      bestDist = d;
    }
  }
  return best;
}

function stepFlowZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    return (
      FLOW_ZOOM_STEPS.find((s) => s > zoom + 0.001) ??
      FLOW_ZOOM_STEPS[FLOW_ZOOM_STEPS.length - 1]
    );
  }
  const lower = [...FLOW_ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001);
  return lower ?? FLOW_ZOOM_STEPS[0];
}

function snapFlowViewport(v: Viewport): Viewport {
  return {
    x: Math.round(v.x),
    y: Math.round(v.y),
    zoom: nearestFlowZoom(v.zoom),
  };
}

import {
  isPromptFieldNodeId,
  promptFieldNodeId,
} from "./runtimeParams";

export type FlowNodeData = {
  kind: "source" | "step" | "field";
  label: string;
  tableId: string;
  step?: Step;
  /** prompt field key when kind === "field" */
  fieldKey?: string;
  index?: number;
  active?: boolean;
  inPath?: boolean;
  dimmed?: boolean;
  /** 执行中：当前步骤 */
  runCurrent?: boolean;
  /** 执行中：已完成 */
  runDone?: boolean;
  subtitle?: string;
  headerOk?: boolean;
  sourceWarn?: boolean;
  /** 源文件已不存在 */
  sourceMissing?: boolean;
  /** 引用的输入表已不存在 */
  inputWarn?: boolean;
};

type FlowNode = Node<FlowNodeData>;

export const STEP_DRAG_MIME = "application/x-auto-excel-step";

const VALID_STEP_DRAG_TYPES = new Set<Step["operation"]["type"]>([
  "start",
  "filter",
  "pivot",
  "calculate",
  "sort",
  "dedupe",
  "lookupSubtract",
  "sideBySide",
  "vlookup",
  "fullJoin",
  "output",
]);

/**
 * WebKit/Tauri 上 DataTransfer 在 drop 时常读不到自定义 MIME / text/plain，
 * 用模块级缓存兜底（在 palette 的 dragStart / dragEnd 维护）。
 */
let pendingStepDragType: Step["operation"]["type"] | null = null;

export function beginStepDrag(type: Step["operation"]["type"]) {
  pendingStepDragType = VALID_STEP_DRAG_TYPES.has(type) ? type : null;
}

export function endStepDrag() {
  pendingStepDragType = null;
}

function readStepDragType(dt: DataTransfer): Step["operation"]["type"] | null {
  const raw =
    dt.getData(STEP_DRAG_MIME) ||
    dt.getData("text/plain") ||
    dt.getData("Text") ||
    "";
  const type = raw.trim() as Step["operation"]["type"];
  if (VALID_STEP_DRAG_TYPES.has(type)) return type;
  if (pendingStepDragType && VALID_STEP_DRAG_TYPES.has(pendingStepDragType)) {
    return pendingStepDragType;
  }
  return null;
}

/** 新步骤落点：按节点大致半宽半高，使中心对准目标点 */
const PLACE_OFFSET = { x: 90, y: 36 };

export type FlowPlacementApi = {
  /** 当前可视区域中心（flow 坐标，已扣节点半尺寸） */
  viewportCenter: () => { x: number; y: number };
  /** 把画布节点当前位置写回方案（保存前调用） */
  flushPositions: () => void;
  /**
   * 指针拖放到画布：若 client 坐标在画布内则落点添加并返回 true。
   * 不依赖 HTML5 DataTransfer（Tauri/WebKit 更稳）。
   */
  placeStepAtClient: (
    type: Step["operation"]["type"],
    clientX: number,
    clientY: number,
  ) => boolean;
};

/** Loose 模式曾把终点接到 source 手柄；只保留合法 id，避免改接时 getHandle 抛错白屏 */
function sanitizeSourceHandle(
  h: string | null | undefined,
): string | undefined {
  return h && h.startsWith("s-") ? h : undefined;
}
function sanitizeTargetHandle(
  h: string | null | undefined,
): string | undefined {
  return h && h.startsWith("t-") ? h : undefined;
}

/** 改接时 fromPosition/toPosition 可能为空，getBezierPath 会直接抛错 */
function asPosition(pos: unknown, fallback: Position): Position {
  if (pos === Position.Left || pos === "left") return Position.Left;
  if (pos === Position.Right || pos === "right") return Position.Right;
  if (pos === Position.Top || pos === "top") return Position.Top;
  if (pos === Position.Bottom || pos === "bottom") return Position.Bottom;
  return fallback;
}

function arrowPolygon(x: number, y: number, pos: Position, size = 8): string {
  switch (pos) {
    case Position.Left:
      return `${x},${y} ${x - size},${y - size * 0.7} ${x - size},${y + size * 0.7}`;
    case Position.Right:
      return `${x},${y} ${x + size},${y - size * 0.7} ${x + size},${y + size * 0.7}`;
    case Position.Top:
      return `${x},${y} ${x - size * 0.7},${y - size} ${x + size * 0.7},${y - size}`;
    case Position.Bottom:
    default:
      return `${x},${y} ${x - size * 0.7},${y + size} ${x + size * 0.7},${y + size}`;
  }
}

/** 自绘箭头，不用 SVG marker（Tauri/WebView 上 marker + 改接易把画面画挂） */
function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  interactionWidth,
}: EdgeProps) {
  if (
    sourceX == null ||
    sourceY == null ||
    targetX == null ||
    targetY == null
  ) {
    return null;
  }
  const srcPos = asPosition(sourcePosition, Position.Right);
  const tgtPos = asPosition(targetPosition, Position.Left);
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: srcPos,
    targetPosition: tgtPos,
  });
  const stroke = (style?.stroke as string | undefined) || "#8aa396";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        interactionWidth={interactionWidth}
      />
      <polygon
        className="rf-edge-arrow"
        points={arrowPolygon(targetX, targetY, tgtPos)}
        fill={stroke}
        pointerEvents="none"
      />
    </>
  );
}

/** 拖终点改接时官方连线的 position 可能为空，Bezier 会崩；改接预览用直线最稳 */
function SafeConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  connectionLineStyle,
}: ConnectionLineComponentProps) {
  const [path] = getStraightPath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
  });
  return (
    <path
      fill="none"
      className="react-flow__connection-path"
      d={path}
      style={connectionLineStyle}
    />
  );
}

function QuadHandles() {
  // Strict：source 只能连 target；每边各留出入锚点
  return (
    <>
      <Handle type="target" position={Position.Top} id="t-top" className="rf-handle rf-handle-target" />
      <Handle type="source" position={Position.Top} id="s-top" className="rf-handle rf-handle-source" />
      <Handle type="target" position={Position.Right} id="t-right" className="rf-handle rf-handle-target" />
      <Handle type="source" position={Position.Right} id="s-right" className="rf-handle rf-handle-source" />
      <Handle type="target" position={Position.Bottom} id="t-bottom" className="rf-handle rf-handle-target" />
      <Handle type="source" position={Position.Bottom} id="s-bottom" className="rf-handle rf-handle-source" />
      <Handle type="target" position={Position.Left} id="t-left" className="rf-handle rf-handle-target" />
      <Handle type="source" position={Position.Left} id="s-left" className="rf-handle rf-handle-source" />
    </>
  );
}

function SourceNode({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className={`rf-node source ${data.inPath ? "in-path" : ""} ${data.dimmed ? "dimmed" : ""} ${data.sourceWarn ? "warn" : ""} ${data.sourceMissing ? "missing" : ""} ${data.active ? "active" : ""} ${data.runDone ? "run-done" : ""} ${data.runCurrent ? "run-current" : ""}`}
    >
      <QuadHandles />
      <div className="rf-top">
        <span className="rf-kicker">源表</span>
        {data.sourceMissing ? (
          <span className="rf-flag warn">缺失</span>
        ) : data.sourceWarn ? (
          <span className="rf-flag warn">表头</span>
        ) : null}
      </div>
      <span className="rf-title">{data.label}</span>
      {data.subtitle && <div className="rf-sub">{data.subtitle}</div>}
    </div>
  );
}

function FieldNode({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className={`rf-node field ${data.inPath ? "in-path" : ""} ${data.dimmed ? "dimmed" : ""} ${data.active ? "active" : ""}`}
      data-guide="node-prompt-field"
    >
      <QuadHandles />
      <div className="rf-top">
        <span className="rf-kicker">初始数据</span>
        <span className="rf-flag">输入</span>
      </div>
      <div className="rf-title">{data.label}</div>
      <div className="rf-sub">{data.subtitle ?? "双击填写参数"}</div>
    </div>
  );
}

function StepNode({ data }: NodeProps<FlowNode>) {
  const accent = data.step ? opAccent(data.step.operation.type) : "#5b6e64";
  const isOutput = data.step?.operation.type === "output";
  const isStart = data.step?.operation.type === "start";
  const sheetCount =
    isOutput && data.step?.operation.type === "output"
      ? data.step.operation.sheets.length
      : 0;
  const sourceDir =
    isStart && data.step?.operation.type === "start"
      ? data.step.operation.sourceDir.trim()
      : "";
  return (
    <div
      className={`rf-node step ${isOutput ? "output" : ""} ${isStart ? "start" : ""} ${data.active ? "active" : ""} ${data.inPath ? "in-path" : ""} ${data.dimmed ? "dimmed" : ""} ${data.inputWarn ? "warn" : ""} ${data.runDone ? "run-done" : ""} ${data.runCurrent ? "run-current" : ""}`}
      style={{ ["--flow-accent" as string]: accent }}
      data-guide={
        isStart
          ? "node-start"
          : isOutput
            ? "node-output"
            : data.step?.operation.type === "filter"
              ? "node-filter"
              : undefined
      }
    >
      <QuadHandles />
      <div className="rf-top">
        {data.index != null && !isOutput && !isStart && (
          <span className="rf-idx">{data.index + 1}</span>
        )}
        <span className="rf-kicker">
          {data.step ? opLabel(data.step.operation) : "步骤"}
        </span>
        {data.inputWarn ? (
          <span className="rf-flag warn">缺表</span>
        ) : isStart ? (
          <span className="rf-flag">输入</span>
        ) : isOutput ? (
          <span className="rf-flag">导出</span>
        ) : (
          data.step?.result?.enabled && <span className="rf-flag">结果</span>
        )}
      </div>
      <div className="rf-title">
        {isStart ? "开始" : isOutput ? "输出" : data.label}
      </div>
      <div className="rf-sub">
        {data.inputWarn
          ? data.subtitle
          : isStart
            ? sourceDir
              ? sourceDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
                sourceDir
              : "指定源表所在文件夹"
            : isOutput
              ? sheetCount > 0
                ? `${sheetCount} 张 Sheet`
                : "生成后的结果表"
              : data.subtitle}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  source: SourceNode,
  step: StepNode,
  field: FieldNode,
};

const edgeTypes: EdgeTypes = {
  flow: FlowEdge,
};

class FlowErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error?.message || "流程图渲染失败" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("StepsFlowchart crash", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flow-error-fallback">
          <p>流程图出错：{this.state.error}</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
          >
            重新加载画布
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function dataMatchHint(s: {
  matchKeyword?: string;
  matchedName?: string;
  headerRow?: number;
}): string | undefined {
  if (s.matchKeyword && s.matchedName) {
    return `关键字「${s.matchKeyword}」→ ${s.matchedName}`;
  }
  if (s.matchKeyword && !s.matchedName) {
    return `关键字「${s.matchKeyword}」未匹配`;
  }
  return undefined;
}

function buildNodes(
  steps: Step[],
  sources: SourceTable[],
  promptFields: PromptField[],
  activeStepId: string | null,
  activeSourceId: string | null,
  activeFieldKey: string | null,
  pathNodeIds: Set<string> | null,
  tableLabel: (id: string) => string,
  saved: Record<string, { x: number; y: number }>,
  prev: FlowNode[],
  runHighlight: { currentId: string | null; doneIds: string[] } | null,
): FlowNode[] {
  const prevPos = new Map(prev.map((n) => [n.id, n.position]));
  const prevSelected = new Map(prev.map((n) => [n.id, !!n.selected]));
  const posOf = (id: string, fallback: { x: number; y: number }) =>
    saved[id] ?? prevPos.get(id) ?? fallback;

  const usedSources = new Set<string>();
  // 表头就绪，或方案已登记但文件缺失：都保留在画布（缺失需手动删）
  for (const s of sources) {
    if (shouldShowSourceOnCanvas(s)) usedSources.add(s.id);
  }

  const sourceList = [...usedSources].map((id) => {
    const meta = sources.find((s) => s.id === id);
    return {
      id,
      label: meta?.name ?? id.replace(/^src:/, ""),
      headerOk: meta?.headerOk ?? true,
      kind: meta?.kind,
      headerRow: meta?.headerRow,
      rowCount: meta?.rowCount,
      matchKeyword: meta?.matchKeyword,
      matchedName: meta?.matchedName,
      path: meta?.path,
      headerMessage: meta?.headerMessage,
    };
  });

  const runMode = runHighlight != null;
  const doneSet = new Set(runHighlight?.doneIds ?? []);
  const currentId = runHighlight?.currentId ?? null;
  const hasPath = !runMode && pathNodeIds != null && pathNodeIds.size > 0;
  const nodes: FlowNode[] = [];

  const startStep = steps.find((s) => s.operation.type === "start");
  const startPos = startStep
    ? posOf(startStep.id, defaultStartPos())
    : null;
  const transformCount = steps.filter(
    (s) => s.operation.type !== "start" && s.operation.type !== "output",
  ).length;
  const colX = startPos?.x ?? defaultStartPos().x;

  sourceList.forEach((s, i) => {
    const inPath = hasPath && pathNodeIds!.has(s.id);
    const missing = isSourceFileMissing(s);
    const warn = missing || !s.headerOk;
    nodes.push({
      id: s.id,
      type: "source",
      position: posOf(
        s.id,
        defaultSourcePos(i, startPos, sourceList.length),
      ),
      data: {
        kind: "source",
        label: s.label,
        tableId: s.id,
        inPath,
        dimmed: missing
          ? false
          : runMode
            ? true
            : hasPath && !inPath,
        active: s.id === activeSourceId,
        headerOk: s.headerOk,
        sourceWarn: warn,
        sourceMissing: missing,
        subtitle: missing
          ? s.headerMessage ||
            dataMatchHint(s) ||
            "找不到对应文件，请改关键字或删除该表"
          : !s.headerOk
            ? dataMatchHint(s) || "双击确认表头行"
            : dataMatchHint(s) ||
              (s.headerRow ? `表头第 ${s.headerRow} 行` : undefined),
      },
      draggable: true,
      connectable: true,
      selectable: true,
      deletable: true,
      selected: prevSelected.get(s.id) ?? false,
    });
  });

  promptFields.forEach((f, i) => {
    const key = f.key.trim();
    if (!key) return;
    const id = promptFieldNodeId(key);
    const inPath = hasPath && pathNodeIds!.has(id);
    nodes.push({
      id,
      type: "field",
      position: posOf(id, defaultFieldPos(i, startPos)),
      data: {
        kind: "field",
        label: f.label?.trim() || key,
        tableId: id,
        fieldKey: key,
        inPath,
        dimmed: runMode ? true : hasPath && !inPath,
        active: key === activeFieldKey,
        subtitle: f.defaultValue
          ? `默认 ${f.defaultValue}`
          : `\${${key}}`,
      },
      draggable: true,
      connectable: true,
      selectable: true,
      deletable: true,
      selected: prevSelected.get(id) ?? false,
    });
  });

  let transformIndex = 0;
  const tableIdSet = availableTableIds(sources, steps);
  steps.forEach((step) => {
    const isAnchor =
      step.operation.type === "start" || step.operation.type === "output";
    const missingIds = missingStepInputIds(step.operation, tableIdSet);
    const inputWarn = missingIds.length > 0;
    const inputs = stepInputIds(step.operation)
      .map((id) => tableLabel(id))
      .filter(Boolean)
      .slice(0, 2);
    const inPath = hasPath && pathNodeIds!.has(step.id);
    const runCurrent = runMode && step.id === currentId;
    const runDone = runMode && doneSet.has(step.id);
    const fallback =
      step.operation.type === "start"
        ? { ...defaultStartPos(), x: colX }
        : step.operation.type === "output"
          ? defaultOutputPos(transformCount, colX)
          : defaultStepPos(transformIndex, colX);
    const index = isAnchor ? undefined : transformIndex++;
    const missingLabel = missingIds
      .map((id) => tableLabel(id) || id)
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
    nodes.push({
      id: step.id,
      type: "step",
      position: posOf(step.id, fallback),
      data: {
        kind: "step",
        label: step.name,
        tableId: step.outputTableId,
        step,
        index,
        active: step.id === activeStepId,
        inPath,
        runCurrent,
        runDone,
        inputWarn,
        dimmed: inputWarn
          ? false
          : runMode
            ? !runCurrent && !runDone
            : hasPath && !inPath,
        subtitle: inputWarn
          ? `缺表：${missingLabel || "未知"}`
          : inputs.join(" · "),
      },
      draggable: true,
      selectable: true,
      deletable: !isAnchor,
      selected: prevSelected.get(step.id) ?? false,
    });
  });

  return nodes;
}

function resolveEdgeSpecs(
  flowEdges: FlowEdgeSpec[] | undefined,
  steps: Step[],
  sourceIds: string[] = [],
  promptFields?: PromptField[],
): FlowEdgeSpec[] {
  return resolveFlowEdges(flowEdges, steps, sourceIds, promptFields);
}

function specsToRfEdges(
  specs: FlowEdgeSpec[],
  pathEdgeIds: Set<string> | null,
  startId: string | null = null,
  outputId: string | null = null,
  stepIds: Set<string> = new Set(),
): Edge[] {
  const hasPath = pathEdgeIds != null && pathEdgeIds.size > 0;
  return specs.map((spec) => {
    const inPath = hasPath && pathEdgeIds!.has(spec.id);
    const isPrompt = isPromptFieldNodeId(spec.source);
    const isStartSource =
      !!startId &&
      spec.source === startId &&
      !stepIds.has(spec.target);
    const isFromStart = !!startId && spec.source === startId;
    const isToOutput = !!outputId && spec.target === outputId;
    const specialStroke = isFromStart
      ? "#0d9488"
      : isToOutput
        ? "#4f46e5"
        : isPrompt
          ? "#d97706"
          : "#8aa396";
    return {
      id: spec.id,
      type: "flow",
      source: spec.source,
      target: spec.target,
      sourceHandle:
        sanitizeSourceHandle(spec.sourceHandle) ?? DEFAULT_EDGE_SOURCE_HANDLE,
      targetHandle:
        sanitizeTargetHandle(spec.targetHandle) ?? DEFAULT_EDGE_TARGET_HANDLE,
      style: {
        stroke: inPath ? "#217346" : specialStroke,
        strokeWidth: inPath
          ? 2.8
          : isFromStart || isToOutput || isPrompt
            ? 2.4
            : 1.6,
        strokeDasharray:
          isPrompt || isStartSource || isToOutput ? "6 4" : undefined,
        opacity: hasPath && !inPath ? 0.25 : 1,
      },
      className: inPath ? "edge-in-path" : hasPath ? "edge-dimmed" : undefined,
      reconnectable: !isPrompt,
      deletable: !isStartSource,
      selectable: true,
      focusable: true,
    } satisfies Edge;
  });
}

/** Steps on the connected path of `rootId`, in pipeline order. */
export function pathStepsInOrder(
  rootId: string,
  steps: Step[],
  flowEdges?: FlowEdgeSpec[],
): string[] {
  const specs = resolveEdgeSpecs(flowEdges, steps);
  const { nodeIds } = collectFlowPath(rootId, specs);
  return steps.filter((s) => nodeIds.has(s.id)).map((s) => s.id);
}

export function StepsFlowchart(props: {
  steps: Step[];
  sources: SourceTable[];
  promptFields?: PromptField[];
  activeStepId: string | null;
  activeSourceId?: string | null;
  activeFieldKey?: string | null;
  /** 方案切换时用于把流程居中到画布 */
  viewportSeed?: string | null;
  flowPositions?: Record<string, { x: number; y: number }>;
  flowEdges?: FlowEdgeSpec[];
  tableLabel: (id: string) => string;
  onSelect: (stepId: string) => void;
  onSelectSource?: (sourceId: string) => void;
  onSelectField?: (fieldKey: string) => void;
  onAddStepAt?: (
    type: Step["operation"]["type"],
    position: { x: number; y: number },
  ) => void;
  placementApiRef?: MutableRefObject<FlowPlacementApi | null>;
  onHighlightRoot?: (nodeId: string | null) => void;
  onLink: (fromTableId: string, toStepId: string, fromNodeId: string) => void;
  onUnlink: (fromTableId: string, toStepId: string) => void;
  onLinkPrompt?: (fieldKey: string, toStepId: string) => void;
  onUnlinkPrompt?: (fieldKey: string, toStepId: string) => void;
  onRemoveSteps: (stepIds: string[]) => void;
  onRemovePromptFields?: (fieldKeys: string[]) => void;
  /** 手动删除源表节点（从方案 matchers 移除） */
  onRemoveSources?: (sourceIds: string[]) => void;
  onDuplicateSelection?: (payload: {
    stepIds: string[];
    fieldKeys: string[];
    sourceIds: string[];
  }) => void;
  onPositionsChange: (positions: Record<string, { x: number; y: number }>) => void;
  onFlowEdgesChange: (edges: FlowEdgeSpec[]) => void;
  /** 画布操作提示（如非法改接） */
  onFlowNotice?: (message: string) => void;
  fullscreen?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** 执行生成时的节点高亮进度 */
  runHighlight?: { currentId: string | null; doneIds: string[] } | null;
}) {
  const [canvasKey, setCanvasKey] = useState(0);
  return (
    <div
      className={`flow-canvas rf-wrap${props.fullscreen ? " is-fullscreen" : ""}`}
    >
      <FlowErrorBoundary onReset={() => setCanvasKey((k) => k + 1)}>
        <ReactFlowProvider key={canvasKey}>
          <FlowCanvasInner {...props} />
        </ReactFlowProvider>
      </FlowErrorBoundary>
      {props.steps.length === 0 &&
        props.sources.length === 0 &&
        !(props.promptFields ?? []).length && (
        <div className="flow-empty-overlay">
          <p>先在「开始」里选好源表文件夹，再把加工步骤拖到画布上</p>
          <p className="muted">
            可添加「初始数据」（如月份、机构），点生成时再填本次要用的值
          </p>
        </div>
      )}
    </div>
  );
}

function FlowIssueSummary({
  sources,
  steps,
}: {
  sources: SourceTable[];
  steps: Step[];
}) {
  const summary = useMemo(() => {
    let sourceMissing = 0;
    let sourceHeader = 0;
    let stepBroken = 0;
    const available = availableTableIds(sources, steps);
    for (const s of sources) {
      if (!shouldShowSourceOnCanvas(s)) continue;
      if (isSourceFileMissing(s)) sourceMissing += 1;
      else if (!s.headerOk) sourceHeader += 1;
    }
    for (const step of steps) {
      if (missingStepInputIds(step.operation, available).length > 0) {
        stepBroken += 1;
      }
    }
    return {
      sourceMissing,
      sourceHeader,
      stepBroken,
      total: sourceMissing + sourceHeader + stepBroken,
    };
  }, [sources, steps]);

  if (summary.total === 0) {
    return (
      <Panel
        position="bottom-left"
        className="flow-issue-summary is-ok"
        aria-live="polite"
      >
        <span className="flow-issue-dot" aria-hidden />
        <strong>可以生成</strong>
      </Panel>
    );
  }

  const parts: string[] = [];
  if (summary.sourceMissing > 0) {
    parts.push(`${summary.sourceMissing} 张源表找不到文件`);
  }
  if (summary.sourceHeader > 0) {
    parts.push(`${summary.sourceHeader} 张表待确认表头`);
  }
  if (summary.stepBroken > 0) {
    parts.push(`${summary.stepBroken} 个步骤缺上游表`);
  }

  return (
    <Panel
      position="bottom-left"
      className="flow-issue-summary"
      aria-live="polite"
    >
      <div className="flow-issue-title">
        <span className="flow-issue-dot" aria-hidden />
        <strong>流程未齐</strong>
      </div>
      <div className="flow-issue-detail">{parts.join(" · ")}</div>
    </Panel>
  );
}

function FlowZoomToolbar({
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: {
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const { getViewport, setViewport, fitView } = useReactFlow();
  return (
    <Panel position="top-right" className="flow-top-right-tools">
      {(onUndo || onRedo) && (
        <div className="flow-history-panel" role="toolbar" aria-label="历史">
          <button
            type="button"
            title="撤回 (⌘Z / Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => onUndo?.()}
          >
            ↶
          </button>
          <button
            type="button"
            title="前进 (⌘⇧Z / Ctrl+Y)"
            disabled={!canRedo}
            onClick={() => onRedo?.()}
          >
            ↷
          </button>
        </div>
      )}
      <div className="flow-zoom-panel" role="toolbar" aria-label="缩放">
        <button
          type="button"
          title="放大"
          aria-label="放大"
          onClick={() => {
            const v = getViewport();
            setViewport({
              x: Math.round(v.x),
              y: Math.round(v.y),
              zoom: stepFlowZoom(v.zoom, 1),
            });
          }}
        >
          <svg
            className="ui-icon sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M11 8v6M8 11h6M20 20l-3.5-3.5" />
          </svg>
        </button>
        <button
          type="button"
          title="缩小"
          aria-label="缩小"
          onClick={() => {
            const v = getViewport();
            setViewport({
              x: Math.round(v.x),
              y: Math.round(v.y),
              zoom: stepFlowZoom(v.zoom, -1),
            });
          }}
        >
          <svg
            className="ui-icon sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M8 11h6M20 20l-3.5-3.5" />
          </svg>
        </button>
        <button
          type="button"
          title="适应画布"
          aria-label="适应画布"
          onClick={() => {
            void fitView({ padding: 0.2, duration: 0 }).then(() => {
              setViewport(snapFlowViewport(getViewport()));
            });
          }}
        >
          <svg
            className="ui-icon sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
          </svg>
        </button>
      </div>
    </Panel>
  );
}

function FlowSelectionBar({
  nodes,
  onRemoveSteps,
  onRemovePromptFields,
  onRemoveSources,
  onDuplicateSelection,
}: {
  nodes: FlowNode[];
  onRemoveSteps: (stepIds: string[]) => void;
  onRemovePromptFields?: (fieldKeys: string[]) => void;
  onRemoveSources?: (sourceIds: string[]) => void;
  onDuplicateSelection?: (payload: {
    stepIds: string[];
    fieldKeys: string[];
    sourceIds: string[];
  }) => void;
}) {
  const { getNodesBounds } = useReactFlow();
  const viewport = useViewport();
  const selected = nodes.filter((n) => n.selected);
  const selectedSteps = selected.filter((n) => n.data.kind === "step");
  const selectedFields = selected.filter((n) => n.data.kind === "field");
  const selectedSources = selected.filter((n) => n.data.kind === "source");

  // 仅框选/多选时显示；单击单选不展示
  if (selected.length < 2) return null;

  // 贴在多选包围盒上沿居中（用 viewport 换算到画布本地坐标，避免 flowToScreen 含页面偏移）
  const bounds = getNodesBounds(selected);
  const left =
    (bounds.x + bounds.width / 2) * viewport.zoom + viewport.x;
  // 底边贴齐选框顶边（translateY -100% 已把工具条抬到框线上方）
  const top = bounds.y * viewport.zoom + viewport.y;

  const stepIds = selectedSteps.map((n) => n.id);
  const fieldKeys = selectedFields
    .map((n) => n.data.fieldKey)
    .filter((k): k is string => !!k);
  const sourceIds = selectedSources.map((n) => n.id);

  const canCopy =
    !!onDuplicateSelection &&
    (selectedSteps.some(
      (n) =>
        n.data.step?.operation.type !== "start" &&
        n.data.step?.operation.type !== "output",
    ) ||
      fieldKeys.length > 0);

  const canDelete =
    selectedSteps.some(
      (n) =>
        n.data.step?.operation.type !== "start" &&
        n.data.step?.operation.type !== "output",
    ) ||
    (sourceIds.length > 0 && !!onRemoveSources) ||
    (fieldKeys.length > 0 && !!onRemovePromptFields);

  if (!canCopy && !canDelete) return null;

  return (
    <Panel
      className="flow-selection-bar flow-selection-bar-float"
      style={{
        left,
        top,
        right: "auto",
        bottom: "auto",
        margin: 0,
        transform: "translate(-50%, -100%)",
      }}
      role="toolbar"
      aria-label="多选操作"
    >
      {canCopy && (
        <button
          type="button"
          title="复制"
          aria-label="复制"
          onClick={() =>
            onDuplicateSelection?.({ stepIds, fieldKeys, sourceIds })
          }
        >
          <svg
            className="ui-icon sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M4 16V6a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className="danger"
          title="删除"
          aria-label="删除"
          onClick={() => {
            if (stepIds.length > 0) onRemoveSteps(stepIds);
            if (sourceIds.length > 0) onRemoveSources?.(sourceIds);
            if (fieldKeys.length > 0) onRemovePromptFields?.(fieldKeys);
          }}
        >
          <svg
            className="ui-icon sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 7h16" />
            <path d="M10 11v6M14 11v6" />
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
            <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}
    </Panel>
  );
}

function FlowCanvasInner({
  steps,
  sources,
  promptFields = [],
  activeStepId,
  activeSourceId = null,
  activeFieldKey = null,
  viewportSeed = null,
  flowPositions = {},
  flowEdges,
  tableLabel,
  onSelect,
  onSelectSource,
  onSelectField,
  onAddStepAt,
  placementApiRef,
  onHighlightRoot,
  onLink,
  onUnlink,
  onLinkPrompt,
  onUnlinkPrompt,
  onRemoveSteps,
  onRemovePromptFields,
  onRemoveSources,
  onDuplicateSelection,
  onPositionsChange,
  onFlowEdgesChange,
  onFlowNotice,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  runHighlight = null,
}: {
  steps: Step[];
  sources: SourceTable[];
  promptFields?: PromptField[];
  activeStepId: string | null;
  activeSourceId?: string | null;
  activeFieldKey?: string | null;
  viewportSeed?: string | null;
  flowPositions?: Record<string, { x: number; y: number }>;
  flowEdges?: FlowEdgeSpec[];
  tableLabel: (id: string) => string;
  onSelect: (stepId: string) => void;
  onSelectSource?: (sourceId: string) => void;
  onSelectField?: (fieldKey: string) => void;
  onAddStepAt?: (
    type: Step["operation"]["type"],
    position: { x: number; y: number },
  ) => void;
  placementApiRef?: MutableRefObject<FlowPlacementApi | null>;
  onHighlightRoot?: (nodeId: string | null) => void;
  onLink: (fromTableId: string, toStepId: string, fromNodeId: string) => void;
  onUnlink: (fromTableId: string, toStepId: string) => void;
  onLinkPrompt?: (fieldKey: string, toStepId: string) => void;
  onUnlinkPrompt?: (fieldKey: string, toStepId: string) => void;
  onRemoveSteps: (stepIds: string[]) => void;
  onRemovePromptFields?: (fieldKeys: string[]) => void;
  onRemoveSources?: (sourceIds: string[]) => void;
  onDuplicateSelection?: (payload: {
    stepIds: string[];
    fieldKeys: string[];
    sourceIds: string[];
  }) => void;
  onPositionsChange: (positions: Record<string, { x: number; y: number }>) => void;
  onFlowEdgesChange: (edges: FlowEdgeSpec[]) => void;
  onFlowNotice?: (message: string) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  runHighlight?: { currentId: string | null; doneIds: string[] } | null;
}) {
  const { screenToFlowPosition, fitView, getNodes } = useReactFlow();
  const paneHostRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [highlightRoot, setHighlightRoot] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  /** 连线拖拽/改接中：禁止用 props 重刷 nodes/edges，否则拖终点箭头会把画面清空 */
  const edgeGestureLockRef = useRef(false);
  const edgeSpecsRef = useRef<FlowEdgeSpec[]>([]);
  const pathEdgeIdsRef = useRef<Set<string> | null>(null);
  const unlockTimerRef = useRef<number | null>(null);
  const fittedSeedRef = useRef<string | null>(null);
  /** 正在改接的边（用于开始→源表虚线校验与提示） */
  const reconnectingEdgeRef = useRef<Edge | null>(null);
  const flowPositionsRef = useRef(flowPositions);
  flowPositionsRef.current = flowPositions;
  const onPositionsChangeRef = useRef(onPositionsChange);
  onPositionsChangeRef.current = onPositionsChange;

  const flowPointFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const p = screenToFlowPosition({ x: clientX, y: clientY });
      return { x: p.x - PLACE_OFFSET.x, y: p.y - PLACE_OFFSET.y };
    },
    [screenToFlowPosition],
  );

  const flushPositions = useCallback(() => {
    const list = getNodes();
    const next: Record<string, { x: number; y: number }> = {
      ...flowPositionsRef.current,
    };
    for (const n of list) {
      next[n.id] = {
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      };
    }
    if (flowPositionsEqual(next, flowPositionsRef.current)) return;
    onPositionsChangeRef.current(next);
  }, [getNodes]);

  const onAddStepAtRef = useRef(onAddStepAt);
  onAddStepAtRef.current = onAddStepAt;

  useLayoutEffect(() => {
    if (!placementApiRef) return;
    placementApiRef.current = {
      viewportCenter: () => {
        const host =
          paneHostRef.current?.querySelector(".react-flow") ??
          paneHostRef.current;
        const rect = host?.getBoundingClientRect();
        if (!rect || rect.width < 8 || rect.height < 8) {
          return { x: FLOW_LAYOUT.colX, y: FLOW_LAYOUT.stepStartY };
        }
        return flowPointFromClient(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
      },
      flushPositions,
      placeStepAtClient: (type, clientX, clientY) => {
        if (!onAddStepAtRef.current) return false;
        const host = paneHostRef.current;
        const canvas =
          (host?.closest(".flow-canvas") as HTMLElement | null) ?? host;
        if (!canvas) return false;
        // 用坐标命中（pointer capture 时 elementFromPoint 可能仍指向侧栏）
        const rect = canvas.getBoundingClientRect();
        const pad = 8;
        if (
          clientX < rect.left - pad ||
          clientX > rect.right + pad ||
          clientY < rect.top - pad ||
          clientY > rect.bottom + pad
        ) {
          return false;
        }
        onAddStepAtRef.current(type, flowPointFromClient(clientX, clientY));
        return true;
      },
    };
    return () => {
      placementApiRef.current = null;
    };
  }, [placementApiRef, flowPointFromClient, flushPositions]);

  const sourceIds = useMemo(
    () => canvasSourceIds(sources),
    [sources],
  );
  const startId = useMemo(
    () => steps.find((s) => s.operation.type === "start")?.id ?? null,
    [steps],
  );
  const outputId = useMemo(
    () => steps.find((s) => s.operation.type === "output")?.id ?? null,
    [steps],
  );
  const stepIdSet = useMemo(() => new Set(steps.map((s) => s.id)), [steps]);
  const edgeSpecs = useMemo(
    () => resolveEdgeSpecs(flowEdges, steps, sourceIds, promptFields),
    [flowEdges, steps, sourceIds, promptFields],
  );
  // 改接过程中不要用 props 覆盖本地已改的 specs
  if (!edgeGestureLockRef.current) {
    edgeSpecsRef.current = edgeSpecs;
  }

  const path = useMemo(() => {
    const root = highlightRoot ?? activeStepId;
    if (!root) return null;
    const rootStep = steps.find((s) => s.id === root);
    if (
      rootStep?.operation.type === "start" ||
      rootStep?.operation.type === "output" ||
      isPromptFieldNodeId(root)
    ) {
      return collectFlowNeighbors(root, edgeSpecs);
    }
    return collectFlowPath(root, edgeSpecs);
  }, [highlightRoot, activeStepId, edgeSpecs, steps]);
  pathEdgeIdsRef.current = path?.edgeIds ?? null;

  const applyEdgesFromSpecs = useCallback(
    (specs: FlowEdgeSpec[]) => {
      setEdges((prev) => {
        const selectedIds = new Set(
          prev.filter((e) => e.selected).map((e) => e.id),
        );
        return specsToRfEdges(
          specs,
          pathEdgeIdsRef.current,
          startId,
          outputId,
          stepIdSet,
        ).map((e) => ({
          ...e,
          selected: selectedIds.has(e.id),
          interactionWidth: 28,
        }));
      });
    },
    [setEdges, startId, outputId, stepIdSet],
  );

  const syncPayloadRef = useRef({
    steps,
    sources,
    promptFields,
    activeStepId,
    activeSourceId,
    activeFieldKey,
    pathNodeIds: path?.nodeIds ?? null,
    tableLabel,
    flowPositions,
    runHighlight,
    edgeSpecs,
  });
  syncPayloadRef.current = {
    steps,
    sources,
    promptFields,
    activeStepId,
    activeSourceId,
    activeFieldKey,
    pathNodeIds: path?.nodeIds ?? null,
    tableLabel,
    flowPositions,
    runHighlight,
    edgeSpecs,
  };
  const pendingNodeSyncRef = useRef(false);

  const flushFlowSync = useCallback(() => {
    const p = syncPayloadRef.current;
    setNodes((prev) =>
      buildNodes(
        p.steps,
        p.sources,
        p.promptFields,
        p.activeStepId,
        p.activeSourceId,
        p.activeFieldKey,
        p.pathNodeIds,
        p.tableLabel,
        p.flowPositions,
        prev,
        p.runHighlight,
      ),
    );
    applyEdgesFromSpecs(p.edgeSpecs);
  }, [setNodes, applyEdgesFromSpecs]);

  const beginEdgeGesture = useCallback(() => {
    if (unlockTimerRef.current != null) {
      window.clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = null;
    }
    edgeGestureLockRef.current = true;
    // 防止 onConnectEnd 未触发导致永久锁死、拖入步骤不刷新
    unlockTimerRef.current = window.setTimeout(() => {
      if (!edgeGestureLockRef.current) return;
      edgeGestureLockRef.current = false;
      unlockTimerRef.current = null;
      if (pendingNodeSyncRef.current) {
        pendingNodeSyncRef.current = false;
        flushFlowSync();
      }
    }, 2500);
  }, [flushFlowSync]);

  const endEdgeGesture = useCallback(() => {
    if (unlockTimerRef.current != null) {
      window.clearTimeout(unlockTimerRef.current);
    }
    unlockTimerRef.current = window.setTimeout(() => {
      edgeGestureLockRef.current = false;
      unlockTimerRef.current = null;
      // 锁期间若有方案变更（如拖入步骤），解锁后必须重刷节点，不能只刷边
      if (pendingNodeSyncRef.current) {
        pendingNodeSyncRef.current = false;
        flushFlowSync();
      } else {
        applyEdgesFromSpecs(edgeSpecsRef.current);
      }
    }, 120);
  }, [applyEdgesFromSpecs, flushFlowSync]);

  const syncKey = useMemo(
    () =>
      JSON.stringify({
        steps: steps.map((s) => ({
          id: s.id,
          name: s.name,
          out: s.outputTableId,
          op: s.operation,
          res: !!s.result?.enabled,
        })),
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          ok: s.headerOk,
          hr: s.headerRow,
          mk: s.matchKeyword ?? "",
          mn: s.matchedName ?? "",
        })),
        promptFields,
        activeStepId,
        activeSourceId,
        activeFieldKey,
        pathNodes: path ? [...path.nodeIds].sort() : [],
        runHighlight,
        positions: flowPositions,
        edgeSpecs,
      }),
    [
      steps,
      sources,
      promptFields,
      activeStepId,
      activeSourceId,
      activeFieldKey,
      path,
      flowPositions,
      edgeSpecs,
      runHighlight,
    ],
  );

  useEffect(() => {
    // 改接终点时 RF 会临时拆边；此时用 props 全量重刷会清空画布。
    // 但「新增」节点仍要立刻补上，否则拖入步骤会丢。
    if (edgeGestureLockRef.current) {
      pendingNodeSyncRef.current = true;
      const p = syncPayloadRef.current;
      setNodes((prev) => {
        const built = buildNodes(
          p.steps,
          p.sources,
          p.promptFields,
          p.activeStepId,
          p.activeSourceId,
          p.activeFieldKey,
          p.pathNodeIds,
          p.tableLabel,
          p.flowPositions,
          prev,
          p.runHighlight,
        );
        const have = new Set(prev.map((n) => n.id));
        const missing = built.filter((n) => !have.has(n.id));
        return missing.length ? [...prev, ...missing] : prev;
      });
      return;
    }
    pendingNodeSyncRef.current = false;
    flushFlowSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  useEffect(() => {
    if (!viewportSeed) return;
    if (nodes.length === 0) return;
    if (fittedSeedRef.current === viewportSeed) return;
    const t = window.setTimeout(() => {
      fittedSeedRef.current = viewportSeed;
      void fitView({ padding: 0.2, duration: 220 });
    }, 150);
    return () => window.clearTimeout(t);
  }, [viewportSeed, nodes.length, sources.length, fitView]);

  useEffect(() => {
    if (!activeStepId) {
      setHighlightRoot(null);
      onHighlightRoot?.(null);
    }
  }, [activeStepId, onHighlightRoot]);

  const handleNodesChange: OnNodesChange<FlowNode> = useCallback(
    (changes) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(() => {
    flushPositions();
  }, [flushPositions]);

  const onSelectionDragStop = useCallback(() => {
    flushPositions();
  }, [flushPositions]);

  const onNodesDelete = useCallback(
    (deleted: FlowNode[]) => {
      const stepIds = deleted
        .filter((n) => n.data.kind === "step")
        .map((n) => n.id);
      if (stepIds.length) onRemoveSteps(stepIds);
      const fieldKeys = deleted
        .filter((n) => n.data.kind === "field" && n.data.fieldKey)
        .map((n) => n.data.fieldKey!);
      if (fieldKeys.length) onRemovePromptFields?.(fieldKeys);
      const sourceIds = deleted
        .filter((n) => n.data.kind === "source")
        .map((n) => n.id);
      if (sourceIds.length) onRemoveSources?.(sourceIds);
    },
    [onRemoveSteps, onRemovePromptFields, onRemoveSources],
  );

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!onAddStepAt) return;
      const type = readStepDragType(event.dataTransfer);
      // 先读再清；部分 WebKit 会先 dragend 再 drop，故 end 侧延迟清空
      if (!type) return;
      endStepDrag();
      onAddStepAt(type, flowPointFromClient(event.clientX, event.clientY));
    },
    [onAddStepAt, flowPointFromClient],
  );

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const removes = changes.filter((ch) => ch.type === "remove");
      // 改接/新建连线时 RF 会临时 remove 边：本地可删，但不要 unlink / 写回方案
      if (removes.length && !edgeGestureLockRef.current) {
        let nextSpecs = edgeSpecsRef.current;
        for (const ch of removes) {
          if (ch.type !== "remove") continue;
          const edge = edges.find((e) => e.id === ch.id);
          if (!edge) continue;
          const srcNode = nodes.find((n) => n.id === edge.source);
          const tgtNode = nodes.find((n) => n.id === edge.target);
          const promptKey =
            srcNode?.data.fieldKey ??
            (isPromptFieldNodeId(edge.source)
              ? edge.source.slice("prompt:".length)
              : null);
          const isStartToSource =
            srcNode?.data.step?.operation.type === "start" &&
            tgtNode?.data.kind === "source";
          if (isStartToSource) {
            // 开始→源表由扫描结果驱动，不允许手删
            continue;
          }
          if (promptKey) {
            onUnlinkPrompt?.(promptKey, edge.target);
          } else if (tgtNode?.data.kind === "step") {
            const fromTable = srcNode?.data.tableId ?? edge.source;
            onUnlink(fromTable, edge.target);
          }
          nextSpecs = nextSpecs.filter((e) => e.id !== edge.id);
        }
        if (nextSpecs !== edgeSpecsRef.current) {
          edgeSpecsRef.current = nextSpecs;
          onFlowEdgesChange(nextSpecs);
        }
      }
      onEdgesChange(changes);
    },
    [edges, nodes, onEdgesChange, onUnlink, onUnlinkPrompt, onFlowEdgesChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      const src = nodes.find((n) => n.id === connection.source);
      const tgt = nodes.find((n) => n.id === connection.target);
      if (!src || !tgt || tgt.data.kind !== "step") return;
      const sourceHandle =
        sanitizeSourceHandle(connection.sourceHandle) ??
        DEFAULT_EDGE_SOURCE_HANDLE;
      const targetHandle =
        sanitizeTargetHandle(connection.targetHandle) ??
        DEFAULT_EDGE_TARGET_HANDLE;
      const id = `${connection.source}->${connection.target}`;
      const nextSpec: FlowEdgeSpec = {
        id,
        source: connection.source,
        target: connection.target,
        sourceHandle,
        targetHandle,
      };
      const withoutDup = edgeSpecsRef.current.filter(
        (e) =>
          !(e.source === nextSpec.source && e.target === nextSpec.target),
      );
      const next = [...withoutDup, nextSpec];
      edgeSpecsRef.current = next;
      applyEdgesFromSpecs(next);
      onFlowEdgesChange(next);
      if (src.data.kind === "field" && src.data.fieldKey) {
        onLinkPrompt?.(src.data.fieldKey, tgt.id);
      } else {
        onLink(src.data.tableId, tgt.id, src.id);
      }
    },
    [nodes, onLink, onLinkPrompt, onFlowEdgesChange, applyEdgesFromSpecs],
  );

  const onReconnect: OnReconnect = useCallback(
    (oldEdge, newConnection) => {
      if (!newConnection.source || !newConnection.target) return;
      if (newConnection.source === newConnection.target) return;

      const oldSrc = nodes.find((n) => n.id === oldEdge.source);
      const oldTgt = nodes.find((n) => n.id === oldEdge.target);
      const wasStartSource =
        oldSrc?.data.step?.operation.type === "start" &&
        oldTgt?.data.kind === "source";

      const newSrc = nodes.find((n) => n.id === newConnection.source);
      const newTgt = nodes.find((n) => n.id === newConnection.target);

      if (wasStartSource) {
        if (newSrc?.data.step?.operation.type !== "start") {
          onFlowNotice?.("源表只能连到「开始」节点");
          applyEdgesFromSpecs(edgeSpecsRef.current);
          return;
        }
        if (newTgt?.data.kind !== "source") {
          onFlowNotice?.("「开始」只能连到源表");
          applyEdgesFromSpecs(edgeSpecsRef.current);
          return;
        }
        const sourceHandle =
          sanitizeSourceHandle(newConnection.sourceHandle) ??
          DEFAULT_EDGE_SOURCE_HANDLE;
        const targetHandle =
          sanitizeTargetHandle(newConnection.targetHandle) ??
          DEFAULT_EDGE_TARGET_HANDLE;
        // 拓扑仍由扫描同步；这里只允许改连接点（手柄），节点保持原开始→该源表
        const source = oldEdge.source;
        const target = oldEdge.target;
        const patched: Connection = {
          ...newConnection,
          source,
          target,
          sourceHandle,
          targetHandle,
        };
        setEdges((els) =>
          reconnectEdge(oldEdge, patched, els, { shouldReplaceId: false }),
        );
        const next = edgeSpecsRef.current.map((e) =>
          e.id === oldEdge.id
            ? {
                id: oldEdge.id,
                source,
                target,
                sourceHandle,
                targetHandle,
              }
            : e,
        );
        edgeSpecsRef.current = next;
        onFlowEdgesChange(next);
        return;
      }

      if (!newTgt || newTgt.data.kind !== "step") return;
      const sourceHandle =
        sanitizeSourceHandle(newConnection.sourceHandle) ??
        DEFAULT_EDGE_SOURCE_HANDLE;
      const targetHandle =
        sanitizeTargetHandle(newConnection.targetHandle) ??
        DEFAULT_EDGE_TARGET_HANDLE;
      const patched: Connection = {
        ...newConnection,
        sourceHandle,
        targetHandle,
      };
      setEdges((els) =>
        reconnectEdge(oldEdge, patched, els, { shouldReplaceId: false }),
      );
      const next = edgeSpecsRef.current.map((e) =>
        e.id === oldEdge.id
          ? {
              id: `${newConnection.source}->${newConnection.target}`,
              source: newConnection.source!,
              target: newConnection.target!,
              sourceHandle,
              targetHandle,
            }
          : e,
      );
      edgeSpecsRef.current = next;
      onFlowEdgesChange(next);
    },
    [nodes, onFlowEdgesChange, onFlowNotice, setEdges, applyEdgesFromSpecs],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      const tgt = nodes.find((n) => n.id === c.target);
      const src = nodes.find((n) => n.id === c.source);
      if (!src || !tgt) return false;
      // Strict 下仍再挡一次：非法手柄 id 视为无效
      if (c.sourceHandle && !sanitizeSourceHandle(c.sourceHandle)) return false;
      if (c.targetHandle && !sanitizeTargetHandle(c.targetHandle)) return false;

      // 改接开始→源表虚线：先允许放下，由 onReconnect 校验并提示
      const re = reconnectingEdgeRef.current;
      if (re) {
        const oldSrc = nodes.find((n) => n.id === re.source);
        const oldTgt = nodes.find((n) => n.id === re.target);
        if (
          oldSrc?.data.step?.operation.type === "start" &&
          oldTgt?.data.kind === "source"
        ) {
          return true;
        }
      }

      // 开始 → 源表虚线（允许改接连接点）
      if (
        src.data.step?.operation.type === "start" &&
        tgt.data.kind === "source"
      ) {
        return true;
      }
      if (tgt.data.kind !== "step") return false;
      if (src.data.kind === "field") {
        const op = tgt.data.step?.operation.type;
        if (op !== "filter" && op !== "calculate") return false;
      }
      return true;
    },
    [nodes],
  );

  return (
    <div
      ref={paneHostRef}
      className="flow-pane-host"
      style={{ width: "100%", height: "100%" }}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onConnectStart={() => {
        beginEdgeGesture();
      }}
      onConnect={onConnect}
      onConnectEnd={() => {
        endEdgeGesture();
      }}
      onReconnectStart={(_event, edge) => {
        beginEdgeGesture();
        reconnectingEdgeRef.current = edge;
      }}
      onReconnect={onReconnect}
      onReconnectEnd={() => {
        reconnectingEdgeRef.current = null;
        endEdgeGesture();
      }}
      onError={(code, message) => {
        console.warn("react-flow", code, message);
      }}
      edgesReconnectable
      edgesFocusable
      elementsSelectable
      selectionMode={SelectionMode.Partial}
      selectNodesOnDrag={false}
      panOnDrag
      panActivationKeyCode={null}
      selectionOnDrag={false}
      selectionKeyCode={["Control", "Meta"]}
      multiSelectionKeyCode={["Meta", "Control"]}
      reconnectRadius={24}
      onNodeDragStop={onNodeDragStop}
      onSelectionDragStop={onSelectionDragStop}
      onNodesDelete={onNodesDelete}
      isValidConnection={isValidConnection}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionMode={ConnectionMode.Strict}
      connectionLineType={ConnectionLineType.Bezier}
      connectionLineComponent={SafeConnectionLine}
      minZoom={0.2}
      maxZoom={2.5}
      viewport={viewport}
      onViewportChange={setViewport}
      onMoveEnd={(_e, next) => setViewport(snapFlowViewport(next))}
      zoomOnDoubleClick={false}
      deleteKeyCode={["Backspace", "Delete"]}
      nodesDraggable
      nodesConnectable
      onEdgeClick={(event) => {
        event.stopPropagation();
      }}
      onNodeClick={(_e, node) => {
        setHighlightRoot(node.id);
        onHighlightRoot?.(node.id);
      }}
      onNodeDoubleClick={(_e, node) => {
        setHighlightRoot(node.id);
        onHighlightRoot?.(node.id);
        if (node.data.kind === "step") onSelect(node.id);
        if (node.data.kind === "source") onSelectSource?.(node.id);
        if (node.data.kind === "field" && node.data.fieldKey) {
          onSelectField?.(node.data.fieldKey);
        }
      }}
      onPaneClick={() => {
        setHighlightRoot(null);
        onHighlightRoot?.(null);
      }}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{
        type: "flow",
        style: { stroke: "#8aa396", strokeWidth: 1.8 },
        reconnectable: true,
        interactionWidth: 28,
      }}
      connectionLineStyle={{ stroke: "#217346", strokeWidth: 2 }}
    >
      <Background gap={18} size={1.2} color="#c0c0c0" bgColor="#ffffff" />
      <FlowIssueSummary sources={sources} steps={steps} />
      <FlowZoomToolbar
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
      />
      <FlowSelectionBar
        nodes={nodes}
        onRemoveSteps={onRemoveSteps}
        onRemovePromptFields={onRemovePromptFields}
        onRemoveSources={onRemoveSources}
        onDuplicateSelection={onDuplicateSelection}
      />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) =>
          n.type === "source"
            ? "#9bb5a8"
            : n.type === "field"
              ? "#d97706"
              : opAccent(
                  ((n.data as FlowNodeData).step?.operation.type ??
                    "filter") as Step["operation"]["type"],
                )
        }
      />
    </ReactFlow>
    </div>
  );
}
