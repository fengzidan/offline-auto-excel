import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  copyScheme,
  deleteScheme,
  executePipeline,
  executeSchemeInFolder,
  exportFormulaTemplate,
  exportPipelineFile,
  importScheme,
  listSchemes,
  loadScheme,
  loadSchemeDraft,
  hasSchemeDraft,
  clearSchemeDraft,
  peekRawSheet,
  previewSourceTable,
  previewStep,
  saveScheme,
  saveSchemeDraft,
  scanSourceDir,
  syncFolderContextMenu,
  takePendingFolderRun,
} from "./api";
import {
  createEmptyPipeline,
  createGuideDemoPipeline,
  GUIDE_DEMO_SCHEME_ID,
  createNicheDemoSteps,
  createStep,
  normalizePipeline,
  normalizePipelineWithMeta,
  syncOutputSheets,
  syncPipelineFromOutputStep,
  syncPipelineFromStartStep,
  type ExecuteResult,
  type FilterOp,
  type Operation,
  type OutputSheetRef,
  type Pipeline,
  type PreviewData,
  type PromptField,
  type RawSheetPreview,
  type SchemeSummary,
  type SideBlock,
  type SourceTable,
  type Step,
  newId,
} from "./types";
import { StepsFlowchart, type FlowPlacementApi, beginStepDrag, endStepDrag } from "./StepsFlowchart";
import { applyFlowLink, applyFlowUnlink, opAccent, syncIncomingEdgesForStep, syncAllIncomingEdges, syncStartSourceEdges, edgeSourceNodeId, stepInputIds, flowEdgesEqual, flowPositionsEqual, defaultStartPos, defaultSourcePos, FLOW_LAYOUT, findFreeFlowPosition } from "./flowOps";
import {
  applySourceMatchers,
  upsertSourceMatcher,
  ensureSourceMatchers,
  defaultSourceKeyword,
  matchersEqual,
  canvasSourceIds,
  sourceIdentityKeys,
} from "./sourceMatch";
import {
  buildImportSetupState,
  collectImportWarnings,
  importSetupBlockingReasons,
  importSetupIsReady,
  refreshImportSetupMatch,
  type ImportSetupState,
} from "./importValidation";
import {
  applyPromptFieldLink,
  applyPromptFieldUnlink,
  collectRuntimePromptFields,
  promptFieldNodeId,
  promptPlaceholder,
  renamePromptKeyInOp,
  syncPromptFieldsFromSteps,
  validateRuntimeParams,
} from "./runtimeParams";
import { prunePipelineForExport } from "./pipelineExport";
import "./App.css";

const STEP_PALETTE: {
  type: Operation["type"];
  label: string;
  tip: string;
}[] = [
  { type: "filter", label: "筛选", tip: "留下符合条件的数据，如某机构、某月份" },
  { type: "pivot", label: "透视", tip: "按机构/人员等汇总金额或笔数" },
  { type: "calculate", label: "计算", tip: "新增业务列，如差额、是否超编" },
  { type: "sort", label: "排序", tip: "按保费、姓名等排先后" },
  {
    type: "dedupe",
    label: "列数据去重",
    tip: "同一人/同一单只留一条",
  },
  { type: "sideBySide", label: "拼版", tip: "多张表拼到同一张结果表里对照" },
  {
    type: "vlookup",
    label: "表对表",
    tip: "主表补信息，如人员清单补岗位",
  },
  {
    type: "fullJoin",
    label: "全量对表",
    tip: "两边名单都保留，方便对差异",
  },
  {
    type: "output",
    label: "输出",
    tip: "汇总成最终 Excel（每方案一个）",
  },
];

/** 可拖入画布的步骤（开始/输出唯一且常驻，不出现在此列表） */
const ADDABLE_STEP_PALETTE = STEP_PALETTE.filter(
  (item) => item.type !== "output" && item.type !== "start",
);
function isFolderSource(t: SourceTable) {
  return t.kind === "folder";
}

const PIPELINE_HISTORY_MAX = 40;

function clonePipeline(p: Pipeline): Pipeline {
  return structuredClone(p);
}

/** Persist header-row picks under path / matcher id / keyword / filename for export & reuse. */
function mergeHeaderRowsFromSources(
  headerRows: Record<string, number> | undefined,
  sources: SourceTable[],
): Record<string, number> {
  const next: Record<string, number> = { ...(headerRows ?? {}) };
  for (const t of sources) {
    if (!t.headerOk || !(t.headerRow > 0)) continue;
    const row = t.headerRow;
    if (t.path?.trim()) next[t.path] = row;
    if (t.id?.trim()) next[t.id] = row;
    const kw = t.matchKeyword?.trim();
    if (kw) next[kw] = row;
    const base = (t.path || t.matchedName || t.name || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();
    if (base) {
      next[base] = row;
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem) {
        next[stem] = row;
        if (!stem.startsWith("src:")) next[`src:${stem}`] = row;
      }
    }
  }
  return next;
}

function headerRowEntriesForTable(
  table: SourceTable,
  row: number,
): Record<string, number> {
  const entries: Record<string, number> = {};
  if (table.path?.trim()) entries[table.path] = row;
  if (table.id?.trim()) entries[table.id] = row;
  const kw = table.matchKeyword?.trim();
  if (kw) entries[kw] = row;
  const base = (table.path || table.matchedName || table.name || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop();
  if (base) {
    entries[base] = row;
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem) {
      entries[stem] = row;
      if (!stem.startsWith("src:")) entries[`src:${stem}`] = row;
    }
  }
  return entries;
}

/** Whether another step already consumes this step's output / has an outgoing edge. */
function stepHasDownstream(
  step: Step,
  steps: Step[],
  flowEdges: { source: string; target: string }[] | undefined,
): boolean {
  if ((flowEdges ?? []).some((e) => e.source === step.id)) return true;
  const out = step.outputTableId;
  if (!out) return false;
  return steps.some(
    (s) => s.id !== step.id && stepInputIds(s.operation).includes(out),
  );
}

function guessMergeKey(headers: string[]): string {
  const preferred = [
    "业务员代码",
    "业务员编码",
    "人员代码",
    "工号",
    "代码",
    "编号",
    "ID",
    "id",
  ];
  const usable = headers.filter((h) => h && h !== "来源日期");
  for (const key of preferred) {
    if (usable.includes(key)) return key;
  }
  return usable[0] || "";
}

function headerStylePalette() {
  return [
    { bg: "#ED7D31", fg: "#fff" },
    { bg: "#5B9BD5", fg: "#fff" },
    { bg: "#70AD47", fg: "#fff" },
    { bg: "#7030A0", fg: "#fff" },
    { bg: "#C45911", fg: "#fff" },
    { bg: "#00B0F0", fg: "#fff" },
    { bg: "#FFC000", fg: "#333" },
    { bg: "#A9D08E", fg: "#333" },
  ];
}

function styleForHeaderGroups(
  groups: number[] | undefined,
  colIndex: number,
): { background: string; color: string } | undefined {
  if (!groups || groups.length === 0) {
    // 与源表 Excel 默认表头一致：橙色
    return { background: "#ED7D31", color: "#fff" };
  }
  const palette = headerStylePalette();
  const useGroups = groups.some((g) => g !== groups[0]);
  if (!useGroups) {
    return { background: "#ED7D31", color: "#fff" };
  }
  const groupOrder: number[] = [];
  for (const g of groups) {
    if (!groupOrder.includes(g)) groupOrder.push(g);
  }
  const g = groups[colIndex] ?? 0;
  const idx = Math.max(0, groupOrder.indexOf(g));
  const c = palette[idx % palette.length];
  return { background: c.bg, color: c.fg };
}

function FlowPaletteStepsHelp() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function place() {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 16);
      let left = r.left;
      if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8);
      }
      setPos({
        top: Math.min(r.bottom + 6, window.innerHeight - 24),
        left,
      });
    }

    place();

    function isInside(t: EventTarget | null) {
      if (!(t instanceof Node)) return false;
      return (
        !!wrapRef.current?.contains(t) || !!popoverRef.current?.contains(t)
      );
    }

    function onOutside(e: Event) {
      if (isInside(e.target)) return;
      setOpen(false);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    // 捕获阶段：画布等会 stopPropagation，冒泡听不到
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <div className="flow-palette-help-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`flow-palette-help-btn${open ? " is-open" : ""}`}
        title="步骤说明"
        aria-label="步骤说明"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="flow-palette-help-popover"
            role="dialog"
            aria-label="步骤说明"
            style={{ top: pos.top, left: pos.left }}
          >
            <strong>说明</strong>
            <ul>
              <li>
                <b>开始</b>
                ：指定本次要用的源表文件夹，并确认各表表头。表认准后会出现在画布上；文件找不到时节点会标红，需手动处理。
              </li>
              <li>
                <b>初始数据</b>
                ：每次跑报表可能不同的参数，如月份、机构。在筛选或计算里写{" "}
                <code>${"{月份}"}</code>
                ，点生成时再填本次要用的值。
              </li>
              <li>
                <b>筛选</b>
                ：只留下符合业务条件的数据，例如某机构、某状态；多个条件可用「且 / 或」组合。
              </li>
              <li>
                <b>透视</b>
                ：按机构、人员等维度汇总金额、笔数，做成汇总表。
              </li>
              <li>
                <b>计算</b>
                ：新增业务列，例如差额、是否达标、拼接字段；写法接近日常 Excel 公式。
              </li>
              <li>
                <b>排序</b>
                ：按保费、姓名等排先后，可设多级排序。
              </li>
              <li>
                <b>列数据去重</b>
                ：同一人、同一单号等重复记录只留最先出现的一条。
              </li>
              <li>
                <b>拼版</b>
                ：把多张结果表排到同一张 Excel 里对照查看，格子可拖拽对调。
              </li>
              <li>
                <b>表对表</b>
                ：以主表为准，从另一张表补字段（如人员补岗位）；另一张表多出来的行不会带入。
              </li>
              <li>
                <b>全量对表</b>
                ：两边名单都保留，方便找出「这边有、那边没有」的差异。
              </li>
              <li>
                <b>输出</b>
                ：把要导出的结果汇总成最终 Excel。在步骤上勾选「输出为
                Sheet」即可纳入；可在输出节点改 Sheet 名和顺序。
              </li>
              <li>
                把步骤点选或拖到画布上；单击选中，双击打开配置。
              </li>
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

type GuideModalKind = "none" | "start" | "prompt" | "filter" | "output";

type GuideTourStep = {
  /** CSS selectors; precise=true 时只高亮第一个命中的元素 */
  targets: string[];
  title: string;
  body: string;
  precise?: boolean;
  /** 进入该步时自动打开的配置弹窗 */
  modal?: GuideModalKind;
};

const GUIDE_TOUR_STEPS: GuideTourStep[] = [
  {
    targets: [
      '[data-guide="scheme-guide-demo"]',
      '[data-guide="btn-new-scheme"]',
    ],
    title: "方案从这里开始",
    body: "左侧是方案列表。已为你打开「入门示例」。也可以点「新建方案」自己建流程。",
    precise: true,
    modal: "none",
  },
  {
    targets: ['[data-guide="modal-start"]', '[data-guide="node-start"]'],
    title: "配置「开始」",
    body: "已打开开始配置。在这里选择源表文件夹，系统会扫描 Excel；再确认每张表的表头在第几行。表认准后会出现在画布上。",
    precise: true,
    modal: "start",
  },
  {
    targets: ['[data-guide="modal-prompt"]', '[data-guide="btn-add-prompt"]'],
    title: "配置初始数据",
    body: "已打开「月份」配置。名称会出现在流程引用里（如 ${月份}）；常用值可预填；勾选「每次生成都要填」后，点生成时会提醒填写。",
    precise: true,
    modal: "prompt",
  },
  {
    targets: ['[data-guide="palette-filter"]'],
    title: "添加加工步骤",
    body: "从这里点选或拖「筛选」等到画布。示例里已经放好一个筛选步骤，还可继续加透视、计算等。",
    precise: true,
    modal: "none",
  },
  {
    targets: ['[data-guide="modal-step"]', '[data-guide="node-filter"]'],
    title: "配置筛选步骤",
    body: "已打开筛选配置。选择上游表、设置筛选条件（可用 ${月份}）；需要导出时勾选「输出为 Sheet」。右侧可预览结果。",
    precise: true,
    modal: "filter",
  },
  {
    targets: ['[data-guide="modal-output"]', '[data-guide="node-output"]'],
    title: "配置输出",
    body: "已打开输出配置。可调整要导出的 Sheet、改名和顺序，并指定结果保存文件夹。",
    precise: true,
    modal: "output",
  },
  {
    targets: ['[data-guide="btn-generate"]'],
    title: "生成结果",
    body: "配置好后点「生成」。若有初始数据，会先弹出填写框（如月份）。源表文件夹选好后即可真正出表。",
    precise: true,
    modal: "none",
  },
];

function GuideTour({
  stepIndex,
  onStepChange,
  onClose,
  onPrepareStep,
}: {
  stepIndex: number;
  onStepChange: (index: number) => void;
  onClose: () => void;
  /** 换步前打开对应弹窗；返回后需再测一次高亮 */
  onPrepareStep?: (index: number) => void;
}) {
  const [hole, setHole] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const tipRef = useRef<HTMLDivElement | null>(null);
  const holeRef = useRef(hole);
  holeRef.current = hole;
  const tipPosRef = useRef(tipPos);
  tipPosRef.current = tipPos;
  const step = GUIDE_TOUR_STEPS[stepIndex];
  const total = GUIDE_TOUR_STEPS.length;

  const measure = useCallback(() => {
    if (!step) return;
    const hits: DOMRect[] = [];
    for (const sel of step.targets) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (step.precise) {
        (el as HTMLElement).scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
        r = el.getBoundingClientRect();
      }
      hits.push(r);
      if (step.precise) break;
    }

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of hits) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    const found = hits.length > 0;

    const pad = step.precise ? 6 : 8;
    const nextHole = found
      ? {
          top: Math.max(8, top - pad),
          left: Math.max(8, left - pad),
          width: Math.min(window.innerWidth - 16, right - left + pad * 2),
          height: Math.min(window.innerHeight - 16, bottom - top + pad * 2),
        }
      : null;

    const tipW = tipRef.current?.offsetWidth ?? 320;
    const tipH = tipRef.current?.offsetHeight ?? 180;
    const gap = 12;
    let tipTop: number;
    let tipLeft: number;
    if (nextHole) {
      // 弹窗较大时，说明放在弹窗右侧或下方空白处
      tipTop = nextHole.top + 16;
      tipLeft = nextHole.left + nextHole.width + gap;
      if (tipLeft + tipW > window.innerWidth - 12) {
        tipLeft = Math.max(12, nextHole.left);
        tipTop = nextHole.top + nextHole.height + gap;
      }
      if (tipTop + tipH > window.innerHeight - 12) {
        tipTop = Math.max(12, window.innerHeight - tipH - 12);
      }
    } else {
      tipTop = Math.max(24, window.innerHeight / 2 - tipH / 2);
      tipLeft = Math.max(24, window.innerWidth / 2 - tipW / 2);
    }
    if (tipLeft + tipW > window.innerWidth - 12) {
      tipLeft = Math.max(12, window.innerWidth - tipW - 12);
    }
    if (tipLeft < 12) tipLeft = 12;

    const prevHole = holeRef.current;
    const holeChanged =
      (!!nextHole !== !!prevHole) ||
      (!!nextHole &&
        !!prevHole &&
        (Math.abs(nextHole.top - prevHole.top) > 0.5 ||
          Math.abs(nextHole.left - prevHole.left) > 0.5 ||
          Math.abs(nextHole.width - prevHole.width) > 0.5 ||
          Math.abs(nextHole.height - prevHole.height) > 0.5));
    if (holeChanged) setHole(nextHole);

    const prevTip = tipPosRef.current;
    if (
      !prevTip ||
      Math.abs(prevTip.top - tipTop) > 0.5 ||
      Math.abs(prevTip.left - tipLeft) > 0.5
    ) {
      setTipPos({ top: tipTop, left: tipLeft });
    }
  }, [step]);

  useLayoutEffect(() => {
    onPrepareStep?.(stepIndex);
  }, [stepIndex, onPrepareStep]);

  useLayoutEffect(() => {
    measure();
    const timers = [50, 160, 320].map((ms) => window.setTimeout(measure, ms));
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [measure, stepIndex]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (stepIndex < total - 1) onStepChange(stepIndex + 1);
        else onClose();
      }
      if (e.key === "ArrowLeft" && stepIndex > 0) {
        onStepChange(stepIndex - 1);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, onStepChange, stepIndex, total]);

  if (!step) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const masks = hole
    ? [
        { top: 0, left: 0, width: vw, height: hole.top },
        {
          top: hole.top,
          left: 0,
          width: hole.left,
          height: hole.height,
        },
        {
          top: hole.top,
          left: hole.left + hole.width,
          width: Math.max(0, vw - hole.left - hole.width),
          height: hole.height,
        },
        {
          top: hole.top + hole.height,
          left: 0,
          width: vw,
          height: Math.max(0, vh - hole.top - hole.height),
        },
      ]
    : [{ top: 0, left: 0, width: vw, height: vh }];

  return createPortal(
    <div className="guide-tour" role="dialog" aria-modal="true" aria-label="操作指引">
      <div className="guide-tour-masks" aria-hidden>
        {masks.map((m, i) => (
          <div
            key={i}
            className="guide-tour-mask-piece"
            style={{
              top: m.top,
              left: m.left,
              width: m.width,
              height: m.height,
            }}
            onClick={onClose}
          />
        ))}
      </div>
      {hole && (
        <div
          className="guide-tour-ring"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
          }}
        />
      )}
      <div
        ref={tipRef}
        className="guide-tour-tip"
        style={
          tipPos
            ? { top: tipPos.top, left: tipPos.left }
            : { top: "30%", left: "50%", transform: "translateX(-50%)" }
        }
      >
        <div className="guide-tour-tip-head">
          <strong>{step.title}</strong>
          <span className="guide-tour-progress">
            {stepIndex + 1} / {total}
          </span>
        </div>
        <p>{step.body}</p>
        <div className="guide-tour-actions">
          <button type="button" className="ghost" onClick={onClose}>
            跳过
          </button>
          <div className="guide-tour-actions-end">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => onStepChange(stepIndex - 1)}
              >
                上一步
              </button>
            )}
            {stepIndex < total - 1 ? (
              <button
                type="button"
                className="primary"
                onClick={() => onStepChange(stepIndex + 1)}
              >
                下一步
              </button>
            ) : (
              <button type="button" className="primary" onClick={onClose}>
                完成
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PreviewTable({ data }: { data: PreviewData | null }) {
  if (!data) return <div className="muted pad-sm">暂无预览</div>;
  const groups = data.headerGroups ?? [];
  const bands = data.headerBands ?? [];
  const bandAt = (sheetRow: number, col: number) => {
    for (const b of bands) {
      if (
        b.row === sheetRow &&
        col >= b.col &&
        col < b.col + b.groups.length
      ) {
        return styleForHeaderGroups(b.groups, col - b.col);
      }
    }
    return undefined;
  };

  return (
    <div className="preview-wrap">
      <div className="muted">
        共 {data.totalRows} 行，预览前 {data.rows.length} 行
        {bands.length || groups.length ? " · 表头分色" : ""}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {data.headers.map((h, i) => (
                <th
                  key={`${h}-${i}`}
                  style={
                    bandAt(0, i) ??
                    styleForHeaderGroups(
                      groups.length === data.headers.length ? groups : undefined,
                      i,
                    )
                  }
                >
                  {h || "(空列)"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, ri) => (
              <tr key={ri}>
                {data.headers.map((_, ci) => {
                  const sheetRow = ri + 1;
                  const headerStyle = bandAt(sheetRow, ci);
                  return (
                    <td
                      key={ci}
                      style={
                        headerStyle
                          ? {
                              ...headerStyle,
                              fontWeight: 600,
                            }
                          : undefined
                      }
                    >
                      {row[ci] ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function App() {
  const [schemes, setSchemes] = useState<SchemeSummary[]>([]);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const pipelineRef = useRef<Pipeline | null>(null);
  pipelineRef.current = pipeline;
  const undoStackRef = useRef<Pipeline[]>([]);
  const redoStackRef = useRef<Pipeline[]>([]);
  const historyCoalesceRef = useRef<{ timer: number | null; open: boolean }>({
    timer: null,
    open: false,
  });
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [sources, setSources] = useState<SourceTable[]>([]);
  const [sourceModalId, setSourceModalId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [startSourceTabId, setStartSourceTabId] = useState<string | null>(null);
  const [matcherKeywordDraft, setMatcherKeywordDraft] = useState("");
  const scannedSourcesRef = useRef<SourceTable[]>([]);
  /** Snapshot before import-setup so Cancel can discard the imported scheme. */
  const importBackupRef = useRef<{
    pipeline: Pipeline | null;
    sources: SourceTable[];
    dirty: boolean;
    activeStepId: string | null;
    importedId: string;
    importedName: string;
  } | null>(null);
  const flowPlacementRef = useRef<FlowPlacementApi | null>(null);
  /** 左侧步骤指针拖入画布（不依赖 HTML5 DnD） */
  const palettePointerDragRef = useRef<{
    type: Operation["type"];
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [activePromptFieldKey, setActivePromptFieldKey] = useState<string | null>(
    null,
  );
  const [editingStepName, setEditingStepName] = useState(false);
  const [stepNameDraft, setStepNameDraft] = useState("");
  const [flowFullscreen, setFlowFullscreen] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<PreviewData | null>(null);
  const [stepPreview, setStepPreview] = useState<PreviewData | null>(null);
  const [rawPreview, setRawPreview] = useState<RawSheetPreview | null>(null);
  const [mappingTableId, setMappingTableId] = useState<string | null>(null);
  const [pickedHeaderRow, setPickedHeaderRow] = useState(1);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    id: string;
  } | null>(null);
  const [dialog, setDialog] = useState<
    | { type: "new" }
    | { type: "delete"; id: string; name: string }
    | { type: "delete-prompt-fields"; keys: string[]; labels: string[] }
    | { type: "unsaved"; nextId: string }
    | { type: "recover-draft"; schemeId: string; name: string }
    | { type: "folder-run"; folder: string }
    | {
        type: "runtime-params";
        pending:
          | { kind: "execute" }
          | { kind: "folder"; schemeId: string; folder: string };
        fields: PromptField[];
      }
    | { type: "next-step"; fromStepId: string; fromName: string }
    | { type: "import-setup"; setup: ImportSetupState }
    | null
  >(null);
  const [guideStep, setGuideStep] = useState<number | null>(null);
  const [dialogInput, setDialogInput] = useState("未命名方案");
  const [runtimeParamDraft, setRuntimeParamDraft] = useState<
    Record<string, string>
  >({});
  const [status, setStatus] = useState("就绪");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const autosaveInflightRef = useRef(false);
  const [execHighlight, setExecHighlight] = useState<{
    currentId: string | null;
    doneIds: string[];
  } | null>(null);
  const execHighlightClearRef = useRef<number | null>(null);
  const [headerCache, setHeaderCache] = useState<Record<string, string[]>>({});
  const [headerGroupsCache, setHeaderGroupsCache] = useState<
    Record<string, number[]>
  >({});
  const [headersLoading, setHeadersLoading] = useState<Record<string, boolean>>(
    {},
  );
  const headerCacheRef = useRef(headerCache);
  headerCacheRef.current = headerCache;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const ensureHeadersInflight = useRef(new Map<string, Promise<void>>());

  function rememberHeaders(
    tableId: string,
    headers: string[],
    headerGroups?: number[],
  ) {
    setHeaderCache((prev) => ({ ...prev, [tableId]: headers }));
    if (headerGroups && headerGroups.length) {
      setHeaderGroupsCache((prev) => ({ ...prev, [tableId]: headerGroups }));
    }
  }

  /** 临时表无缓存表头时静默跑一步预览补列（不打断配置 UI） */
  const ensureTableHeaders = useCallback(async (tableId: string) => {
    const tid = tableId.trim();
    if (!tid) return;
    if ((headerCacheRef.current[tid] ?? []).length > 0) return;
    const src = sourcesRef.current.find((s) => s.id === tid);
    if (src?.headers?.length) {
      rememberHeaders(tid, src.headers);
      return;
    }
    const pipe = pipelineRef.current;
    if (!pipe) return;
    const producer = pipe.steps.find((s) => s.outputTableId === tid);
    if (!producer) return;

    const existing = ensureHeadersInflight.current.get(tid);
    if (existing) return existing;

    const job = (async () => {
      setHeadersLoading((prev) => ({ ...prev, [tid]: true }));
      try {
        const data = await previewStep(pipe, producer.id, 8);
        rememberHeaders(tid, data.headers, data.headerGroups);
      } catch {
        // 静默失败：列选择保持为空即可
      } finally {
        ensureHeadersInflight.current.delete(tid);
        setHeadersLoading((prev) => {
          const next = { ...prev };
          delete next[tid];
          return next;
        });
      }
    })();
    ensureHeadersInflight.current.set(tid, job);
    return job;
  }, []);
  const [lastExport, setLastExport] = useState<ExecuteResult | null>(null);
  const statusClearTimer = useRef<number | null>(null);
  const exportClearTimer = useRef<number | null>(null);

  const activeStep = useMemo(
    () => pipeline?.steps.find((s) => s.id === activeStepId) ?? null,
    [pipeline, activeStepId],
  );

  useEffect(() => {
    setEditingStepName(false);
    setStepNameDraft(activeStep?.name ?? "");
  }, [activeStepId, activeStep?.name]);

  useEffect(() => {
    if (activeStep?.operation.type !== "start") return;
    if (sources.length === 0) {
      setStartSourceTabId(null);
      return;
    }
    const stillValid =
      startSourceTabId && sources.some((s) => s.id === startSourceTabId);
    if (stillValid) return;
    const need = sources.find((s) => !s.headerOk);
    void activateStartSourceTab((need ?? sources[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStepId, activeStep?.operation.type, sources]);

  function beginEditStepName() {
    if (!activeStep) return;
    if (
      activeStep.operation.type === "start" ||
      activeStep.operation.type === "output"
    ) {
      return;
    }
    setStepNameDraft(activeStep.name);
    setEditingStepName(true);
  }

  function commitStepName() {
    if (!activeStep) return;
    if (
      activeStep.operation.type === "start" ||
      activeStep.operation.type === "output"
    ) {
      setEditingStepName(false);
      return;
    }
    const name = stepNameDraft.trim() || activeStep.name;
    updateStep(activeStep.id, (s) => ({
      ...s,
      name,
      result: s.result?.enabled
        ? { ...s.result, sheetName: s.result.sheetName || name }
        : s.result,
    }));
    setEditingStepName(false);
  }

  const activeSource = useMemo(() => {
    const id = sourceModalId ?? activeSourceId;
    return sources.find((s) => s.id === id) ?? null;
  }, [sources, sourceModalId, activeSourceId]);

  const tableOptions = useMemo(() => {
    if (!pipeline) return [];
    const src = sources.map((s) => ({
      id: s.id,
      label: `${s.name}${s.headerOk ? "" : "（需表头）"}`,
      headers: s.headers,
    }));
    const temps = pipeline.steps.map((s) => ({
      id: s.outputTableId,
      label: `${s.name}（临时）`,
      headers: [] as string[],
    }));
    return [...src, ...temps];
  }, [sources, pipeline]);

  const tableLabel = useCallback(
    (id: string) => tableOptions.find((t) => t.id === id)?.label ?? id,
    [tableOptions],
  );

  const refreshSchemeList = useCallback(async () => {
    try {
      setSchemes(await listSchemes());
      try {
        await syncFolderContextMenu();
      } catch {
        /* shell menu sync is best-effort */
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refreshSchemeList();
  }, [refreshSchemeList]);

  // 有修改时尽快写入草稿，异常退出后可恢复
  useEffect(() => {
    if (!dirty || !pipeline?.id.trim()) return;
    const timer = window.setTimeout(() => {
      const current = pipelineRef.current;
      if (!current?.id.trim() || !dirtyRef.current) return;
      flowPlacementRef.current?.flushPositions();
      void saveSchemeDraft(pipelineRef.current ?? current).catch(() => {});
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, pipeline]);

  // 每 5 秒自动保存到正式方案
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!dirtyRef.current || !pipelineRef.current || busyRef.current) return;
      void persistCurrentScheme({ quiet: true });
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切到后台 / 关闭前再落一次草稿
  useEffect(() => {
    const flushDraft = () => {
      const current = pipelineRef.current;
      if (!dirtyRef.current || !current?.id.trim()) return;
      flowPlacementRef.current?.flushPositions();
      void saveSchemeDraft(pipelineRef.current ?? current).catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("beforeunload", flushDraft);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", flushDraft);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  async function alertError(title: string, body: string) {
    try {
      await message(body, { title, kind: "error" });
    } catch {
      window.alert(`${title}\n${body}`);
    }
  }

  function playSuccessDing() {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const beep = (freq: number, start: number, dur: number, gain = 0.08) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + start);
        g.gain.exponentialRampToValueAtTime(gain, now + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + dur + 0.02);
      };
      beep(880, 0, 0.12);
      beep(1320, 0.12, 0.16);
      window.setTimeout(() => void ctx.close(), 500);
    } catch {
      /* ignore audio failures */
    }
  }

  function clearSuccessTimers() {
    if (statusClearTimer.current != null) {
      window.clearTimeout(statusClearTimer.current);
      statusClearTimer.current = null;
    }
    if (exportClearTimer.current != null) {
      window.clearTimeout(exportClearTimer.current);
      exportClearTimer.current = null;
    }
  }

  function showExportSuccess(result: ExecuteResult, statusText?: string) {
    clearSuccessTimers();
    setLastExport(result);
    setStatus(statusText || result.message || "执行完成");
    playSuccessDing();
    exportClearTimer.current = window.setTimeout(() => {
      setLastExport(null);
      exportClearTimer.current = null;
    }, 5000);
    statusClearTimer.current = window.setTimeout(() => {
      setStatus((prev) =>
        prev === (statusText || result.message || "执行完成") ? "就绪" : prev,
      );
      statusClearTimer.current = null;
    }, 5000);
  }

  useEffect(() => {
    return () => clearSuccessTimers();
  }, []);

  useEffect(() => {
    if (
      guideStep != null ||
      (!activeStepId &&
        !activePromptFieldKey &&
        !flowFullscreen &&
        !sourceModalId &&
        dialog?.type !== "next-step")
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (guideStep != null) return;
        if (editingStepName) return;
        if (dialog?.type === "next-step") {
          setDialog(null);
          return;
        }
        if (activeStepId) {
          requestCloseStepModal();
          return;
        }
        if (activePromptFieldKey) {
          setActivePromptFieldKey(null);
          return;
        }
        if (sourceModalId) {
          closeSourceModal();
          return;
        }
        if (flowFullscreen) setFlowFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    guideStep,
    activeStepId,
    activePromptFieldKey,
    flowFullscreen,
    sourceModalId,
    pipeline,
    busy,
    editingStepName,
    dialog,
  ]);

  function commitPromptFieldsFromSteps() {
    updatePipeline(
      (p) => {
        let next = syncPromptFieldsFromSteps(p);
        next = {
          ...next,
          flowEdges: syncAllIncomingEdges(
            next.flowEdges,
            next.steps,
            next.promptFields,
          ),
        };
        return next;
      },
      { history: false },
    );
  }

  function requestCloseStepModal() {
    if (!pipeline || !activeStepId) {
      setActiveStepId(null);
      setStepPreview(null);
      return;
    }
    const stepId = activeStepId;
    const step = pipeline.steps.find((s) => s.id === stepId);
    // 关闭/离开步骤时再根据 ${显示名} 新建初始数据节点并连线
    commitPromptFieldsFromSteps();
    setActiveStepId(null);
    setStepPreview(null);
    setEditingStepName(false);
    const latest = pipelineRef.current;
    const closed = latest?.steps.find((s) => s.id === stepId) ?? step;
    if (!closed) return;
    // 已是结果表 / 输出节点，或已有下游：不再询问下一步
    if (closed.operation.type === "output" || closed.operation.type === "start")
      return;
    if (closed.result?.enabled) return;
    if (
      latest &&
      stepHasDownstream(closed, latest.steps, latest.flowEdges)
    )
      return;
    setDialog({
      type: "next-step",
      fromStepId: closed.id,
      fromName: closed.name,
    });
  }

  function updateStep(id: string, updater: (s: Step) => Step) {
    updatePipeline((p) => {
      const steps = p.steps.map((s) => (s.id === id ? updater(s) : s));
      // 编辑中不新建初始数据；仅同步已有初始数据的连线与表输入
      const flowEdges = syncIncomingEdgesForStep(
        p.flowEdges,
        steps,
        id,
        p.promptFields,
      );
      const next = { ...p, steps, flowEdges };
      return syncPipelineFromStartStep(syncPipelineFromOutputStep(next));
    });
  }

  function addNextStepFrom(fromStepId: string, type: Operation["type"]) {
    if (!pipeline) return;
    const from = pipeline.steps.find((s) => s.id === fromStepId);
    if (!from?.outputTableId) return;
    if (type === "output") {
      const existing = pipeline.steps.find((s) => s.operation.type === "output");
      if (existing) {
        linkStepInput(from.outputTableId, existing.id, from.id);
        setDialog(null);
        setActiveStepId(existing.id);
        return;
      }
    }
    if (type === "start") {
      const existing = pipeline.steps.find((s) => s.operation.type === "start");
      if (existing) {
        setDialog(null);
        setActiveStepId(existing.id);
        return;
      }
    }
    let step = createStep(type, from.outputTableId);
    step = {
      ...step,
      operation: applyFlowLink(step.operation, from.outputTableId),
    };
    const fromPos = pipeline.flowPositions?.[from.id];
    const preferred = fromPos
      ? { x: fromPos.x, y: fromPos.y + FLOW_LAYOUT.stepGapY }
      : (flowPlacementRef.current?.viewportCenter() ?? defaultStartPos());
    const place = findFreeFlowPosition(preferred, pipeline.flowPositions);
    updatePipeline((p) => {
      const steps = [...p.steps, step];
      return syncPipelineFromStartStep(syncPipelineFromOutputStep({
        ...p,
        steps,
        flowPositions: place
          ? { ...(p.flowPositions ?? {}), [step.id]: place }
          : p.flowPositions,
        flowEdges: syncIncomingEdgesForStep(p.flowEdges, steps, step.id),
      }));
    });
    setDialog(null);
    setActiveStepId(step.id);
  }

  useEffect(() => {
    if (!flowFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [flowFullscreen]);

  function openFolderRunPicker(folder: string) {
    setDialog({ type: "folder-run", folder });
    setCtxMenu(null);
  }

  function handleFolderRunRequest(req: {
    folder: string;
    schemeId?: string | null;
  }) {
    if (req.schemeId) {
      void beginRunSchemeInFolder(req.schemeId, req.folder);
      return;
    }
    openFolderRunPicker(req.folder);
  }

  function openRuntimeParamsDialog(
    pending:
      | { kind: "execute" }
      | { kind: "folder"; schemeId: string; folder: string },
    fields: PromptField[],
  ) {
    setRuntimeParamDraft(
      Object.fromEntries(
        fields.map((f) => [f.key, f.defaultValue ?? ""]),
      ),
    );
    setDialog({ type: "runtime-params", pending, fields });
  }

  async function beginRunSchemeInFolder(schemeId: string, folder: string) {
    setError(null);
    try {
      const scheme = normalizePipeline(await loadScheme(schemeId));
      const fields = collectRuntimePromptFields(scheme);
      if (fields.length) {
        openRuntimeParamsDialog({ kind: "folder", schemeId, folder }, fields);
        return;
      }
      await runSchemeInFolder(schemeId, folder, {});
    } catch (e) {
      const msg = String(e);
      setError(msg);
      await alertError("执行失败", msg);
    }
  }

  async function runSchemeInFolder(
    schemeId: string,
    folder: string,
    runtimeParams: Record<string, string>,
  ) {
    setBusy(true);
    setError(null);
    setDialog(null);
    const watching = pipeline?.id === schemeId;
    if (watching) {
      setActiveStepId(null);
      setStepPreview(null);
      if (execHighlightClearRef.current != null) {
        window.clearTimeout(execHighlightClearRef.current);
        execHighlightClearRef.current = null;
      }
      setExecHighlight({ currentId: null, doneIds: [] });
    }
    try {
      const result = await executeSchemeInFolder(
        schemeId,
        folder,
        runtimeParams,
      );
      showExportSuccess(result, result.message || "文件夹执行完成");
      await refreshSchemeList();
      // If this scheme is open in the UI, reload so source/output dirs match disk
      if (pipeline?.id === schemeId) {
        const loaded = normalizePipeline(await loadScheme(schemeId));
        if (!loaded.headerRows) loaded.headerRows = {};
        if (!loaded.outputSheets) loaded.outputSheets = [];
        if (!loaded.folderMerges) loaded.folderMerges = {};
        loaded.outputSheets = syncOutputSheets(loaded);
        setPipeline(loaded);
        clearPipelineHistory();
        setDirty(false);
      }
      if (watching) clearExecHighlightSoon();
    } catch (e) {
      const msg = String(e);
      setError(msg);
      if (watching) setExecHighlight(null);
      await alertError("执行失败", msg);
    } finally {
      setBusy(false);
    }
  }

  function confirmRuntimeParams() {
    if (!dialog || dialog.type !== "runtime-params") return;
    const err = validateRuntimeParams(dialog.fields, runtimeParamDraft);
    if (err) {
      setError(err);
      return;
    }
    const params = { ...runtimeParamDraft };
    const pending = dialog.pending;
    setDialog(null);
    if (pending.kind === "execute") {
      void runExecute(params);
    } else {
      void runSchemeInFolder(pending.schemeId, pending.folder, params);
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const pending = await takePendingFolderRun();
        if (pending?.folder) handleFolderRunRequest(pending);
      } catch {
        /* ignore */
      }
      unlisten = await listen<{ folder: string; schemeId?: string | null }>(
        "folder-run",
        (ev) => {
          if (ev.payload?.folder) handleFolderRunRequest(ev.payload);
        },
      );
    })();
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<{
        index: number;
        total: number;
        stepId: string;
        stepName: string;
        phase: string;
      }>("execute-progress", (ev) => {
        const p = ev.payload;
        if (!p?.stepId) return;
        if (p.phase === "start") {
          setStatus(`执行中 ${p.index + 1}/${p.total}：${p.stepName}`);
        }
        setExecHighlight((prev) => {
          const doneIds = [...(prev?.doneIds ?? [])];
          if (p.phase === "done") {
            if (!doneIds.includes(p.stepId)) doneIds.push(p.stepId);
            return { currentId: null, doneIds };
          }
          return { currentId: p.stepId, doneIds };
        });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  async function handleRunSchemeOnFolder(schemeId: string) {
    setCtxMenu(null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择要执行方案的文件夹",
    });
    if (!selected || Array.isArray(selected)) return;
    await beginRunSchemeInFolder(schemeId, selected);
  }

  async function refreshSources(
    p: Pipeline,
    opts?: { ensureMatchers?: boolean },
  ): Promise<SourceTable[]> {
    // 仅「刷新」显式传 true 时重新登记目录里的全部源表；
    // 方案尚无 matchers 时（首次选目录）也自动识别一次。
    const hasMatchers = (p.sourceMatchers ?? []).some((m) => m.id?.trim());
    const ensureMatchers =
      opts?.ensureMatchers !== undefined
        ? opts.ensureMatchers
        : !hasMatchers;
    if (!p.sourceDir) {
      scannedSourcesRef.current = [];
      // 无文件夹时仍保留方案已登记源表（显示为缺失），除非用户手动删除
      const stubs = applySourceMatchers([], p.sourceMatchers);
      setSources(stubs);
      setScanning(false);
      updatePipeline(
        (prev) => {
          const canvasIds = canvasSourceIds(stubs);
          const start = prev.steps.find((s) => s.operation.type === "start");
          const startPos = start
            ? (prev.flowPositions?.[start.id] ?? defaultStartPos())
            : defaultStartPos();
          const flowPositions = { ...(prev.flowPositions ?? {}) };
          stubs.forEach((t, i) => {
            if (!canvasIds.includes(t.id) || flowPositions[t.id]) return;
            flowPositions[t.id] = findFreeFlowPosition(
              defaultSourcePos(i, startPos, Math.max(canvasIds.length, 1)),
              flowPositions,
              t.id,
            );
          });
          const flowEdges = syncStartSourceEdges(
            prev.flowEdges,
            prev.steps,
            canvasIds,
          );
          if (
            flowPositionsEqual(flowPositions, prev.flowPositions) &&
            flowEdgesEqual(flowEdges, prev.flowEdges)
          ) {
            return prev;
          }
          return { ...prev, flowPositions, flowEdges };
        },
        { history: false },
      );
      return stubs;
    }
    flushSync(() => {
      setScanning(true);
      setError(null);
    });
    try {
      const scanned = await scanSourceDir(p.sourceDir, p.headerRows ?? {});
      scannedSourcesRef.current = scanned;
      let matchers = p.sourceMatchers ?? [];
      if (ensureMatchers) {
        const ensured = ensureSourceMatchers(scanned, p.sourceMatchers);
        if (!matchersEqual(p.sourceMatchers, ensured)) {
          // 自动补全关键字需落盘，否则改名后步骤引用会丢
          updatePipeline((prev) => ({ ...prev, sourceMatchers: ensured }), {
            history: false,
          });
          matchers = ensured;
        }
      }
      const tables = applySourceMatchers(scanned, matchers);
      setSources(tables);
      // 表头就绪或文件缺失的方案源表都留在画布上，并与开始节点连线
      updatePipeline(
        (prev) => {
          const start = prev.steps.find((s) => s.operation.type === "start");
          const startPos = start
            ? (prev.flowPositions?.[start.id] ?? defaultStartPos())
            : defaultStartPos();
          const flowPositions = { ...(prev.flowPositions ?? {}) };
          const canvasIds = canvasSourceIds(tables);
          tables.forEach((t, i) => {
            if (!canvasIds.includes(t.id) || flowPositions[t.id]) return;
            flowPositions[t.id] = findFreeFlowPosition(
              defaultSourcePos(i, startPos, Math.max(canvasIds.length, 1)),
              flowPositions,
              t.id,
            );
          });
          const flowEdges = syncStartSourceEdges(
            prev.flowEdges,
            prev.steps,
            canvasIds,
          );
          if (
            flowPositionsEqual(flowPositions, prev.flowPositions) &&
            flowEdgesEqual(flowEdges, prev.flowEdges)
          ) {
            return prev;
          }
          return {
            ...prev,
            flowPositions,
            flowEdges,
          };
        },
        { history: false },
      );
      setHeaderCache((prev) => {
        const next = { ...prev };
        for (const t of tables) {
          if (t.headerOk) next[t.id] = t.headers;
        }
        return next;
      });
      const merges = { ...(p.folderMerges ?? {}) };
      let mergesChanged = false;
      for (const t of tables) {
        if (!isFolderSource(t) || !t.headerOk) continue;
        if (merges[t.id]?.keyColumn) continue;
        const key = guessMergeKey(t.headers);
        if (!key) continue;
        merges[t.id] = { keyColumn: key };
        mergesChanged = true;
      }
      if (mergesChanged) {
        updatePipeline((prev) => ({ ...prev, folderMerges: merges }), {
          history: false,
        });
      }
      const need = tables.filter((t) => !t.headerOk);
      const matched = tables.filter((t) => t.matchKeyword && t.matchedName).length;
      if (need.length) {
        setStatus(
          `已扫描 ${scanned.length} 张文件，方案登记 ${matched} 张，${need.length} 张需在开始节点中指定表头后才会出现在画布`,
        );
        setActiveSourceId(need[0].id);
      } else {
        setStatus(
          matched
            ? `目录 ${scanned.length} 个文件，方案登记 ${matched} 张源表（表头已就绪）`
            : `已扫描 ${scanned.length} 个文件`,
        );
        if (!activeSourceId && tables[0]) setActiveSourceId(tables[0].id);
      }
      return tables;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      setScanning(false);
    }
  }

  const headerRowsKey = useMemo(
    () => JSON.stringify(pipeline?.headerRows ?? {}),
    [pipeline?.headerRows],
  );

  useEffect(() => {
    if (!pipeline) return;
    if (!pipeline.sourceDir?.trim()) {
      scannedSourcesRef.current = [];
      const stubs = applySourceMatchers([], pipeline.sourceMatchers);
      setSources(stubs);
      setScanning(false);
      updatePipeline(
        (prev) => {
          const canvasIds = canvasSourceIds(stubs);
          const flowEdges = syncStartSourceEdges(
            prev.flowEdges,
            prev.steps,
            canvasIds,
          );
          if (flowEdgesEqual(flowEdges, prev.flowEdges)) return prev;
          return { ...prev, flowEdges };
        },
        { history: false },
      );
      return;
    }
    // 选文件夹后立刻显示加载中，再防抖实际扫描
    setScanning(true);
    const t = setTimeout(() => void refreshSources(pipeline), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.sourceDir, headerRowsKey]);

  function saveSourceMatcherKeyword(sourceId: string, keyword: string) {
    updatePipeline((p) => {
      const sourceMatchers = upsertSourceMatcher(p.sourceMatchers, {
        id: sourceId,
        keyword,
        label: keyword.trim() || undefined,
      });
      if (matchersEqual(p.sourceMatchers, sourceMatchers)) return p;
      return { ...p, sourceMatchers };
    });
  }

  // 源表关键字随方案自动保存（源表弹窗 / 开始节点 Tab）
  useEffect(() => {
    const editingInStart =
      activeStep?.operation.type === "start" ? startSourceTabId : null;
    const id = sourceModalId ?? editingInStart;
    if (!id) return;
    const draft = matcherKeywordDraft;
    const t = window.setTimeout(() => {
      saveSourceMatcherKeyword(id, draft);
    }, 280);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sourceModalId,
    startSourceTabId,
    activeStep?.operation.type,
    matcherKeywordDraft,
  ]);

  // 仅关键字变更时，用上次扫描结果重绑，避免重复扫盘
  useEffect(() => {
    if (!pipeline?.sourceDir?.trim()) return;
    if (scannedSourcesRef.current.length === 0) return;
    setSources(
      applySourceMatchers(scannedSourcesRef.current, pipeline.sourceMatchers),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.sourceMatchers]);

  function syncHistoryCounts() {
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }

  function clearPipelineHistory() {
    if (historyCoalesceRef.current.timer != null) {
      window.clearTimeout(historyCoalesceRef.current.timer);
      historyCoalesceRef.current.timer = null;
    }
    historyCoalesceRef.current.open = false;
    undoStackRef.current = [];
    redoStackRef.current = [];
    syncHistoryCounts();
  }

  function pushUndoSnapshot(prev: Pipeline) {
    undoStackRef.current.push(clonePipeline(prev));
    if (undoStackRef.current.length > PIPELINE_HISTORY_MAX) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    syncHistoryCounts();
  }

  function updatePipeline(
    updater: (p: Pipeline) => Pipeline,
    opts?: { history?: boolean },
  ) {
    const prev = pipelineRef.current;
    if (!prev) return;
    const next = updater(prev);
    if (next === prev) return;

    if (opts?.history !== false) {
      const slot = historyCoalesceRef.current;
      if (!slot.open) {
        pushUndoSnapshot(prev);
        slot.open = true;
      }
      if (slot.timer != null) window.clearTimeout(slot.timer);
      slot.timer = window.setTimeout(() => {
        slot.open = false;
        slot.timer = null;
      }, 450);
    }

    pipelineRef.current = next;
    setPipeline(next);
    setDirty(true);
  }

  function undoPipeline() {
    const current = pipelineRef.current;
    if (!current || undoStackRef.current.length === 0) return;
    if (historyCoalesceRef.current.timer != null) {
      window.clearTimeout(historyCoalesceRef.current.timer);
      historyCoalesceRef.current.timer = null;
    }
    historyCoalesceRef.current.open = false;
    const prev = undoStackRef.current.pop()!;
    redoStackRef.current.push(clonePipeline(current));
    pipelineRef.current = prev;
    setPipeline(prev);
    setDirty(true);
    syncHistoryCounts();
    setActiveStepId((id) => {
      if (id && !prev.steps.some((s) => s.id === id)) {
        setStepPreview(null);
        return null;
      }
      return id;
    });
    setStatus("已撤回");
  }

  function redoPipeline() {
    const current = pipelineRef.current;
    if (!current || redoStackRef.current.length === 0) return;
    if (historyCoalesceRef.current.timer != null) {
      window.clearTimeout(historyCoalesceRef.current.timer);
      historyCoalesceRef.current.timer = null;
    }
    historyCoalesceRef.current.open = false;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(clonePipeline(current));
    if (undoStackRef.current.length > PIPELINE_HISTORY_MAX) {
      undoStackRef.current.shift();
    }
    pipelineRef.current = next;
    setPipeline(next);
    setDirty(true);
    syncHistoryCounts();
    setActiveStepId((id) => {
      if (id && !next.steps.some((s) => s.id === id)) {
        setStepPreview(null);
        return null;
      }
      return id;
    });
    setStatus("已重做");
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        if (pipelineRef.current && !busyRef.current) {
          void persistCurrentScheme({ force: true });
        }
        return;
      }
      if (key !== "z" && key !== "y") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoPipeline();
        return;
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redoPipeline();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  async function createSchemeWithName(name: string) {
    const p = createEmptyPipeline(name.trim() || "未命名方案");
    setBusy(true);
    setError(null);
    try {
      const saved = await saveScheme(p);
      setPipeline(saved);
      clearPipelineHistory();
      setDirty(false);
      const startId =
        saved.steps.find((s) => s.operation.type === "start")?.id ?? null;
      setActiveStepId(startId);
      setActivePromptFieldKey(null);
      setActiveSourceId(null);
      setSourcePreview(null);
      setStepPreview(null);
      setSources([]);
      setDialog(null);
      await refreshSchemeList();
      setStatus("已新建方案");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleNewScheme() {
    setDialogInput("未命名方案");
    setDialog({ type: "new" });
  }

  async function openScheme(id: string, opts?: { skipDraftCheck?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      if (!opts?.skipDraftCheck) {
        const hasDraft = await hasSchemeDraft(id).catch(() => false);
        if (hasDraft) {
          let draftName = "未命名方案";
          try {
            const saved = await loadScheme(id);
            draftName = saved.name || draftName;
          } catch {
            /* 正式文件可能不存在，仍可从草稿恢复 */
          }
          setDialog({ type: "recover-draft", schemeId: id, name: draftName });
          return;
        }
      }

      const { pipeline: loaded, createdStartId } = normalizePipelineWithMeta(
        await loadScheme(id),
      );
      await applyOpenedPipeline(loaded, createdStartId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyOpenedPipeline(
    loaded: Pipeline,
    createdStartId?: string | null,
  ) {
    if (!loaded.headerRows) loaded.headerRows = {};
    if (!loaded.outputSheets) loaded.outputSheets = [];
    if (!loaded.folderMerges) loaded.folderMerges = {};
    loaded.outputSheets = syncOutputSheets(loaded);
    let normalized = syncPromptFieldsFromSteps(loaded);
    normalized = {
      ...normalized,
      flowEdges: syncAllIncomingEdges(
        normalized.flowEdges,
        normalized.steps,
        normalized.promptFields,
      ),
    };
    const startStep = normalized.steps.find(
      (s) => s.operation.type === "start",
    );
    const startConfigured =
      !!normalized.sourceDir.trim() ||
      (startStep?.operation.type === "start" &&
        !!startStep.operation.sourceDir.trim());
    if (!startConfigured) {
      normalized = {
        ...normalized,
        flowEdges: syncStartSourceEdges(
          normalized.flowEdges,
          normalized.steps,
          [],
        ),
      };
    }
    setPipeline(normalized);
    clearPipelineHistory();
    setDirty(Boolean(createdStartId));
    setActiveStepId(createdStartId && !startConfigured ? createdStartId : null);
    setActivePromptFieldKey(null);
    setActiveSourceId(null);
    setSourceModalId(null);
    setStartSourceTabId(null);
    setSourcePreview(null);
    setStepPreview(null);
    setRawPreview(null);
    setMappingTableId(null);
    scannedSourcesRef.current = [];
    setSources([]);
    setDialog(null);
    if (startConfigured) {
      await refreshSources(normalized);
    }
    setStatus(
      createdStartId && !startConfigured
        ? `已打开「${loaded.name}」，请配置开始节点`
        : `已打开「${loaded.name}」`,
    );
  }

  async function recoverDraft(schemeId: string) {
    setBusy(true);
    setError(null);
    try {
      const draft = await loadSchemeDraft(schemeId);
      if (!draft) {
        await clearSchemeDraft(schemeId).catch(() => {});
        await openScheme(schemeId, { skipDraftCheck: true });
        return;
      }
      const { pipeline: loaded, createdStartId } =
        normalizePipelineWithMeta(draft);
      await applyOpenedPipeline(loaded, createdStartId);
      setDirty(true);
      setStatus(`已恢复「${loaded.name}」的未保存版本，将自动保存`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function discardDraftAndOpen(schemeId: string) {
    setBusy(true);
    try {
      await clearSchemeDraft(schemeId).catch(() => {});
      await openScheme(schemeId, { skipDraftCheck: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectScheme(id: string) {
    if (dirty && pipeline) {
      setDialog({ type: "unsaved", nextId: id });
      return;
    }
    await openScheme(id);
  }

  async function persistCurrentScheme(opts?: {
    quiet?: boolean;
    force?: boolean;
  }) {
    flowPlacementRef.current?.flushPositions();
    const current = pipelineRef.current;
    if (!current?.id.trim()) return false;
    if (!opts?.force && !dirtyRef.current) return false;
    if (autosaveInflightRef.current) return false;
    autosaveInflightRef.current = true;
    if (!opts?.quiet) setBusy(true);
    try {
      const withHeaders: Pipeline = {
        ...current,
        headerRows: mergeHeaderRowsFromSources(
          current.headerRows,
          sourcesRef.current,
        ),
      };
      const saved = await saveScheme(withHeaders);
      const latest = pipelineRef.current ?? withHeaders;
      const merged: Pipeline = {
        ...saved,
        headerRows: withHeaders.headerRows,
        flowPositions: latest.flowPositions ?? saved.flowPositions,
        flowEdges: latest.flowEdges ?? saved.flowEdges,
      };
      pipelineRef.current = merged;
      setPipeline(merged);
      setDirty(false);
      await clearSchemeDraft(merged.id).catch(() => {});
      void refreshSchemeList();
      setStatus(opts?.quiet ? "已自动保存" : "方案已保存");
      return true;
    } catch (e) {
      if (!opts?.quiet) setError(String(e));
      // 正式保存失败时仍尽量落草稿，便于异常退出后恢复
      try {
        await saveSchemeDraft(pipelineRef.current ?? current);
      } catch {
        /* ignore */
      }
      return false;
    } finally {
      autosaveInflightRef.current = false;
      if (!opts?.quiet) setBusy(false);
    }
  }

  async function handleSave() {
    await persistCurrentScheme({ force: true });
  }

  async function handleCopyScheme(id: string) {
    setCtxMenu(null);
    setBusy(true);
    setError(null);
    try {
      const copied = await copyScheme(id);
      await refreshSchemeList();
      setStatus(`已复制为「${copied.name}」`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function safeFileName(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "方案";
  }

  async function handleExportScheme(id: string) {
    setCtxMenu(null);
    const summary = schemes.find((s) => s.id === id);
    const name =
      pipeline?.id === id ? pipeline.name : summary?.name ?? "方案";
    const path = await save({
      filters: [{ name: "方案", extensions: ["json"] }],
      defaultPath: `${safeFileName(name)}.json`,
    });
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const raw =
        pipeline?.id === id
          ? pipeline
          : normalizePipelineWithMeta(await loadScheme(id)).pipeline;
      // 仅当前打开方案有实时源表列表，可按画布可见源表裁剪；
      // 未打开的方案只按步骤引用与开始连线保留源表配置。
      const sourcesForExport =
        pipeline?.id === id ? sourcesRef.current : null;
      const pruned = prunePipelineForExport(raw, sourcesForExport);
      const out = await exportPipelineFile(pruned, path);
      setStatus(`方案已导出：${out}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportScheme() {
    setCtxMenu(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: "方案", extensions: ["json"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setBusy(true);
    setError(null);
    try {
      const prevPipeline = pipelineRef.current
        ? clonePipeline(pipelineRef.current)
        : null;
      const prevSources = [...sourcesRef.current];
      const prevDirty = dirtyRef.current;
      const prevActiveStepId = activeStepId;
      const { pipeline: imported, createdStartId } = normalizePipelineWithMeta(
        await importScheme(selected),
      );
      await refreshSchemeList();
      let normalized = syncPromptFieldsFromSteps(imported);
      normalized = {
        ...normalized,
        flowEdges: syncAllIncomingEdges(
          normalized.flowEdges,
          normalized.steps,
          normalized.promptFields,
        ),
      };
      setPipeline(normalized);
      clearPipelineHistory();
      setDirty(Boolean(createdStartId));
      setSourcePreview(null);
      setStepPreview(null);
      const startStep = normalized.steps.find(
        (s) => s.operation.type === "start",
      );
      const startConfigured =
        !!normalized.sourceDir.trim() ||
        (startStep?.operation.type === "start" &&
          !!startStep.operation.sourceDir.trim());
      const warnings = await collectImportWarnings(normalized);
      setActivePromptFieldKey(null);
      if (warnings.length > 0) {
        importBackupRef.current = {
          pipeline: prevPipeline,
          sources: prevSources,
          dirty: prevDirty,
          activeStepId: prevActiveStepId,
          importedId: normalized.id,
          importedName: normalized.name,
        };
        setActiveStepId(null);
        let setup = buildImportSetupState(normalized, warnings);
        setup = { ...setup, scanning: true };
        setDialog({ type: "import-setup", setup });
        setup = await refreshImportSetupMatch(
          setup,
          normalized.headerRows ?? {},
        );
        setDialog({ type: "import-setup", setup });
        setStatus(`已导入「${imported.name}」，请完成路径与源表配置`);
      } else {
        importBackupRef.current = null;
        setDialog(null);
        setActiveStepId(
          createdStartId && !startConfigured ? createdStartId : null,
        );
        setStatus(
          createdStartId && !startConfigured
            ? `已导入「${imported.name}」，请配置开始节点`
            : `已导入方案「${imported.name}」`,
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelImportSetup() {
    const backup = importBackupRef.current;
    importBackupRef.current = null;
    setDialog(null);
    setError(null);
    if (!backup) return;
    setBusy(true);
    try {
      await deleteScheme(backup.importedId);
      await refreshSchemeList();
      setPipeline(backup.pipeline);
      clearPipelineHistory();
      setSources(backup.sources);
      scannedSourcesRef.current = backup.sources.filter((s) => s.path?.trim());
      setDirty(backup.dirty);
      setActiveStepId(backup.activeStepId);
      setActiveSourceId(null);
      setSourcePreview(null);
      setStepPreview(null);
      setStatus(`已取消导入「${backup.importedName}」`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function patchImportSetup(patch: Partial<ImportSetupState>) {
    setDialog((d) =>
      d?.type === "import-setup"
        ? { ...d, setup: { ...d.setup, ...patch } }
        : d,
    );
  }

  async function revalidateImportSetup(next?: ImportSetupState) {
    let cur = next ?? null;
    if (!cur) {
      setDialog((d) => {
        if (d?.type !== "import-setup") return d;
        cur = d.setup;
        return { ...d, setup: { ...d.setup, scanning: true } };
      });
    } else {
      patchImportSetup({ scanning: true });
    }
    if (!cur) return;
    const refreshed = await refreshImportSetupMatch(
      cur,
      pipeline?.headerRows ?? {},
    );
    setDialog({ type: "import-setup", setup: refreshed });
  }

  async function pickImportSetupDir(kind: "source" | "output") {
    if (dialog?.type !== "import-setup") return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    const setup = {
      ...dialog.setup,
      ...(kind === "source"
        ? { sourceDir: selected }
        : { outputDir: selected }),
    };
    setDialog({ type: "import-setup", setup: { ...setup, scanning: true } });
    await revalidateImportSetup(setup);
  }

  async function applyImportSetup(force = false) {
    if (dialog?.type !== "import-setup" || !pipeline) return;
    const setup = dialog.setup;
    if (setup.scanning) return;
    if (!force && !importSetupIsReady(setup)) {
      const reasons = importSetupBlockingReasons(setup);
      setError(reasons[0] ?? "请先完成导入配置");
      return;
    }
    const sourceDir = setup.sourceDir.trim();
    const outputDir = setup.outputDir.trim();
    const sourceMatchers = setup.matchers.map((m) => ({
      id: m.id,
      keyword: m.keyword.trim(),
      label: m.label,
    }));
    updatePipeline((p) => {
      const steps = p.steps.map((s) => {
        if (s.operation.type === "start") {
          return { ...s, operation: { ...s.operation, sourceDir } };
        }
        if (s.operation.type === "output") {
          return { ...s, operation: { ...s.operation, outputDir } };
        }
        return s;
      });
      return syncPipelineFromStartStep(
        syncPipelineFromOutputStep({
          ...p,
          steps,
          sourceDir,
          outputDir,
          sourceMatchers,
        }),
      );
    });
    importBackupRef.current = null;
    setDialog(null);
    setError(null);
    setStatus(
      force
        ? `已导入「${setup.schemeName}」（部分配置未完成，可稍后在开始/输出节点补全）`
        : `已完成「${setup.schemeName}」导入配置`,
    );
    const latest = pipelineRef.current;
    if (latest) await refreshSources(latest, { ensureMatchers: false });
  }

  function askDelete(id: string) {
    const current = schemes.find((s) => s.id === id);
    setDialog({ type: "delete", id, name: current?.name ?? "" });
    setCtxMenu(null);
  }

  async function applyDelete() {
    if (!dialog || dialog.type !== "delete") return;
    setBusy(true);
    try {
      await deleteScheme(dialog.id);
      if (pipeline?.id === dialog.id) {
        setPipeline(null);
        clearPipelineHistory();
        setSources([]);
        setSourcePreview(null);
      setStepPreview(null);
      }
      setDialog(null);
      await refreshSchemeList();
      setStatus("已删除方案");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolveUnsaved(saveFirst: boolean) {
    if (!dialog || dialog.type !== "unsaved" || !pipeline) return;
    const nextId = dialog.nextId;
    if (saveFirst) {
      const ok = await persistCurrentScheme({ force: true });
      if (!ok) return;
    } else {
      await clearSchemeDraft(pipeline.id).catch(() => {});
    }
    await openScheme(nextId);
  }

  async function pickSourceDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string" || !pipeline) return;
    flushSync(() => {
      setScanning(true);
      setSources([]);
      setStartSourceTabId(null);
      setSourcePreview(null);
      setRawPreview(null);
      setMappingTableId(null);
    });
    updatePipeline((p) => {
      const steps = p.steps.map((s) =>
        s.operation.type === "start"
          ? { ...s, operation: { ...s.operation, sourceDir: selected } }
          : s,
      );
      return syncPipelineFromStartStep({ ...p, steps, sourceDir: selected });
    });
  }

  async function pickOutputDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string" || !pipeline) return;
    updatePipeline((p) => {
      const steps = p.steps.map((s) =>
        s.operation.type === "output"
          ? { ...s, operation: { ...s.operation, outputDir: selected } }
          : s,
      );
      return syncPipelineFromOutputStep({ ...p, steps, outputDir: selected });
    });
  }

  async function openSourcePreview(table: SourceTable) {
    setActiveSourceId(table.id);
    setError(null);
    if (!table.headerOk) {
      await openHeaderMapping(table);
      return;
    }
    setMappingTableId(null);
    setRawPreview(null);
    setBusy(true);
    try {
      let keyColumn = pipeline?.folderMerges?.[table.id]?.keyColumn ?? "";
      if (isFolderSource(table) && !keyColumn) {
        keyColumn = guessMergeKey(table.headers);
        if (keyColumn) {
          updatePipeline((p) => ({
            ...p,
            folderMerges: {
              ...(p.folderMerges ?? {}),
              [table.id]: { keyColumn },
            },
          }));
        }
      }
      const data = await previewSourceTable(
        table.path,
        pipeline?.headerRows?.[table.path] ?? table.headerRow,
        40,
        {
          keyColumn,
          headerRows: pipeline?.headerRows,
        },
      );
      setSourcePreview(data);
      rememberHeaders(table.id, data.headers, data.headerGroups);
      if (isFolderSource(table)) {
        setStatus(
          `累计表「${table.name}」预览仅显示最新样本文件（共 ${table.fileCount ?? 0} 个文件；执行时全量合并）`,
        );
      }
    } catch (e) {
      setError(String(e));
      await openHeaderMapping(table);
    } finally {
      setBusy(false);
    }
  }

  async function openHeaderMapping(table: SourceTable) {
    setMappingTableId(table.id);
    setPickedHeaderRow(table.headerRow || 1);
    setBusy(true);
    try {
      const peekPath = table.samplePath || table.path;
      const raw = await peekRawSheet(peekPath, 40);
      setRawPreview(raw);
      setSourcePreview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmHeaderRow() {
    if (!pipeline || !mappingTableId) return;
    const table = sources.find((s) => s.id === mappingTableId);
    if (!table) return;
    const targetId = mappingTableId;
    const rowEntries = headerRowEntriesForTable(table, pickedHeaderRow);
    const nextRows = {
      ...pipeline.headerRows,
      ...rowEntries,
    };
    updatePipeline((p) => ({
      ...p,
      headerRows: { ...p.headerRows, ...rowEntries },
    }));
    setBusy(true);
    try {
      const tables = await refreshSources({ ...pipeline, headerRows: nextRows });
      setMappingTableId(null);
      setRawPreview(null);
      const ready = tables.find((t) => t.id === targetId);
      if (ready?.headerOk) {
        const data = await previewSourceTable(ready.path, pickedHeaderRow, 40, {
          keyColumn: pipeline.folderMerges?.[ready.id]?.keyColumn,
          headerRows: nextRows,
        });
        setSourcePreview(data);
        rememberHeaders(ready.id, data.headers, data.headerGroups);
        setStatus(
          `已将「${ready.name}」表头设为第 ${pickedHeaderRow} 行，节点已出现在画布`,
        );
      } else {
        setError(ready?.headerMessage || "表头仍无效，请换一行");
        if (ready) await openHeaderMapping(ready);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function loadMatcherDraftForTable(table: SourceTable) {
    const existing = pipeline?.sourceMatchers?.find((m) => m.id === table.id);
    const seedName = table.matchedName || table.name;
    setMatcherKeywordDraft(
      existing?.keyword ||
        table.matchKeyword ||
        defaultSourceKeyword(seedName) ||
        seedName,
    );
  }

  async function activateStartSourceTab(tableId: string) {
    if (startSourceTabId && startSourceTabId !== tableId) {
      saveSourceMatcherKeyword(startSourceTabId, matcherKeywordDraft);
    }
    setStartSourceTabId(tableId);
    setActiveSourceId(tableId);
    const table = sources.find((s) => s.id === tableId);
    if (!table) return;
    loadMatcherDraftForTable(table);
    if (!table.headerOk) {
      await openHeaderMapping(table);
    } else {
      setMappingTableId(null);
      setRawPreview(null);
      try {
        const data = await previewSourceTable(
          table.path,
          pipeline?.headerRows?.[table.path] ?? table.headerRow,
          40,
          {
            keyColumn: pipeline?.folderMerges?.[table.id]?.keyColumn,
            headerRows: pipeline?.headerRows,
          },
        );
        setSourcePreview(data);
        rememberHeaders(table.id, data.headers, data.headerGroups);
      } catch {
        setSourcePreview(null);
      }
    }
  }

  async function setFolderMergeKey(table: SourceTable, keyColumn: string) {
    updatePipeline((p) => ({
      ...p,
      folderMerges: {
        ...(p.folderMerges ?? {}),
        [table.id]: { keyColumn },
      },
    }));
    setBusy(true);
    setError(null);
    try {
      const data = await previewSourceTable(
        table.path,
        pipeline?.headerRows?.[table.path] ?? table.headerRow,
        40,
        {
          keyColumn,
          headerRows: pipeline?.headerRows,
        },
      );
      setSourcePreview(data);
      rememberHeaders(table.id, data.headers, data.headerGroups);
      setStatus(
        keyColumn
          ? `累计表「${table.name}」按「${keyColumn}」覆盖最新行`
          : `累计表「${table.name}」未选覆盖键，仅拼接`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openSourceConfig(table: SourceTable) {
    setSourceModalId(table.id);
    setActiveSourceId(table.id);
    setActiveStepId(null);
    setStepPreview(null);
    loadMatcherDraftForTable(table);
    await openSourcePreview(table);
  }

  function closeSourceModal() {
    if (sourceModalId) {
      saveSourceMatcherKeyword(sourceModalId, matcherKeywordDraft);
    }
    setSourceModalId(null);
    setMappingTableId(null);
    setRawPreview(null);
  }

  function addStep(
    type: Operation["type"],
    position?: { x: number; y: number },
  ) {
    if (!pipeline) return;
    if (type === "output" || type === "start") {
      const existing = pipeline.steps.find((s) => s.operation.type === type);
      if (existing) {
        setActiveStepId(existing.id);
        setActiveSourceId(null);
        setSourceModalId(null);
        return;
      }
    }
    const step = createStep(type, sources.find((s) => s.headerOk)?.id ?? "");
    const preferred =
      position ??
      flowPlacementRef.current?.viewportCenter() ??
      defaultStartPos();
    const place = findFreeFlowPosition(preferred, pipeline.flowPositions);
    updatePipeline((p) => {
      const steps = [...p.steps, step];
      return {
        ...p,
        steps,
        flowPositions: {
          ...(p.flowPositions ?? {}),
          [step.id]: findFreeFlowPosition(place, p.flowPositions),
        },
        flowEdges: syncIncomingEdgesForStep(p.flowEdges, steps, step.id),
      };
    });
    setActiveSourceId(null);
    setSourceModalId(null);
    // 开始/输出节点需要立刻配置；其它步骤拖入后双击再配
    setActiveStepId(type === "start" || type === "output" ? step.id : null);
    setError(null);
    setStatus(`已添加「${step.name}」到画布`);
  }

  function startPaletteStepPointerDrag(
    type: Operation["type"],
    label: string,
    clientX: number,
    clientY: number,
    pointerId: number,
    target: Element,
  ) {
    // 全程用 ref，避免 pointerdown 里 setState 重渲染导致 click 丢失
    const drag = {
      type,
      startX: clientX,
      startY: clientY,
      moved: false,
    };
    palettePointerDragRef.current = drag;
    document.body.classList.add("palette-step-placing");
    beginStepDrag(type);

    let ghost: HTMLDivElement | null = null;
    const ghostOffset = { x: 90, y: 36 };
    const removeGhost = () => {
      ghost?.remove();
      ghost = null;
    };
    const moveGhost = (x: number, y: number) => {
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "palette-step-ghost rf-node step";
        ghost.style.setProperty("--flow-accent", opAccent(type));
        ghost.setAttribute("aria-hidden", "true");
        ghost.innerHTML = `<div class="rf-top"><span class="rf-kicker">${label}</span></div><div class="rf-title">${label}</div><div class="rf-sub">松开放到流程里</div>`;
        document.body.appendChild(ghost);
      }
      ghost.style.transform = `translate(${Math.round(x - ghostOffset.x)}px, ${Math.round(y - ghostOffset.y)}px)`;
    };

    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (
        !drag.moved &&
        Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > 6
      ) {
        drag.moved = true;
      }
      if (drag.moved) {
        moveGhost(ev.clientX, ev.clientY);
      }
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      try {
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
        /* ignore */
      }
      removeGhost();
      if (palettePointerDragRef.current !== drag) return;
      palettePointerDragRef.current = null;
      document.body.classList.remove("palette-step-placing");
      window.setTimeout(() => endStepDrag(), 0);

      const api = flowPlacementRef.current;
      if (drag.moved) {
        const placed =
          api?.placeStepAtClient(drag.type, ev.clientX, ev.clientY) ?? false;
        if (!placed) {
          setError(null);
          setStatus("请拖到右侧画布上再松开");
        }
        return;
      }
      // 点击（几乎未移动）：放到视野中心
      addStep(drag.type);
    };
    // 捕获阶段监听，避免画布/系统拖拽把事件吃掉
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  }

  function linkPromptField(fieldKey: string, toStepId: string) {
    updatePipeline((p) => {
      const steps = p.steps.map((s) => {
        if (s.id !== toStepId) return s;
        return { ...s, operation: applyPromptFieldLink(s.operation, fieldKey) };
      });
      let next: Pipeline = { ...p, steps };
      next = syncPromptFieldsFromSteps(next);
      next = {
        ...next,
        flowEdges: syncIncomingEdgesForStep(
          next.flowEdges,
          next.steps,
          toStepId,
          next.promptFields,
        ),
      };
      return next;
    });
  }

  function unlinkPromptField(fieldKey: string, toStepId: string) {
    updatePipeline((p) => {
      const steps = p.steps.map((s) => {
        if (s.id !== toStepId) return s;
        return {
          ...s,
          operation: applyPromptFieldUnlink(s.operation, fieldKey),
        };
      });
      const nodeId = promptFieldNodeId(fieldKey);
      const flowEdges = (p.flowEdges ?? []).filter(
        (e) => !(e.target === toStepId && e.source === nodeId),
      );
      let next: Pipeline = { ...p, steps, flowEdges };
      next = syncPromptFieldsFromSteps(next);
      next = {
        ...next,
        flowEdges: syncIncomingEdgesForStep(
          next.flowEdges,
          next.steps,
          toStepId,
          next.promptFields,
        ),
      };
      return next;
    });
  }

  function askRemovePromptFields(keys: string[]) {
    const keyList = keys.map((k) => k.trim()).filter(Boolean);
    if (!keyList.length) return;
    const fields = pipelineRef.current?.promptFields ?? [];
    const labels = keyList.map((key) => {
      const f = fields.find((x) => x.key.trim() === key);
      return f?.label?.trim() || key;
    });
    setDialog({ type: "delete-prompt-fields", keys: keyList, labels });
  }

  function applyRemovePromptFields() {
    if (!dialog || dialog.type !== "delete-prompt-fields") return;
    const keys = dialog.keys;
    setDialog(null);
    removePromptFields(keys);
    setStatus(
      keys.length === 1
        ? `已删除初始数据「${dialog.labels[0] ?? keys[0]}」`
        : `已删除 ${keys.length} 项初始数据`,
    );
  }

  function removePromptFields(keys: string[]) {
    if (!keys.length) return;
    const keySet = new Set(keys.map((k) => k.trim()).filter(Boolean));
    updatePipeline((p) => {
      let steps = p.steps.map((s) => {
        let operation = s.operation;
        for (const key of keySet) {
          operation = applyPromptFieldUnlink(operation, key);
        }
        return { ...s, operation };
      });
      const flowPositions = { ...(p.flowPositions ?? {}) };
      for (const key of keySet) {
        delete flowPositions[promptFieldNodeId(key)];
      }
      const flowEdges = (p.flowEdges ?? []).filter((e) => {
        if (!e.source.startsWith("prompt:")) return true;
        const k = e.source.slice("prompt:".length);
        return !keySet.has(k);
      });
      let next: Pipeline = {
        ...p,
        steps,
        flowPositions,
        flowEdges,
        promptFields: (p.promptFields ?? []).filter((f) => !keySet.has(f.key.trim())),
      };
      next = syncPromptFieldsFromSteps(next);
      next = {
        ...next,
        flowEdges: syncAllIncomingEdges(
          next.flowEdges,
          next.steps,
          next.promptFields,
        ),
      };
      return next;
    });
    setActivePromptFieldKey((cur) => (cur && keySet.has(cur) ? null : cur));
  }

  function addPromptField() {
    if (!pipeline) return;
    let n = 1;
    const existing = new Set(
      (pipeline.promptFields ?? []).map((f) => f.key.trim() || f.label?.trim()),
    );
    while (existing.has(`数据${n}`)) n += 1;
    const name = `数据${n}`;
    const start = pipeline.steps.find((s) => s.operation.type === "start");
    const startPos =
      (start && pipeline.flowPositions?.[start.id]) || defaultStartPos();
    const fieldCount = (pipeline.promptFields ?? []).length;
    const place = findFreeFlowPosition(
      {
        x: startPos.x + FLOW_LAYOUT.fieldOffsetX,
        y: startPos.y + fieldCount * FLOW_LAYOUT.fieldGapY,
      },
      pipeline.flowPositions,
    );
    updatePipeline((p) => ({
      ...p,
      promptFields: [
        ...(p.promptFields ?? []),
        { key: name, label: name, defaultValue: "", required: true },
      ],
      flowPositions: {
        ...(p.flowPositions ?? {}),
        [promptFieldNodeId(name)]: place,
      },
    }));
    setActiveStepId(null);
    setActiveSourceId(null);
    setSourceModalId(null);
    setActivePromptFieldKey(name);
  }

  function savePromptField(
    originalKey: string,
    next: PromptField,
  ) {
    const newKey = (next.label?.trim() || next.key.trim());
    if (!newKey) {
      setError("名称不能为空");
      return;
    }
    const oldKey = originalKey.trim();
    if (
      oldKey !== newKey &&
      (pipeline?.promptFields ?? []).some((f) => f.key.trim() === newKey)
    ) {
      setError(`名称「${newKey}」已存在`);
      return;
    }
    updatePipeline((p) => {
      const renamed = oldKey !== newKey;
      let steps = p.steps;
      if (renamed) {
        steps = p.steps.map((s) => ({
          ...s,
          operation: renamePromptKeyInOp(s.operation, oldKey, newKey),
        }));
      }
      const promptFields = (p.promptFields ?? []).map((f) =>
        f.key.trim() === oldKey
          ? {
              key: newKey,
              label: newKey,
              defaultValue: next.defaultValue ?? "",
              required: next.required !== false,
            }
          : f,
      );
      if (!promptFields.some((f) => f.key.trim() === newKey)) {
        promptFields.push({
          key: newKey,
          label: newKey,
          defaultValue: next.defaultValue ?? "",
          required: next.required !== false,
        });
      }
      const flowPositions = { ...(p.flowPositions ?? {}) };
      if (renamed) {
        const oldId = promptFieldNodeId(oldKey);
        const newId = promptFieldNodeId(newKey);
        if (flowPositions[oldId] && !flowPositions[newId]) {
          flowPositions[newId] = flowPositions[oldId];
        }
        delete flowPositions[oldId];
      }
      let flowEdges = p.flowEdges ?? [];
      if (renamed) {
        const oldId = promptFieldNodeId(oldKey);
        const newId = promptFieldNodeId(newKey);
        flowEdges = flowEdges.map((e) =>
          e.source === oldId
            ? {
                ...e,
                id: `${newId}->${e.target}`,
                source: newId,
              }
            : e,
        );
      }
      let out: Pipeline = {
        ...p,
        steps,
        promptFields,
        flowPositions,
        flowEdges,
      };
      out = syncPromptFieldsFromSteps(out);
      out = {
        ...out,
        flowEdges: syncAllIncomingEdges(
          out.flowEdges,
          out.steps,
          out.promptFields,
        ),
      };
      return out;
    });
    setActivePromptFieldKey(newKey);
    setError(null);
  }

  function removeStep(id: string) {
    removeSteps([id]);
  }

  function remapCloneIds(value: unknown, idMap: Map<string, string>): unknown {
    if (typeof value === "string") return idMap.get(value) ?? value;
    if (Array.isArray(value)) {
      return value.map((v) => remapCloneIds(v, idMap));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = remapCloneIds(v, idMap);
      }
      return out;
    }
    return value;
  }

  function uniquePromptKey(base: string, used: Set<string>): string {
    const root = (base.trim() || "数据").replace(/_副本\d*$/, "");
    let candidate = `${root}_副本`;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${root}_副本${n}`;
      n += 1;
    }
    return candidate;
  }

  /** 多选复制：步骤与初始数据；源表不复制（同一文件不应出两个节点） */
  function duplicateSelection(payload: {
    stepIds: string[];
    fieldKeys: string[];
    sourceIds: string[];
  }) {
    if (!pipeline) return;
    const COPY_OFFSET = { x: 48, y: 48 };
    const stepIdSet = new Set(payload.stepIds);
    const fieldKeySet = new Set(
      payload.fieldKeys.map((k) => k.trim()).filter(Boolean),
    );
    const stepsToCopy = pipeline.steps.filter(
      (s) =>
        stepIdSet.has(s.id) &&
        s.operation.type !== "start" &&
        s.operation.type !== "output",
    );
    const fieldsToCopy = (pipeline.promptFields ?? []).filter((f) =>
      fieldKeySet.has(f.key.trim()),
    );
    if (stepsToCopy.length === 0 && fieldsToCopy.length === 0) {
      if (payload.sourceIds.length > 0) {
        setStatus("源表不支持复制，请复制加工步骤");
      }
      return;
    }

    updatePipeline((p) => {
      const idMap = new Map<string, string>();
      const flowPositions = { ...(p.flowPositions ?? {}) };
      let promptFields = [...(p.promptFields ?? [])];
      const usedKeys = new Set(promptFields.map((f) => f.key.trim()));

      for (const field of fieldsToCopy) {
        const oldKey = field.key.trim();
        const newKey = uniquePromptKey(field.label || oldKey, usedKeys);
        usedKeys.add(newKey);
        idMap.set(oldKey, newKey);
        idMap.set(promptFieldNodeId(oldKey), promptFieldNodeId(newKey));
        promptFields = [
          ...promptFields,
          {
            ...field,
            key: newKey,
            label: newKey,
          },
        ];
        const oldPos = flowPositions[promptFieldNodeId(oldKey)];
        const place = findFreeFlowPosition(
          oldPos
            ? { x: oldPos.x + COPY_OFFSET.x, y: oldPos.y + COPY_OFFSET.y }
            : defaultStartPos(),
          flowPositions,
        );
        flowPositions[promptFieldNodeId(newKey)] = place;
      }

      const newSteps: Step[] = [];
      for (const s of stepsToCopy) {
        const nid = newId();
        idMap.set(s.id, nid);
        idMap.set(s.outputTableId, `tmp:${nid.slice(0, 8)}`);
      }
      for (const s of stepsToCopy) {
        const nid = idMap.get(s.id)!;
        const cloned = structuredClone(s) as Step;
        cloned.id = nid;
        cloned.outputTableId = idMap.get(s.outputTableId)!;
        cloned.operation = remapCloneIds(cloned.operation, idMap) as Operation;
        newSteps.push(cloned);
        const oldPos = flowPositions[s.id] ?? p.flowPositions?.[s.id];
        flowPositions[nid] = findFreeFlowPosition(
          oldPos
            ? { x: oldPos.x + COPY_OFFSET.x, y: oldPos.y + COPY_OFFSET.y }
            : defaultStartPos(),
          flowPositions,
        );
      }

      const steps = [...p.steps, ...newSteps];
      let flowEdges = p.flowEdges ?? [];
      for (const s of newSteps) {
        flowEdges = syncIncomingEdgesForStep(
          flowEdges,
          steps,
          s.id,
          promptFields,
        );
      }

      return {
        ...p,
        steps,
        promptFields,
        flowPositions,
        flowEdges,
      };
    });

    const n = stepsToCopy.length + fieldsToCopy.length;
    setStatus(n === 1 ? "已复制 1 项到画布" : `已复制 ${n} 项到画布`);
    setError(null);
  }

  function removeSteps(ids: string[]) {
    if (ids.length === 0 || !pipeline) return;
    // 开始 / 输出节点唯一且不可删（双击画布节点配置）
    const idSet = new Set(
      ids.filter((id) => {
        const s = pipeline.steps.find((x) => x.id === id);
        return (
          s &&
          s.operation.type !== "start" &&
          s.operation.type !== "output"
        );
      }),
    );
    if (idSet.size === 0) return;
    updatePipeline((p) => {
      const deletedOutputs = new Set(
        p.steps.filter((s) => idSet.has(s.id)).map((s) => s.outputTableId),
      );
      const flowPositions = { ...(p.flowPositions ?? {}) };
      for (const id of idSet) delete flowPositions[id];
      const steps = p.steps
        .filter((s) => !idSet.has(s.id))
        .map((s) => {
          let operation = s.operation;
          for (const tid of deletedOutputs) {
            operation = applyFlowUnlink(operation, tid);
          }
          return { ...s, operation };
        });
      let flowEdges = (p.flowEdges ?? []).filter(
        (e) => !idSet.has(e.source) && !idSet.has(e.target),
      );
      for (const s of steps) {
        flowEdges = syncIncomingEdgesForStep(flowEdges, steps, s.id);
      }
      const next = {
        ...p,
        steps,
        flowEdges,
        flowPositions,
      };
      return syncPipelineFromStartStep(syncPipelineFromOutputStep(next));
    });
    if (activeStepId && idSet.has(activeStepId)) setActiveStepId(null);
    setStepPreview(null);
  }

  /** 手动删除画布上的源表节点（从方案彻底移除，除非再点「刷新」重新识别） */
  function removeSources(ids: string[]) {
    if (!ids.length || !pipeline) return;
    const idSet = new Set(ids.filter(Boolean));
    if (idSet.size === 0) return;
    const purgeKeys = new Set<string>();
    for (const id of idSet) {
      purgeKeys.add(id);
      const table = sources.find((s) => s.id === id);
      if (table) {
        for (const k of sourceIdentityKeys(table)) purgeKeys.add(k);
      }
      const matcher = pipeline.sourceMatchers?.find((m) => m.id === id);
      if (matcher?.keyword?.trim()) purgeKeys.add(matcher.keyword.trim());
      if (matcher?.label?.trim()) purgeKeys.add(matcher.label.trim());
    }
    updatePipeline((p) => {
      const sourceMatchers = (p.sourceMatchers ?? []).filter(
        (m) => !idSet.has(m.id),
      );
      const headerRows = { ...(p.headerRows ?? {}) };
      for (const k of purgeKeys) delete headerRows[k];
      const folderMerges = { ...(p.folderMerges ?? {}) };
      for (const id of idSet) delete folderMerges[id];
      const flowPositions = { ...(p.flowPositions ?? {}) };
      for (const id of idSet) delete flowPositions[id];
      let flowEdges = (p.flowEdges ?? []).filter(
        (e) => !idSet.has(e.source) && !idSet.has(e.target),
      );
      const steps = p.steps.map((s) => {
        let operation = s.operation;
        for (const tid of idSet) {
          operation = applyFlowUnlink(operation, tid);
        }
        return { ...s, operation };
      });
      for (const s of steps) {
        flowEdges = syncIncomingEdgesForStep(
          flowEdges,
          steps,
          s.id,
          p.promptFields,
        );
      }
      flowEdges = syncStartSourceEdges(
        flowEdges,
        steps,
        canvasSourceIds(
          applySourceMatchers(scannedSourcesRef.current, sourceMatchers),
        ),
      );
      return {
        ...p,
        steps,
        sourceMatchers,
        headerRows,
        folderMerges,
        flowPositions,
        flowEdges,
      };
    });
    setSources(() =>
      applySourceMatchers(
        scannedSourcesRef.current,
        pipelineRef.current?.sourceMatchers ?? [],
      ),
    );
    if (activeSourceId && idSet.has(activeSourceId)) {
      setActiveSourceId(null);
      setSourceModalId(null);
    }
    if (startSourceTabId && idSet.has(startSourceTabId)) {
      setStartSourceTabId(null);
    }
    setStatus("已删除源表（再点「刷新」才会重新识别目录中的全部文件）");
  }

  function linkStepInput(
    fromTableId: string,
    toStepId: string,
    fromNodeId: string,
  ) {
    updatePipeline((p) => {
      let steps = p.steps.map((s) => {
        if (s.id !== toStepId) return s;
        return {
          ...s,
          operation: applyFlowLink(s.operation, fromTableId),
        };
      });
      // 若连线来自某步骤输出，保证消费步骤排在其后
      const producerIdx = steps.findIndex((s) => s.id === fromNodeId);
      const consumerIdx = steps.findIndex((s) => s.id === toStepId);
      if (
        producerIdx >= 0 &&
        consumerIdx >= 0 &&
        producerIdx > consumerIdx
      ) {
        const [consumer] = steps.splice(consumerIdx, 1);
        const newProducerIdx = steps.findIndex((s) => s.id === fromNodeId);
        steps.splice(newProducerIdx + 1, 0, consumer);
      }
      const flowEdges = syncIncomingEdgesForStep(p.flowEdges, steps, toStepId);
      const next = { ...p, steps, flowEdges };
      return syncPipelineFromStartStep(syncPipelineFromOutputStep(next));
    });
  }

  function unlinkStepInput(fromTableId: string, toStepId: string) {
    updatePipeline((p) => {
      const steps = p.steps.map((s) => {
        if (s.id !== toStepId) return s;
        return {
          ...s,
          operation: applyFlowUnlink(s.operation, fromTableId),
        };
      });
      const fromNode = edgeSourceNodeId(fromTableId, steps);
      const flowEdges = (p.flowEdges ?? []).filter(
        (e) =>
          !(
            e.target === toStepId &&
            (e.source === fromNode || e.source === fromTableId)
          ),
      );
      const next = { ...p, steps, flowEdges };
      return syncPipelineFromStartStep(syncPipelineFromOutputStep(next));
    });
  }

  /** Toggle「输出为 Sheet」：写入输出节点并自动连线 */
  function setStepOutputAsSheet(
    stepId: string,
    enabled: boolean,
    sheetName?: string,
  ) {
    updatePipeline((p) => {
      const step = p.steps.find((s) => s.id === stepId);
      const out = p.steps.find((s) => s.operation.type === "output");
      if (
        !step ||
        step.operation.type === "start" ||
        step.operation.type === "output" ||
        !out ||
        out.operation.type !== "output"
      ) {
        return p;
      }
      const tid = step.outputTableId;
      const name =
        (sheetName ?? step.result?.sheetName ?? step.name).trim() || step.name;
      let steps = p.steps.map((s) => {
        if (s.id !== out.id) return s;
        let operation = enabled
          ? applyFlowLink(s.operation, tid)
          : applyFlowUnlink(s.operation, tid);
        if (enabled && operation.type === "output") {
          operation = {
            ...operation,
            sheets: operation.sheets.map((sh) =>
              sh.tableId === tid ? { ...sh, sheetName: name } : sh,
            ),
          };
        }
        return { ...s, operation };
      });
      if (enabled) {
        steps = steps.map((s) =>
          s.id === stepId
            ? {
                ...s,
                result: {
                  enabled: true,
                  fileKey: s.result?.fileKey || "main",
                  sheetName: name,
                },
              }
            : s,
        );
      }
      const flowEdges = syncIncomingEdgesForStep(p.flowEdges, steps, out.id);
      return syncPipelineFromOutputStep({ ...p, steps, flowEdges });
    });
  }

  async function runPreviewStep() {
    if (!pipeline || !activeStep) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(`预览本步：${activeStep.name}`);
      const data = await previewStep(pipeline, activeStep.id, 40);
      setStepPreview(data);
      rememberHeaders(
        activeStep.outputTableId,
        data.headers,
        data.headerGroups,
      );
      setStatus(`已预览「${activeStep.name}」`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const loadOutputSheetPreview = useCallback(async (tableId: string) => {
    const pipe = pipelineRef.current;
    if (!pipe) throw new Error("请先选择方案");
    const producer = pipe.steps.find((s) => s.outputTableId === tableId);
    if (!producer) throw new Error("找不到对应步骤数据");
    const data = await previewStep(pipe, producer.id, 40);
    rememberHeaders(tableId, data.headers, data.headerGroups);
    return data;
  }, []);

  function beginExecute() {
    if (!pipeline) return;
    const fields = collectRuntimePromptFields(pipeline);
    if (fields.length) {
      openRuntimeParamsDialog({ kind: "execute" }, fields);
      return;
    }
    void runExecute({});
  }

  function clearExecHighlightSoon(delayMs = 1400) {
    if (execHighlightClearRef.current != null) {
      window.clearTimeout(execHighlightClearRef.current);
    }
    execHighlightClearRef.current = window.setTimeout(() => {
      setExecHighlight(null);
      execHighlightClearRef.current = null;
    }, delayMs);
  }

  async function runExecute(runtimeParams: Record<string, string>) {
    if (!pipeline) return;
    setBusy(true);
    setError(null);
    setLastExport(null);
    setActiveStepId(null);
    setStepPreview(null);
    if (execHighlightClearRef.current != null) {
      window.clearTimeout(execHighlightClearRef.current);
      execHighlightClearRef.current = null;
    }
    setExecHighlight({ currentId: null, doneIds: [] });
    try {
      flowPlacementRef.current?.flushPositions();
      const current = pipelineRef.current;
      if (!current) return;
      const saved = await saveScheme(current);
      const latest = pipelineRef.current ?? current;
      const merged: Pipeline = {
        ...saved,
        flowPositions: latest.flowPositions ?? saved.flowPositions,
        flowEdges: latest.flowEdges ?? saved.flowEdges,
      };
      pipelineRef.current = merged;
      setPipeline(merged);
      setDirty(false);
      const result = await executePipeline(merged, runtimeParams);
      setStatus("执行完成");
      showExportSuccess(result);
      await refreshSchemeList();
      clearExecHighlightSoon();
    } catch (e) {
      const msg = String(e);
      setError(msg);
      setExecHighlight(null);
      await alertError("执行失败", msg);
    } finally {
      setBusy(false);
    }
  }

  async function revealResultFile(path: string) {
    try {
      await revealItemInDir(path);
    } catch (e) {
      setError(`无法在访达中显示：${e}`);
    }
  }

  async function runExportTemplate(id?: string) {
    setCtxMenu(null);
    const schemeId = id ?? pipeline?.id;
    if (!schemeId) return;
    setError(null);
    try {
      let target: Pipeline;
      if (pipeline?.id === schemeId) {
        target = pipeline;
      } else {
        setBusy(true);
        target = syncPromptFieldsFromSteps(
          normalizePipelineWithMeta(await loadScheme(schemeId)).pipeline,
        );
        setBusy(false);
      }
      const path = await save({
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
        defaultPath: `${safeFileName(target.name || "公式模板")}_template.xlsx`,
      });
      if (!path) return;
      setBusy(true);
      const out = await exportFormulaTemplate(target, path);
      setStatus(`公式模板已导出：${out}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function loadDemoSteps() {
    if (!pipeline) return;
    const steps = createNicheDemoSteps(sources);
    updatePipeline((p) => {
      const next = { ...p, steps };
      return syncPipelineFromStartStep(syncPipelineFromOutputStep(next));
    });
    setActiveStepId(steps[0]?.id ?? null);
    setStatus("已填入示例步骤，请核对表与列");
  }

  async function startGuideTour() {
    setCtxMenu(null);
    setDialog(null);
    setActiveStepId(null);
    setActivePromptFieldKey(null);
    setSourceModalId(null);
    setError(null);
    try {
      if (dirty && pipelineRef.current) {
        await persistCurrentScheme({ quiet: true, force: true });
      }
      const demo = createGuideDemoPipeline();
      const saved = await saveScheme(demo);
      await refreshSchemeList();
      await applyOpenedPipeline(saved);
      // 等画布节点挂载后再开指引
      window.setTimeout(() => setGuideStep(0), 120);
      setStatus("已打开「入门示例」，可按指引操作");
    } catch (e) {
      setError(String(e));
    }
  }

  const prepareGuideStep = useCallback((index: number) => {
    const step = GUIDE_TOUR_STEPS[index];
    const kind = step?.modal ?? "none";
    setSourceModalId(null);
    setDialog(null);
    if (kind === "prompt") {
      setActiveStepId(null);
      setActivePromptFieldKey("月份");
      return;
    }
    setActivePromptFieldKey(null);
    if (kind === "start") {
      setActiveStepId("guide-start");
      return;
    }
    if (kind === "filter") {
      setActiveStepId("guide-filter");
      return;
    }
    if (kind === "output") {
      setActiveStepId("guide-output");
      return;
    }
    setActiveStepId(null);
  }, []);

  const closeGuideTour = useCallback(() => {
    setGuideStep(null);
    setActiveStepId(null);
    setActivePromptFieldKey(null);
    setSourceModalId(null);
  }, []);

  return (
    <div className="app">
      <div className="main">
        <aside className="scheme-rail">
          <div className="rail-brand">
            <span className="brand-mark">AE</span>
            <div className="rail-brand-text">
              <h1>Auto Excel</h1>
              <div className="rail-brand-sub">
                <p>本地离线编排</p>
                <button
                  type="button"
                  className="rail-guide-link"
                  onClick={() => void startGuideTour()}
                >
                  操作指引
                </button>
              </div>
            </div>
          </div>
          <div className="rail-actions" data-guide="schemes">
            <button
              type="button"
              className="primary"
              data-guide="btn-new-scheme"
              onClick={() => void handleNewScheme()}
            >
              新建方案
            </button>
            <button
              type="button"
              disabled={busy}
              data-guide="btn-import-scheme"
              onClick={() => void handleImportScheme()}
            >
              导入方案
            </button>
          </div>
          <div className="scheme-list" data-guide="scheme-list">
            {schemes.length === 0 && (
              <div className="muted pad-sm">暂无方案，点击上方「新建方案」</div>
            )}
            {schemes.map((s) => (
              <div
                key={s.id}
                className={`scheme-item ${pipeline?.id === s.id ? "active" : ""} ${
                  ctxMenu?.id === s.id ? "menu-open" : ""
                }`}
                data-guide={
                  s.id === GUIDE_DEMO_SCHEME_ID ? "scheme-guide-demo" : undefined
                }
              >
                <button
                  type="button"
                  className="scheme-item-main"
                  onClick={() => void handleSelectScheme(s.id)}
                >
                  <strong>{s.name}</strong>
                  <span>{s.updatedAt || "—"}</span>
                </button>
                <button
                  type="button"
                  className="scheme-item-more"
                  title="更多操作"
                  aria-label={`更多操作：${s.name}`}
                  aria-expanded={ctxMenu?.id === s.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const menuW = 148;
                    setCtxMenu((prev) =>
                      prev?.id === s.id
                        ? null
                        : {
                            x: Math.max(8, rect.right - menuW),
                            y: rect.bottom + 4,
                            id: s.id,
                          },
                    );
                  }}
                >
                  <svg
                    className="ui-icon sm"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden
                  >
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="workspace" data-guide="workspace">
          {!pipeline ? (
            <div className="empty-state" data-guide="canvas">
              <h2>选择或新建方案</h2>
              <p>先选一个方案，再配置源表和加工步骤，最后生成结果表。</p>
            </div>
          ) : (
            <>
              <div
                className={`flow-workspace${flowFullscreen ? " is-fullscreen" : ""}`}
              >
                <aside className="flow-palette" data-guide="palette">
                  <div className="flow-palette-section">
                    <div className="flow-palette-title">方案名称</div>
                    <input
                      className="flow-palette-scheme-name"
                      value={pipeline.name}
                      onChange={(e) =>
                        updatePipeline((p) => ({ ...p, name: e.target.value }))
                      }
                      placeholder="未命名方案"
                    />
                  </div>

                  <div className="flow-palette-section" data-guide="prompt-fields">
                    <div className="flow-palette-title">初始数据</div>
                    <p className="flow-palette-hint muted">
                      每次跑报表可能不同的参数，例如「月份」「机构」。在筛选或计算里写{" "}
                      <code>${"{月份}"}</code>
                      ，点生成时再填本次要用的值。
                    </p>
                    <button
                      type="button"
                      className="prompt-field-add"
                      data-guide="btn-add-prompt"
                      onClick={() => addPromptField()}
                    >
                      添加初始数据
                    </button>
                    {(pipeline.promptFields ?? []).filter((f) => f.key.trim())
                      .length > 0 && (
                      <div className="prompt-field-chips">
                        {(pipeline.promptFields ?? [])
                          .filter((f) => f.key.trim())
                          .map((f) => (
                            <span
                              key={f.key}
                              className={`prompt-field-chip${
                                activePromptFieldKey === f.key ? " active" : ""
                              }`}
                            >
                              <button
                                type="button"
                                className="prompt-field-chip-label"
                                title={`流程中写 ${promptPlaceholder(f.label?.trim() || f.key)}`}
                                onClick={() => {
                                  if (activeStepId) commitPromptFieldsFromSteps();
                                  setActiveStepId(null);
                                  setActivePromptFieldKey(f.key);
                                }}
                              >
                                {f.label?.trim() || f.key}
                              </button>
                              <button
                                type="button"
                                className="prompt-field-chip-del"
                                title="删除"
                                aria-label={`删除 ${f.label || f.key}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  askRemovePromptFields([f.key]);
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                      </div>
                    )}
                  </div>

                  <div className="flow-palette-section grow" data-guide="steps">
                    <div className="flow-palette-title-row">
                      <div className="flow-palette-title">步骤</div>
                      <FlowPaletteStepsHelp />
                      <span className="flow-palette-hint muted">
                        点击或拖到画布
                      </span>
                    </div>
                    <div className="flow-palette-steps">
                      {ADDABLE_STEP_PALETTE.map((item) => (
                        <div
                          key={item.type}
                          role="button"
                          tabIndex={0}
                          className="flow-palette-step"
                          data-guide={`palette-${item.type}`}
                          title={item.tip}
                          style={{
                            ["--flow-accent" as string]: opAccent(item.type),
                          }}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            // 阻止 WebKit 原生拖拽，改走指针放置
                            e.preventDefault();
                            startPaletteStepPointerDrag(
                              item.type,
                              item.label,
                              e.clientX,
                              e.clientY,
                              e.pointerId,
                              e.currentTarget,
                            );
                          }}
                          onDragStart={(e) => {
                            e.preventDefault();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              addStep(item.type);
                            }
                          }}
                        >
                          <span>{item.label}</span>
                          <small>{item.tip}</small>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="flow-palette-step demo"
                        disabled={sources.length === 0}
                        onClick={loadDemoSteps}
                      >
                        <span>示例步骤</span>
                        <small>一键填入示例流程，便于试用</small>
                      </button>
                    </div>
                  </div>
                </aside>

                <div className="flow-workspace-main">
                  <div className="flow-workspace-toolbar">
                    <h2>流程编排</h2>
                    <span className="muted flow-hint">
                      拖动画布浏览 · 双击节点配置 · 框选多选
                      {" · 约 5 秒自动保存"}
                      {" · ⌘S 保存"}
                      {" · ⌘Z 撤回"}
                    </span>
                    <div className="flow-workspace-toolbar-actions">
                      <button
                        type="button"
                        className="flow-fs-btn primary"
                        data-guide="btn-save"
                        disabled={!pipeline || busy}
                        title="保存方案（有修改时约每 5 秒自动保存；⌘S 立即保存）"
                        onClick={() => void handleSave()}
                      >
                        保存{dirty ? " *" : ""}
                      </button>
                      <button
                        type="button"
                        className="flow-fs-btn primary"
                        data-guide="btn-generate"
                        disabled={!pipeline || busy}
                        title="生成结果"
                        onClick={() => beginExecute()}
                      >
                        <svg
                          className="ui-icon sm"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z" />
                        </svg>
                        生成
                      </button>
                      <button
                        type="button"
                        className="flow-fs-btn"
                        title={
                          flowFullscreen
                            ? "退出沉浸式 (Esc)"
                            : "沉浸式配置"
                        }
                        onClick={() => setFlowFullscreen((v) => !v)}
                      >
                        {flowFullscreen ? "退出沉浸式" : "沉浸式配置"}
                      </button>
                    </div>
                  </div>
                  <div
                    className={`steps-body ${stepPreview && !activeStep ? "with-preview" : ""}`}
                    data-guide="canvas"
                  >
                    <StepsFlowchart
                      steps={pipeline.steps}
                      sources={sources}
                      promptFields={pipeline.promptFields ?? []}
                      activeStepId={activeStepId}
                      activeSourceId={sourceModalId ?? activeSourceId}
                      activeFieldKey={activePromptFieldKey}
                      viewportSeed={pipeline.id}
                      fullscreen={flowFullscreen}
                      canUndo={undoCount > 0}
                      canRedo={redoCount > 0}
                      onUndo={undoPipeline}
                      onRedo={redoPipeline}
                      runHighlight={execHighlight}
                      flowPositions={pipeline.flowPositions ?? {}}
                      flowEdges={pipeline.flowEdges ?? []}
                      tableLabel={tableLabel}
                      onSelect={(id) => {
                        if (activeStepId && activeStepId !== id) {
                          commitPromptFieldsFromSteps();
                        }
                        if (id !== activeStepId) {
                          setStepPreview(null);
                        }
                        setActiveStepId(id);
                        setActivePromptFieldKey(null);
                        setActiveSourceId(null);
                        setSourceModalId(null);
                      }}
                      onSelectSource={(id) => {
                        if (activeStepId) commitPromptFieldsFromSteps();
                        const table = sources.find((s) => s.id === id);
                        if (table) void openSourceConfig(table);
                      }}
                      onSelectField={(key) => {
                        if (activeStepId) commitPromptFieldsFromSteps();
                        setActiveStepId(null);
                        setStepPreview(null);
                        setActivePromptFieldKey(key);
                      }}
                      onAddStepAt={(type, position) => addStep(type, position)}
                      placementApiRef={flowPlacementRef}
                      onLink={linkStepInput}
                      onUnlink={unlinkStepInput}
                      onLinkPrompt={linkPromptField}
                      onUnlinkPrompt={unlinkPromptField}
                      onRemoveSteps={removeSteps}
                      onRemovePromptFields={askRemovePromptFields}
                      onRemoveSources={removeSources}
                      onDuplicateSelection={duplicateSelection}
                      onPositionsChange={(positions) => {
                        updatePipeline((p) => {
                          if (flowPositionsEqual(positions, p.flowPositions)) {
                            return p;
                          }
                          return {
                            ...p,
                            flowPositions: {
                              ...(p.flowPositions ?? {}),
                              ...positions,
                            },
                          };
                        });
                      }}
                      onFlowEdgesChange={(flowEdges) => {
                        updatePipeline((p) => ({
                          ...p,
                          flowEdges,
                        }));
                      }}
                      onFlowNotice={(message) => {
                        setError(null);
                        setStatus(message);
                      }}
                    />
                  </div>
                </div>
              </div>

              {sourceModalId && activeSource && (
                <div
                  className="step-modal-backdrop"
                  onClick={() => closeSourceModal()}
                >
                  <div
                    className={`step-modal source-config-modal${flowFullscreen ? " step-modal-fs" : ""}`}
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`配置源表 ${activeSource.name}`}
                  >
                    <div className="editor-toolbar">
                      <div className="editor-toolbar-title">
                        <strong>
                          {isFolderSource(activeSource)
                            ? `${activeSource.name}（累计）`
                            : activeSource.name}
                        </strong>
                        <span className="muted">
                          {activeSource.matchedName
                            ? `匹配文件：${activeSource.matchedName}`
                            : activeSource.headerOk
                              ? `表头第 ${activeSource.headerRow} 行 · ${activeSource.headers.length} 列`
                              : "请指定表头行"}
                        </span>
                      </div>
                      {activeSource.headerOk && !mappingTableId && (
                        <button
                          type="button"
                          onClick={() => void openHeaderMapping(activeSource)}
                        >
                          重新指定表头行
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        title="关闭"
                        onClick={() => closeSourceModal()}
                      >
                        ×
                      </button>
                    </div>
                    <div className="step-modal-body source-config-body">
                      {busy &&
                      ((mappingTableId && !rawPreview) ||
                        (!mappingTableId &&
                          activeSource.headerOk &&
                          !sourcePreview)) ? (
                        <div
                          className="step-modal-reading"
                          role="status"
                          aria-live="polite"
                        >
                          <div className="step-modal-reading-spin" aria-hidden />
                          <p>正在读取表格…</p>
                          <p className="muted">请稍候</p>
                        </div>
                      ) : (
                        <>
                      <div className="source-matcher-field flat">
                        <label>
                          <span className="matcher-label-row">
                            文件名关键字
                            <span className="hint">
                              填文件名里一定会有的词，用来认准是哪张业务表
                            </span>
                          </span>
                          <input
                            value={matcherKeywordDraft}
                            placeholder="例如：人员清单"
                            onChange={(e) =>
                              setMatcherKeywordDraft(e.target.value)
                            }
                          />
                        </label>
                      </div>
                      {mappingTableId && rawPreview ? (
                        <div className="header-map">
                          <div className="warn-banner">
                            {isFolderSource(activeSource)
                              ? "累计文件夹：下面预览的是最新文件；确认的表头会用于文件夹内全部同类文件"
                              : "未识别到有效表头"}
                            {activeSource.headerMessage
                              ? `：${activeSource.headerMessage}`
                              : isFolderSource(activeSource)
                                ? "。"
                                : "。请选择表头所在行号后确认。"}
                          </div>
                          <div className="map-toolbar">
                            <label>
                              表头行号（从 1 起）
                              <input
                                type="number"
                                min={1}
                                max={rawPreview.totalRows || 1}
                                value={pickedHeaderRow}
                                onChange={(e) =>
                                  setPickedHeaderRow(Number(e.target.value) || 1)
                                }
                              />
                            </label>
                            <button
                              type="button"
                              className="primary"
                              onClick={() => void confirmHeaderRow()}
                              disabled={busy}
                            >
                              确认表头行
                            </button>
                          </div>
                          <div className="table-scroll">
                            <table>
                              <tbody>
                                {rawPreview.rows.map((row, i) => (
                                  <tr
                                    key={i}
                                    className={
                                      i + 1 === pickedHeaderRow ? "picked-row" : ""
                                    }
                                    onClick={() => setPickedHeaderRow(i + 1)}
                                  >
                                    <td className="row-no">{i + 1}</td>
                                    {row.slice(0, 12).map((c, ci) => (
                                      <td key={ci}>{c}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : (
                        <>
                          {isFolderSource(activeSource) && (
                            <div className="folder-merge-bar">
                              <label>
                                覆盖键列（同一键保留最新一天）
                                <SearchableSelect
                                  value={
                                    pipeline?.folderMerges?.[activeSource.id]
                                      ?.keyColumn ?? ""
                                  }
                                  options={activeSource.headers.filter(
                                    (h) => h !== "来源日期",
                                  )}
                                  placeholder="搜索并选择覆盖键"
                                  onChange={(key) =>
                                    void setFolderMergeKey(activeSource, key)
                                  }
                                />
                              </label>
                              <p className="hint">
                                预览只看最新一个文件；点生成时会按日期把文件夹内文件合并在一起。
                                {activeSource.headerMessage
                                  ? ` ${activeSource.headerMessage}`
                                  : ""}
                              </p>
                            </div>
                          )}
                          <PreviewTable data={sourcePreview} />
                        </>
                      )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activePromptFieldKey && pipeline && (() => {
                const field =
                  (pipeline.promptFields ?? []).find(
                    (f) => f.key === activePromptFieldKey,
                  ) ?? {
                    key: activePromptFieldKey,
                    label: activePromptFieldKey,
                    defaultValue: "",
                    required: true,
                  };
                return (
                  <div
                    className="step-modal-backdrop"
                    onClick={() => {
                      if (guideStep != null) return;
                      setActivePromptFieldKey(null);
                    }}
                  >
                    <div
                      className={`step-modal prompt-field-modal${flowFullscreen ? " step-modal-fs" : ""}`}
                      data-guide="modal-prompt"
                      onClick={(e) => e.stopPropagation()}
                      role="dialog"
                      aria-modal="true"
                      aria-label="配置初始数据"
                    >
                      <div className="editor-toolbar">
                        <div className="editor-toolbar-title">
                          <strong>初始数据</strong>
                          <span className="muted">跑报表前填写的业务参数</span>
                        </div>
                        <button
                          type="button"
                          className="ghost"
                          title="关闭"
                          onClick={() => setActivePromptFieldKey(null)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="step-modal-body prompt-field-modal-body">
                        <PromptFieldEditor
                          field={field}
                          onSave={(next) => {
                            savePromptField(field.key, next);
                          }}
                          onDelete={() => {
                            askRemovePromptFields([field.key]);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })()}

      {activeStep && (
                <div
                  className="step-modal-backdrop"
                  onClick={() => {
                    if (guideStep != null) return;
                    requestCloseStepModal();
                  }}
                >
                  <div
                    className={`step-modal${flowFullscreen ? " step-modal-fs" : ""}${
                      activeStep.operation.type === "start"
                        ? " start-config-modal"
                        : ""
                    }`}
                    data-guide={
                      activeStep.operation.type === "start"
                        ? "modal-start"
                        : activeStep.operation.type === "output"
                          ? "modal-output"
                          : "modal-step"
                    }
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`配置 ${activeStep.name}`}
                  >
                    <div className="editor-toolbar">
                      <div className="editor-toolbar-title">
                        <div className="editor-toolbar-title-row">
                          {activeStep.operation.type === "start" ||
                          activeStep.operation.type === "output" ? (
                            <strong className="step-name-display is-locked">
                              {activeStep.operation.type === "start"
                                ? "开始"
                                : "输出"}
                            </strong>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="step-name-edit-icon"
                                title="编辑名称"
                                onClick={() => beginEditStepName()}
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
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                              </button>
                              {editingStepName ? (
                                <input
                                  className="step-name-inline-input"
                                  autoFocus
                                  value={stepNameDraft}
                                  onChange={(e) =>
                                    setStepNameDraft(e.target.value)
                                  }
                                  onBlur={() => commitStepName()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      commitStepName();
                                    }
                                    if (e.key === "Escape") {
                                      e.preventDefault();
                                      setEditingStepName(false);
                                      setStepNameDraft(activeStep.name);
                                    }
                                  }}
                                />
                              ) : (
                                <strong
                                  className="step-name-display"
                                  title="双击编辑名称"
                                  onDoubleClick={() => beginEditStepName()}
                                >
                                  {activeStep.name}
                                </strong>
                              )}
                            </>
                          )}
                          {activeStep.operation.type !== "start" &&
                            activeStep.operation.type !== "output" && (
                              <div className="toolbar-result-box">
                                <label className="toolbar-result-check">
                                  <input
                                    type="checkbox"
                                    checked={!!activeStep.result?.enabled}
                                    onChange={(e) =>
                                      setStepOutputAsSheet(
                                        activeStep.id,
                                        e.target.checked,
                                      )
                                    }
                                  />
                                  输出为 Sheet
                                </label>
                                {activeStep.result?.enabled && (
                                  <label className="toolbar-sheet-name-field">
                                    <span>Sheet名称：</span>
                                    <input
                                      className="toolbar-sheet-name"
                                      value={activeStep.result.sheetName || ""}
                                      placeholder="Sheet 名称"
                                      title="导出 Sheet 名称"
                                      onChange={(e) =>
                                        setStepOutputAsSheet(
                                          activeStep.id,
                                          true,
                                          e.target.value,
                                        )
                                      }
                                    />
                                  </label>
                                )}
                              </div>
                            )}
                        </div>
                      </div>
                      {activeStep.operation.type !== "output" &&
                        activeStep.operation.type !== "start" && (
                        <button
                          type="button"
                          onClick={() => void runPreviewStep()}
                          disabled={busy}
                        >
                          预览本步
                        </button>
                      )}
                      {activeStep.operation.type !== "start" &&
                        activeStep.operation.type !== "output" && (
                        <button
                          type="button"
                          className="danger"
                          onClick={() => removeStep(activeStep.id)}
                        >
                          删除
                        </button>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        title="关闭"
                        onClick={() => requestCloseStepModal()}
                      >
                        ×
                      </button>
                    </div>
                    <div
                      className={`step-modal-body${
                        activeStep.operation.type === "start"
                          ? " start-config-body"
                          : activeStep.operation.type === "output"
                            ? " output-config-body"
                            : " with-preview"
                      }`}
                    >
                      {activeStep.operation.type === "start" ? (
                        <div className="start-config">
                          <div className="start-config-folder">
                            <label className="grow">
                              源表文件夹
                              <div className="path-row">
                                <input
                                  value={
                                    activeStep.operation.type === "start"
                                      ? activeStep.operation.sourceDir
                                      : ""
                                  }
                                  onChange={(e) =>
                                    updatePipeline((p) => {
                                      const steps = p.steps.map((s) =>
                                        s.id === activeStep.id &&
                                        s.operation.type === "start"
                                          ? {
                                              ...s,
                                              operation: {
                                                ...s.operation,
                                                sourceDir: e.target.value,
                                              },
                                            }
                                          : s,
                                      );
                                      return syncPipelineFromStartStep({
                                        ...p,
                                        steps,
                                      });
                                    })
                                  }
                                  placeholder="选择源数据目录"
                                />
                                <button
                                  type="button"
                                  onClick={() => void pickSourceDir()}
                                >
                                  浏览
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    !(
                                      activeStep.operation.type === "start" &&
                                      activeStep.operation.sourceDir.trim()
                                    ) ||
                                    scanning ||
                                    busy
                                  }
                                  onClick={() => {
                                    if (!pipeline) return;
                                    flushSync(() => {
                                      setScanning(true);
                                    });
                                    void refreshSources(pipeline, {
                                      ensureMatchers: true,
                                    });
                                  }}
                                  title="重新扫描目录并识别全部源表（已删除的也会重新出现）"
                                >
                                  {scanning ? "扫描中" : "刷新"}
                                </button>
                              </div>
                            </label>
                            <p className="hint">
                              {scanning
                                ? "正在识别文件夹里的表格，文件较多时请稍候…"
                                : sources.length === 0
                                  ? "选好文件夹后会自动找出里面的业务表；有新增或需重新识别时点「刷新」。"
                                  : `已登记 ${sources.length} 张源表；删除后不会自动回来，需点「刷新」才会重新识别目录`}
                            </p>
                          </div>

                          {scanning ? (
                            <div
                              className="start-source-loading"
                              role="status"
                              aria-live="polite"
                            >
                              <span className="start-source-spinner" aria-hidden />
                              <div className="start-source-loading-text">
                                <strong>正在加载源表…</strong>
                                <span className="muted">
                                  文件夹内表格较多时会稍慢，请稍候
                                </span>
                              </div>
                            </div>
                          ) : (
                            <>
                            {sources.length > 0 && (
                            <>
                              <div
                                className="start-source-tabs"
                                role="tablist"
                                aria-label="源表"
                              >
                                {sources.map((s) => (
                                  <button
                                    key={s.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={startSourceTabId === s.id}
                                    className={`start-source-tab${
                                      startSourceTabId === s.id ? " active" : ""
                                    }${s.headerOk ? " ready" : " need-header"}`}
                                    onClick={() =>
                                      void activateStartSourceTab(s.id)
                                    }
                                    title={
                                      s.headerOk
                                        ? `表头第 ${s.headerRow} 行`
                                        : "需指定表头行"
                                    }
                                  >
                                    <span className="start-source-tab-name">
                                      {s.name}
                                    </span>
                                    <span className="start-source-tab-badge">
                                      {s.headerOk ? "✓" : "!"}
                                    </span>
                                  </button>
                                ))}
                              </div>

                              {(() => {
                                const tabSource =
                                  sources.find(
                                    (s) => s.id === startSourceTabId,
                                  ) ?? null;
                                if (!tabSource) {
                                  return (
                                    <p className="muted pad-sm">
                                      请选择上方源表 Tab
                                    </p>
                                  );
                                }
                                return (
                                  <div className="start-source-panel">
                                    <div className="start-source-panel-head">
                                      <div>
                                        <strong>
                                          {isFolderSource(tabSource)
                                            ? `${tabSource.name}（累计）`
                                            : tabSource.name}
                                        </strong>
                                        <span className="muted">
                                          {tabSource.matchedName
                                            ? `当前文件：${tabSource.matchedName}`
                                            : tabSource.headerOk
                                              ? `表头第 ${tabSource.headerRow} 行 · ${tabSource.headers.length} 列`
                                              : "请指定表头行"}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="source-matcher-field flat">
                                      <label>
                                        <span className="matcher-label-row">
                                          文件名关键字
                                          <span className="hint">
                                            填文件名里一定会有的词，用来认准是哪张业务表
                                          </span>
                                        </span>
                                        <input
                                          value={matcherKeywordDraft}
                                          placeholder="例如：人员清单"
                                          onChange={(e) =>
                                            setMatcherKeywordDraft(
                                              e.target.value,
                                            )
                                          }
                                        />
                                      </label>
                                    </div>

                                    {mappingTableId === tabSource.id &&
                                    rawPreview ? (
                                      <div className="header-map">
                                        <div className="warn-banner">
                                          {isFolderSource(tabSource)
                                            ? "累计文件夹：以下为最新文件的前几行，确认的表头行将用于该文件夹内全部文件"
                                            : "未识别到有效表头"}
                                          {tabSource.headerMessage
                                            ? `：${tabSource.headerMessage}`
                                            : isFolderSource(tabSource)
                                              ? "。"
                                              : "。请选择表头所在行号后确认。"}
                                        </div>
                                        <div className="map-toolbar">
                                          <label>
                                            表头行号（从 1 起）
                                            <input
                                              type="number"
                                              min={1}
                                              max={rawPreview.totalRows || 1}
                                              value={pickedHeaderRow}
                                              onChange={(e) =>
                                                setPickedHeaderRow(
                                                  Number(e.target.value) || 1,
                                                )
                                              }
                                            />
                                          </label>
                                          <button
                                            type="button"
                                            className="primary"
                                            onClick={() =>
                                              void confirmHeaderRow()
                                            }
                                            disabled={busy}
                                          >
                                            确认表头行
                                          </button>
                                        </div>
                                        <div className="table-scroll">
                                          <table>
                                            <tbody>
                                              {rawPreview.rows.map(
                                                (row, i) => (
                                                  <tr
                                                    key={i}
                                                    className={
                                                      i + 1 === pickedHeaderRow
                                                        ? "picked-row"
                                                        : ""
                                                    }
                                                    onClick={() =>
                                                      setPickedHeaderRow(i + 1)
                                                    }
                                                  >
                                                    <td className="row-no">
                                                      {i + 1}
                                                    </td>
                                                    {row
                                                      .slice(0, 12)
                                                      .map((c, ci) => (
                                                        <td key={ci}>{c}</td>
                                                      ))}
                                                  </tr>
                                                ),
                                              )}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    ) : (
                                      <>
                                        {isFolderSource(tabSource) && (
                                          <div className="folder-merge-bar">
                                            <label>
                                              覆盖键列（同一键保留最新一天）
                                              <SearchableSelect
                                                value={
                                                  pipeline?.folderMerges?.[
                                                    tabSource.id
                                                  ]?.keyColumn ?? ""
                                                }
                                                options={tabSource.headers.filter(
                                                  (h) => h !== "来源日期",
                                                )}
                                                placeholder="搜索并选择覆盖键"
                                                onChange={(key) =>
                                                  void setFolderMergeKey(
                                                    tabSource,
                                                    key,
                                                  )
                                                }
                                              />
                                            </label>
                                          </div>
                                        )}
                                        {tabSource.headerOk &&
                                          mappingTableId !== tabSource.id && (
                                            <div className="start-preview-actions">
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  void openHeaderMapping(
                                                    tabSource,
                                                  )
                                                }
                                              >
                                                重新指定表头行
                                              </button>
                                            </div>
                                          )}
                                        {tabSource.headerOk ? (
                                          <PreviewTable data={sourcePreview} />
                                        ) : (
                                          <p className="muted pad-sm">
                                            正在加载表头预览…
                                          </p>
                                        )}
                                      </>
                                    )}
                                  </div>
                                );
                              })()}
                            </>
                            )}
                            </>
                          )}
                        </div>
                      ) : (
                        <>
                          <StepEditor
                            step={activeStep}
                            tableOptions={tableOptions}
                            headerCache={headerCache}
                            headerGroupsCache={headerGroupsCache}
                            headersLoading={headersLoading}
                            ensureTableHeaders={ensureTableHeaders}
                            tableLabel={tableLabel}
                            onPickOutputDir={() => void pickOutputDir()}
                            onPickSourceDir={() => void pickSourceDir()}
                            onRefreshSources={() => {
                              if (pipeline)
                                void refreshSources(pipeline, {
                                  ensureMatchers: true,
                                });
                            }}
                            sourceScanning={scanning}
                            sourceCount={sources.length}
                            busyFlag={busy}
                            loadOutputSheetPreview={
                              activeStep.operation.type === "output"
                                ? loadOutputSheetPreview
                                : undefined
                            }
                            onChange={(s) =>
                              updateStep(activeStep.id, () => s)
                            }
                          />
                          {activeStep.operation.type !== "output" && (
                            <div className="step-modal-preview">
                              <div className="mini-head">
                                {stepPreview ? "本步预览" : "预览结果"}
                              </div>
                              {stepPreview ? (
                                <PreviewTable data={stepPreview} />
                              ) : (
                                <p className="muted pad-sm">
                                  点上方「预览本步」后，这里会显示本步结果样例
                                </p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

            </>
          )}
        </section>
      </div>

      {lastExport && lastExport.outputFiles.length > 0 && (
        <div className="export-banner">
          <div className="export-banner-main">
            <strong>生成成功</strong>
            <span className="export-sheets">
              Sheet：{lastExport.sheetNames.join("、") || "—"} · 5 秒后自动关闭
            </span>
            {lastExport.outputFiles.map((path) => (
              <div key={path} className="export-file-row">
                <span className="export-path" title={path}>
                  {path}
                </span>
                <button type="button" onClick={() => void revealResultFile(path)}>
                  查看文件夹
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="export-dismiss"
            onClick={() => setLastExport(null)}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      )}

      <footer className="status">
        <span>{busy ? "处理中…" : scanning ? "扫描源表…" : status}</span>
        {error && <span className="error">{error}</span>}
      </footer>

      {guideStep != null && (
        <GuideTour
          stepIndex={guideStep}
          onStepChange={setGuideStep}
          onClose={closeGuideTour}
          onPrepareStep={prepareGuideStep}
        />
      )}

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => void handleCopyScheme(ctxMenu.id)}>
            复制
          </button>
          <button type="button" onClick={() => void handleExportScheme(ctxMenu.id)}>
            导出方案
          </button>
          <button
            type="button"
            onClick={() => void runExportTemplate(ctxMenu.id)}
          >
            导出公式模板
          </button>
          <button
            type="button"
            onClick={() => void handleRunSchemeOnFolder(ctxMenu.id)}
          >
            对文件夹执行
          </button>
          <button
            type="button"
            className="danger-text"
            onClick={() => askDelete(ctxMenu.id)}
          >
            删除
          </button>
        </div>
      )}

      {dialog && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (dialog.type === "import-setup") return;
            setDialog(null);
          }}
        >
          <div
            className={`modal${dialog.type === "import-setup" ? " modal-wide" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {dialog.type === "new" && (
              <>
                <h3>新建方案</h3>
                <label>
                  方案名称
                  <input
                    autoFocus
                    value={dialogInput}
                    onChange={(e) => setDialogInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createSchemeWithName(dialogInput);
                    }}
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void createSchemeWithName(dialogInput)}
                  >
                    创建
                  </button>
                </div>
              </>
            )}
            {dialog.type === "delete" && (
              <>
                <h3>删除方案</h3>
                <p className="modal-text">
                  确定删除「{dialog.name}」？此操作不可恢复。
                </p>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void applyDelete()}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
            {dialog.type === "delete-prompt-fields" && (
              <>
                <h3>删除初始数据</h3>
                <p className="modal-text">
                  {dialog.keys.length === 1
                    ? `确定删除初始数据「${dialog.labels[0]}」？流程里引用 ${promptPlaceholder(dialog.labels[0])} 的地方将一并断开。`
                    : `确定删除这 ${dialog.keys.length} 项初始数据（${dialog.labels.join("、")}）？相关引用将一并断开。`}
                </p>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => applyRemovePromptFields()}
                  >
                    删除
                  </button>
                </div>
              </>
            )}
            {dialog.type === "unsaved" && (
              <>
                <h3>未保存的修改</h3>
                <p className="modal-text">当前方案有未保存修改，如何继续？</p>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveUnsaved(false)}
                  >
                    不保存
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void resolveUnsaved(true)}
                  >
                    保存并打开
                  </button>
                </div>
              </>
            )}
            {dialog.type === "recover-draft" && (
              <>
                <h3>恢复未保存内容</h3>
                <p className="modal-text">
                  方案「{dialog.name}」发现上次异常退出前的未保存版本，是否恢复？
                </p>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void discardDraftAndOpen(dialog.schemeId)}
                  >
                    打开已保存版本
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void recoverDraft(dialog.schemeId)}
                  >
                    恢复未保存版本
                  </button>
                </div>
              </>
            )}
            {dialog.type === "folder-run" && (
              <>
                <h3>选择要执行的方案</h3>
                <p className="modal-text">
                  将使用文件夹：
                  <br />
                  <code className="path-code">{dialog.folder}</code>
                  <br />
                  按方案里已认准的表继续加工，结果也写回该文件夹。
                </p>
                <div className="folder-run-list">
                  {schemes.length === 0 && (
                    <div className="muted">暂无方案，请先在应用内创建或导入</div>
                  )}
                  {schemes.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="folder-run-item"
                      disabled={busy}
                      onClick={() =>
                        void beginRunSchemeInFolder(s.id, dialog.folder)
                      }
                    >
                      <strong>{s.name}</strong>
                      <span>{s.updatedAt || "—"}</span>
                    </button>
                  ))}
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                </div>
              </>
            )}
            {dialog.type === "runtime-params" && (
              <>
                <h3>填写初始数据</h3>
                <p className="modal-text">
                  请填写本次跑报表要用的参数（如月份、机构）。只影响这一次，不会改方案本身。
                </p>
                <div className="runtime-params-form">
                  {dialog.fields.map((f) => (
                    <label key={f.key}>
                      {f.label || f.key}
                      {f.required !== false ? " *" : ""}
                      <input
                        autoFocus={f.key === dialog.fields[0]?.key}
                        value={runtimeParamDraft[f.key] ?? ""}
                        placeholder={f.defaultValue || f.key}
                        onChange={(e) =>
                          setRuntimeParamDraft((prev) => ({
                            ...prev,
                            [f.key]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") confirmRuntimeParams();
                        }}
                      />
                    </label>
                  ))}
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => confirmRuntimeParams()}
                  >
                    继续执行
                  </button>
                </div>
              </>
            )}
            {dialog.type === "next-step" && (
              <>
                <h3>下一步做什么？</h3>
                <p className="modal-text">
                  「{dialog.fromName}」做完后，可接着加上下面的步骤（也可先跳过）。
                </p>
                <div className="next-step-list">
                  {STEP_PALETTE.map(
                    (item) => (
                      <button
                        key={item.type}
                        type="button"
                        className="next-step-item"
                        style={
                          {
                            "--accent": opAccent(item.type),
                          } as CSSProperties
                        }
                        onClick={() =>
                          addNextStepFrom(dialog.fromStepId, item.type)
                        }
                      >
                        <strong>{item.label}</strong>
                        <span>{item.tip}</span>
                      </button>
                    ),
                  )}
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    暂不添加
                  </button>
                </div>
              </>
            )}
            {dialog.type === "import-setup" && (
              <>
                <h3>导入配置</h3>
                <p className="modal-text">
                  方案「{dialog.setup.schemeName}」已导入。请重新指定本次用的文件夹，并按实际文件名调整认表关键字；
                  <b>方案里要哪些源表不能增减</b>。全部对上后点「完成配置」；若暂时对不上，可点「仍然导入」稍后在开始节点补全。
                </p>
                {dialog.setup.warnings.length > 0 && (
                  <ul className="import-warning-list">
                    {dialog.setup.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className="import-setup-fields">
                  <label className="grow">
                    源数据文件夹
                    <div className="path-row">
                      <input
                        value={dialog.setup.sourceDir}
                        onChange={(e) =>
                          patchImportSetup({ sourceDir: e.target.value })
                        }
                        onBlur={() => void revalidateImportSetup()}
                        placeholder="选择源表所在目录"
                      />
                      <button
                        type="button"
                        onClick={() => void pickImportSetupDir("source")}
                      >
                        浏览
                      </button>
                    </div>
                    <span
                      className={
                        dialog.setup.sourceDirOk
                          ? "import-setup-ok"
                          : "import-setup-bad"
                      }
                    >
                      {dialog.setup.sourceDir.trim()
                        ? dialog.setup.sourceDirOk
                          ? "目录可用"
                          : "目录不存在"
                        : "未选择"}
                    </span>
                  </label>
                  <label className="grow">
                    输出文件夹
                    <div className="path-row">
                      <input
                        value={dialog.setup.outputDir}
                        onChange={(e) =>
                          patchImportSetup({ outputDir: e.target.value })
                        }
                        onBlur={() => void revalidateImportSetup()}
                        placeholder="结果 Excel 输出位置"
                      />
                      <button
                        type="button"
                        onClick={() => void pickImportSetupDir("output")}
                      >
                        浏览
                      </button>
                    </div>
                    <span
                      className={
                        dialog.setup.outputDirOk
                          ? "import-setup-ok"
                          : "import-setup-bad"
                      }
                    >
                      {dialog.setup.outputDir.trim()
                        ? dialog.setup.outputDirOk
                          ? "目录可用"
                          : "目录不存在"
                        : "未选择"}
                    </span>
                  </label>
                </div>
                <div className="field-label" style={{ marginTop: "0.35rem" }}>
                  方案源表（可改认表关键字，不可增删）
                  {dialog.setup.scanning ? " · 校验中…" : ""}
                </div>
                {dialog.setup.matchers.length === 0 ? (
                  <p className="hint">本方案没有要用的源表</p>
                ) : (
                  <div className="import-setup-matchers">
                    {dialog.setup.matchers.map((m, idx) => (
                      <div key={m.id} className="import-setup-matcher">
                        <div className="import-setup-matcher-name" title={m.id}>
                          {m.label}
                        </div>
                        <input
                          value={m.keyword}
                          placeholder="匹配关键字"
                          onChange={(e) => {
                            const keyword = e.target.value;
                            setDialog((d) => {
                              if (d?.type !== "import-setup") return d;
                              const matchers = d.setup.matchers.map((x, i) =>
                                i === idx ? { ...x, keyword, ok: false } : x,
                              );
                              return {
                                ...d,
                                setup: { ...d.setup, matchers },
                              };
                            });
                          }}
                          onBlur={() => void revalidateImportSetup()}
                        />
                        <span
                          className={
                            m.ok ? "import-setup-ok" : "import-setup-bad"
                          }
                          title={m.matchedName}
                        >
                          {m.ok
                            ? `✓ ${m.matchedName}`
                            : m.matchedName || "未匹配"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {!importSetupIsReady(dialog.setup) && (
                  <ul className="import-warning-list compact">
                    {importSetupBlockingReasons(dialog.setup).map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void cancelImportSetup()}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={dialog.setup.scanning || busy}
                    onClick={() => void revalidateImportSetup()}
                  >
                    重新校验
                  </button>
                  {!importSetupIsReady(dialog.setup) && (
                    <button
                      type="button"
                      disabled={dialog.setup.scanning || busy}
                      onClick={() => void applyImportSetup(true)}
                      title="目录或源表未全部就绪时仍可先导入，稍后在方案里补全"
                    >
                      仍然导入
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      !importSetupIsReady(dialog.setup) ||
                      dialog.setup.scanning ||
                      busy
                    }
                    onClick={() => void applyImportSetup(false)}
                  >
                    完成配置
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PromptFieldEditor({
  field,
  onSave,
  onDelete,
}: {
  field: PromptField;
  onSave: (next: PromptField) => void;
  onDelete?: () => void;
}) {
  const [label, setLabel] = useState(field.label?.trim() || field.key);
  const [defaultValue, setDefaultValue] = useState(field.defaultValue ?? "");
  const [required, setRequired] = useState(field.required !== false);

  useEffect(() => {
    setLabel(field.label?.trim() || field.key);
    setDefaultValue(field.defaultValue ?? "");
    setRequired(field.required !== false);
  }, [field.key, field.label, field.defaultValue, field.required]);

  const name = label.trim() || field.key;

  return (
    <div className="prompt-field-editor">
      <div className="prompt-field-editor-preview" aria-hidden={!name}>
        <span className="prompt-field-editor-preview-label">流程里写成</span>
        <code className="prompt-field-token">{promptPlaceholder(name)}</code>
      </div>

      <div className="prompt-field-editor-fields">
        <label className="prompt-field-editor-field">
          <span>名称</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="如 月份、机构"
            title="流程里写成 ${名称}"
            autoFocus
          />
        </label>
        <label className="prompt-field-editor-field">
          <span>常用值</span>
          <input
            value={defaultValue}
            onChange={(e) => setDefaultValue(e.target.value)}
            placeholder="可不填，生成时再输入"
          />
        </label>
        <label className="prompt-field-editor-required">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          <span className="prompt-field-editor-required-text">
            <strong>每次生成都要填</strong>
            <em>勾选后，点生成时若未填会提醒</em>
          </span>
        </label>
      </div>

      <p className="prompt-field-editor-hint">
        适合「月份」「机构」等每次跑报表可能变化的内容。在筛选或计算公式里写入上方引用，点生成时再填本次要用的值。
      </p>

      <div className="prompt-field-editor-actions">
        {onDelete && (
          <button type="button" className="danger ghost" onClick={onDelete}>
            删除
          </button>
        )}
        <div className="prompt-field-editor-actions-end">
          <button
            type="button"
            className="primary"
            onClick={() =>
              onSave({
                key: name,
                label: name,
                defaultValue,
                required,
              })
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function OutputSheetList({
  sheets,
  tableLabel,
  onReorder,
  onRename,
  onRemove,
  loadPreview,
}: {
  sheets: OutputSheetRef[];
  tableLabel: (tableId: string) => string;
  onReorder: (sheets: OutputSheetRef[]) => void;
  onRename: (tableId: string, sheetName: string) => void;
  onRemove?: (tableId: string) => void;
  loadPreview?: (tableId: string) => Promise<PreviewData>;
}) {
  const [activeId, setActiveId] = useState<string | null>(
    sheets[0]?.tableId ?? null,
  );
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  useEffect(() => {
    if (sheets.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !sheets.some((s) => s.tableId === activeId)) {
      setActiveId(sheets[0]!.tableId);
    }
  }, [sheets, activeId]);

  useEffect(() => {
    if (!loadPreview || !activeId) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void loadPreview(activeId)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, loadPreview]);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sheets.findIndex((s) => s.tableId === active.id);
    const newIndex = sheets.findIndex((s) => s.tableId === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(sheets, oldIndex, newIndex));
  }

  if (sheets.length === 0) return null;

  const activeSheet = sheets.find((s) => s.tableId === activeId) ?? sheets[0];

  return (
    <div className="excel-sheet-bar-wrap">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={sheets.map((s) => s.tableId)}
          strategy={rectSortingStrategy}
        >
          <div className="excel-sheet-bar" role="tablist" aria-label="结果 Sheet">
            {sheets.map((o) => (
              <SortableOutputSheet
                key={o.tableId}
                id={o.tableId}
                sheetName={o.sheetName}
                stepLabel={tableLabel(o.tableId)}
                active={o.tableId === activeSheet?.tableId}
                onSelect={() => setActiveId(o.tableId)}
                onRename={(name) => onRename(o.tableId, name)}
                onRemove={onRemove ? () => onRemove(o.tableId) : undefined}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {activeSheet && (
        <p className="excel-sheet-source muted">
          当前：{activeSheet.sheetName.trim() || "未命名"} · 来自：
          {tableLabel(activeSheet.tableId)}
        </p>
      )}
      {loadPreview && (
        <div className="output-sheet-preview">
          {previewLoading ? (
            <p className="muted pad-sm">正在加载预览…</p>
          ) : previewError ? (
            <p className="warn-inline">{previewError}</p>
          ) : preview ? (
            <PreviewTable data={preview} />
          ) : (
            <p className="muted pad-sm">暂无预览数据</p>
          )}
        </div>
      )}
    </div>
  );
}

function SortableOutputSheet({
  id,
  sheetName,
  stepLabel,
  active,
  onSelect,
  onRename,
  onRemove,
}: {
  id: string;
  sheetName: string;
  stepLabel: string;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: editing });

  return (
    <div
      ref={setNodeRef}
      aria-selected={active}
      title={`来自：${stepLabel}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 2 : undefined,
      }}
      className={`excel-sheet-tab${active ? " is-active" : ""}${isDragging ? " is-dragging" : ""}${editing ? " is-editing" : ""}`}
      {...attributes}
      {...(editing ? {} : listeners)}
      role="tab"
      onClick={() => onSelect()}
      onDoubleClick={(e) => {
        e.preventDefault();
        onSelect();
        setEditing(true);
      }}
    >
      {editing ? (
        <input
          className="excel-sheet-tab-input"
          autoFocus
          value={sheetName}
          placeholder="Sheet 名称"
          onChange={(e) => onRename(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setEditing(false);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="excel-sheet-tab-name">
          {sheetName.trim() || "Sheet"}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          className="excel-sheet-tab-close"
          title="移除"
          aria-label={`移除 ${sheetName || "Sheet"}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function fuzzyRank(text: string, query: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, "");
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  if (t === q) return 1000;
  const idx = t.indexOf(q);
  if (idx >= 0) return 500 - idx;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    ti = found + 1;
  }
  return 80 - Math.min(t.length - q.length, 70);
}

function fuzzyFilter(items: string[], query: string): string[] {
  const scored = items
    .map((item) => ({ item, score: fuzzyRank(item, query) }))
    .filter((x): x is { item: string; score: number } => x.score !== null);
  scored.sort((a, b) => b.score - a.score || a.item.localeCompare(b.item, "zh"));
  return scored.map((x) => x.item);
}

function SearchableSelect({
  value,
  options,
  placeholder = "搜索并选择",
  onChange,
}: {
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = fuzzyFilter(options, query);

  return (
    <div className={`search-select ${open ? "open" : ""}`}>
      <input
        value={open ? query : value}
        placeholder={value || placeholder}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
      />
      {open && (
        <div className="search-select-menu">
          {filtered.length === 0 && (
            <div className="muted pad-sm">无匹配字段</div>
          )}
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              className={opt === value ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(opt);
                setQuery("");
                setOpen(false);
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VlookupEditor({
  op,
  tableOptions,
  headersFor,
  guessJoinKeys,
  onChange,
}: {
  op: Extract<Operation, { type: "vlookup" }>;
  tableOptions: { id: string; label: string; headers: string[] }[];
  headersFor: (tableId: string) => string[];
  guessJoinKeys: (
    baseId: string,
    foreignId: string,
  ) => { baseKey: string; foreignKey: string };
  onChange: (op: Extract<Operation, { type: "vlookup" }>) => void;
}) {
  const [activeLookup, setActiveLookup] = useState(0);
  const leftHeaders = headersFor(op.leftTableId);
  const lookups =
    op.lookups?.length > 0
      ? op.lookups
      : [{ tableId: "", leftKey: "", rightKey: "", columns: [] as string[] }];

  const activeIndex = Math.min(
    Math.max(activeLookup, 0),
    Math.max(lookups.length - 1, 0),
  );

  function patchLookups(
    nextLookups: typeof lookups,
    extra: Partial<Extract<Operation, { type: "vlookup" }>> = {},
  ) {
    const first = nextLookups[0] ?? {
      tableId: "",
      leftKey: "",
      rightKey: "",
      columns: [] as string[],
    };
    onChange({
      ...op,
      ...extra,
      lookups: nextLookups,
      leftKey: first.leftKey,
      rightTableId: first.tableId,
      rightKey: first.rightKey,
      rightColumns: first.columns,
    });
  }

  function updateLookup(
    index: number,
    patch: Partial<(typeof lookups)[number]>,
  ) {
    const next = lookups.map((l, i) => (i === index ? { ...l, ...patch } : l));
    const cur = next[index];
    if (
      cur.tableId &&
      op.leftTableId &&
      (!cur.leftKey || !cur.rightKey) &&
      ("tableId" in patch || !cur.leftKey)
    ) {
      const guessed = guessJoinKeys(op.leftTableId, cur.tableId);
      if (!cur.leftKey) cur.leftKey = guessed.baseKey;
      if (!cur.rightKey) cur.rightKey = guessed.foreignKey;
      next[index] = { ...cur };
    }
    patchLookups(next);
  }

  const lu = lookups[activeIndex] ?? lookups[0];
  const rightHeaders = headersFor(lu?.tableId ?? "");
  const tabLabels = lookups.map((l, i) => {
    const name =
      tableOptions.find((t) => t.id === l.tableId)?.label ||
      `查找表 ${i + 1}`;
    return `${String.fromCharCode(66 + i)}. ${name}`;
  });

  return (
    <>
      <p className="hint step-hint-tight">
        以主表为准，从查找表补字段（如人员清单补岗位）。查找表多出来的行不会带入；两边都要保留请用「全量对表」。
      </p>
      <div className="step-inline-fields">
        <label className="step-inline-field">
          <span>表 A</span>
          <select
            value={op.leftTableId}
            onChange={(e) => {
              const leftTableId = e.target.value;
              const next = lookups.map((l) => {
                if (!leftTableId || !l.tableId) {
                  return { ...l, leftKey: "", rightKey: l.rightKey };
                }
                const guessed = guessJoinKeys(leftTableId, l.tableId);
                return {
                  ...l,
                  leftKey: guessed.baseKey,
                  rightKey: guessed.foreignKey || l.rightKey,
                };
              });
              patchLookups(next, { leftTableId, leftColumns: [] });
            }}
          >
            <option value="">请选择</option>
            {tableOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ColumnPickList
        label="主表要保留的列（不选 = 全部）"
        headers={leftHeaders}
        selected={op.leftColumns}
        onChange={(leftColumns) => onChange({ ...op, leftColumns })}
      />

      <div className="vlookup-lookups">
        <DraggableTabs
          ids={lookups.map((_, i) => `vlookup-${i}`)}
          labels={tabLabels}
          activeIndex={activeIndex}
          onSelect={setActiveLookup}
          onReorder={(from, to) => {
            const next = arrayMove(lookups, from, to);
            let nextActive = activeIndex;
            if (activeIndex === from) nextActive = to;
            else if (from < activeIndex && to >= activeIndex) {
              nextActive = activeIndex - 1;
            } else if (from > activeIndex && to <= activeIndex) {
              nextActive = activeIndex + 1;
            }
            setActiveLookup(nextActive);
            patchLookups(next);
          }}
          onDelete={(index) => {
            const next = lookups.filter((_, j) => j !== index);
            setActiveLookup(
              Math.max(
                0,
                Math.min(
                  index < activeIndex ? activeIndex - 1 : activeIndex,
                  next.length - 1,
                ),
              ),
            );
            patchLookups(next);
          }}
          onAdd={() => {
            patchLookups([
              ...lookups,
              { tableId: "", leftKey: "", rightKey: "", columns: [] },
            ]);
            setActiveLookup(lookups.length);
          }}
          addTitle="添加查找表"
        />

        {lu && (
          <div className="vlookup-lookup-panel">
            <div className="step-inline-fields">
              <label className="step-inline-field">
                <span>查找表</span>
                <select
                  value={lu.tableId}
                  onChange={(e) =>
                    updateLookup(activeIndex, {
                      tableId: e.target.value,
                      leftKey: "",
                      rightKey: "",
                      columns: [],
                    })
                  }
                >
                  <option value="">请选择</option>
                  {tableOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="step-inline-fields">
              <label className="step-inline-field">
                <span>表 A 匹配列</span>
                <SearchableSelect
                  value={lu.leftKey}
                  options={leftHeaders}
                  placeholder="搜索表 A 字段"
                  onChange={(leftKey) => updateLookup(activeIndex, { leftKey })}
                />
              </label>
              <label className="step-inline-field">
                <span>该表匹配列</span>
                <SearchableSelect
                  value={lu.rightKey}
                  options={rightHeaders}
                  placeholder="搜索查找表字段"
                  onChange={(rightKey) =>
                    updateLookup(activeIndex, { rightKey })
                  }
                />
              </label>
              <button
                type="button"
                className="step-add-btn"
                disabled={!op.leftTableId || !lu.tableId}
                onClick={() => {
                  const guessed = guessJoinKeys(op.leftTableId, lu.tableId);
                  updateLookup(activeIndex, {
                    leftKey: guessed.baseKey,
                    rightKey: guessed.foreignKey,
                  });
                }}
              >
                自动匹配
              </button>
            </div>
            {lu.tableId && (!lu.leftKey || !lu.rightKey) && (
              <p className="warn-inline">未自动找到共同列，请手动选择用来对齐的字段</p>
            )}
            {lu.leftKey && lu.rightKey && (
              <p className="hint step-hint-tight">
                当前按「{lu.leftKey}」=「{lu.rightKey}」查找
              </p>
            )}
            <ColumnPickList
              label="要从查找表补过来的列（不选 = 全部补到右侧）"
              headers={rightHeaders}
              selected={lu.columns}
              onChange={(columns) => updateLookup(activeIndex, { columns })}
            />
          </div>
        )}
      </div>
    </>
  );
}

function FullJoinEditor({
  op,
  tableOptions,
  headersFor,
  guessJoinKeys,
  onChange,
}: {
  op: Extract<Operation, { type: "fullJoin" }>;
  tableOptions: { id: string; label: string; headers: string[] }[];
  headersFor: (tableId: string) => string[];
  guessJoinKeys: (
    baseId: string,
    foreignId: string,
  ) => { baseKey: string; foreignKey: string };
  onChange: (op: Extract<Operation, { type: "fullJoin" }>) => void;
}) {
  const leftHeaders = headersFor(op.leftTableId);
  const rightHeaders = headersFor(op.rightTableId);

  return (
    <>
      <p className="hint step-hint-tight">
        两边名单都保留，方便核对「这边有、那边没有」的差异；对不上的一侧对应列会留空。
      </p>
      <div className="step-inline-fields">
        <label className="step-inline-field">
          <span>表 A</span>
          <select
            value={op.leftTableId}
            onChange={(e) => {
              const leftTableId = e.target.value;
              let leftKey = op.leftKey;
              let rightKey = op.rightKey;
              if (leftTableId && op.rightTableId) {
                const g = guessJoinKeys(leftTableId, op.rightTableId);
                leftKey = g.baseKey;
                rightKey = g.foreignKey || rightKey;
              }
              onChange({
                ...op,
                leftTableId,
                leftKey,
                rightKey,
                leftColumns: [],
              });
            }}
          >
            <option value="">请选择</option>
            {tableOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="step-inline-field">
          <span>表 B</span>
          <select
            value={op.rightTableId}
            onChange={(e) => {
              const rightTableId = e.target.value;
              let leftKey = op.leftKey;
              let rightKey = op.rightKey;
              if (op.leftTableId && rightTableId) {
                const g = guessJoinKeys(op.leftTableId, rightTableId);
                leftKey = g.baseKey || leftKey;
                rightKey = g.foreignKey;
              }
              onChange({
                ...op,
                rightTableId,
                leftKey,
                rightKey,
                rightColumns: [],
              });
            }}
          >
            <option value="">请选择</option>
            {tableOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="step-inline-fields">
        <label className="step-inline-field">
          <span>A 匹配列</span>
          <SearchableSelect
            value={op.leftKey}
            options={leftHeaders}
            placeholder="搜索表 A 字段"
            onChange={(leftKey) => onChange({ ...op, leftKey })}
          />
        </label>
        <label className="step-inline-field">
          <span>B 匹配列</span>
          <SearchableSelect
            value={op.rightKey}
            options={rightHeaders}
            placeholder="搜索表 B 字段"
            onChange={(rightKey) => onChange({ ...op, rightKey })}
          />
        </label>
        <button
          type="button"
          className="step-add-btn"
          disabled={!op.leftTableId || !op.rightTableId}
          onClick={() => {
            const g = guessJoinKeys(op.leftTableId, op.rightTableId);
            onChange({
              ...op,
              leftKey: g.baseKey,
              rightKey: g.foreignKey,
            });
          }}
        >
          自动匹配
        </button>
      </div>
      {op.leftTableId &&
        op.rightTableId &&
        (!op.leftKey || !op.rightKey) && (
          <p className="warn-inline">未自动找到共同列，请手动选择用来对齐的字段</p>
        )}
      <ColumnPickList
        label="表 A 要保留的列（不选 = 全部）"
        headers={leftHeaders}
        selected={op.leftColumns}
        onChange={(leftColumns) => onChange({ ...op, leftColumns })}
      />
      <ColumnPickList
        label="表 B 要保留的列（不选 = 全部）"
        headers={rightHeaders}
        selected={op.rightColumns}
        onChange={(rightColumns) => onChange({ ...op, rightColumns })}
      />
    </>
  );
}

function DraggableTabs({
  ids,
  labels,
  activeIndex,
  onSelect,
  onReorder,
  onDelete,
  onAdd,
  addTitle = "添加",
}: {
  ids: string[];
  labels: string[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onDelete: (index: number) => void;
  onAdd: () => void;
  addTitle?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(oldIndex, newIndex);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        <div className="calc-col-tabs">
          {ids.map((id, i) => (
            <SortableCalcTab
              key={id}
              id={id}
              label={labels[i] || `项 ${i + 1}`}
              active={activeIndex === i}
              canDelete={ids.length > 1}
              onSelect={() => onSelect(i)}
              onDelete={() => onDelete(i)}
            />
          ))}
          <button
            type="button"
            className="calc-col-tab add"
            title={addTitle}
            onClick={onAdd}
          >
            ＋
          </button>
        </div>
      </SortableContext>
    </DndContext>
  );
}

function CalcColumnTabs({
  columns,
  activeIndex,
  onSelect,
  onReorder,
  onDelete,
  onAdd,
}: {
  columns: { outputField: string; formula: string }[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onReorder: (
    columns: { outputField: string; formula: string }[],
    nextActive: number,
  ) => void;
  onDelete: (index: number) => void;
  onAdd: () => void;
}) {
  const ids = columns.map((_, i) => `calc-col-${i}`);
  const labels = columns.map(
    (col, i) => col.outputField?.trim() || `列 ${i + 1}`,
  );

  return (
    <DraggableTabs
      ids={ids}
      labels={labels}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onReorder={(from, to) => {
        const next = arrayMove(columns, from, to);
        let nextActive = activeIndex;
        if (activeIndex === from) nextActive = to;
        else if (from < activeIndex && to >= activeIndex) nextActive = activeIndex - 1;
        else if (from > activeIndex && to <= activeIndex) nextActive = activeIndex + 1;
        onReorder(next, nextActive);
      }}
      onDelete={onDelete}
      onAdd={onAdd}
      addTitle="添加计算列"
    />
  );
}

function SortableCalcTab({
  id,
  label,
  active,
  canDelete,
  onSelect,
  onDelete,
}: {
  id: string;
  label: string;
  active: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 2 : undefined,
      }}
      className={`calc-col-tab${active ? " active" : ""}${isDragging ? " dragging" : ""}`}
    >
      <button
        type="button"
        className="calc-col-tab-label"
        title={`${label}（拖拽排序）`}
        onClick={onSelect}
        {...attributes}
        {...listeners}
      >
        {label}
      </button>
      {canDelete && (
        <button
          type="button"
          className="calc-col-tab-del"
          title="删除此列"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function ColumnPickList({
  label,
  headers,
  selected,
  onChange,
  emptyHint = "无表头",
  showSelectedList = true,
  showSelectedCount = true,
  children,
}: {
  label: string;
  headers: string[];
  selected: string[];
  onChange: (cols: string[]) => void;
  emptyHint?: string;
  showSelectedList?: boolean;
  showSelectedCount?: boolean;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const filtered = fuzzyFilter(headers, query);

  return (
    <div className="field-block compact-pick">
      <div className="formula-ref-head compact-pick-head">
        <span className="compact-pick-label">{label}</span>
        <div className="compact-pick-toolbar">
          <button
            type="button"
            className="step-add-btn"
            onClick={() => {
              const next = [...selected];
              for (const h of filtered) {
                if (!next.includes(h)) next.push(h);
              }
              onChange(next);
            }}
          >
            {query.trim() ? "选中筛选" : "全选"}
          </button>
          <button
            type="button"
            className="step-add-btn danger"
            onClick={() => onChange([])}
          >
            清空已选列
          </button>
          <input
            className="formula-ref-search"
            value={query}
            placeholder="搜索列…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="chip-row wrap compact-pick-chips">
        {headers.length === 0 && (
          <span className="muted">{emptyHint}</span>
        )}
        {headers.length > 0 && filtered.length === 0 && (
          <span className="muted">无匹配</span>
        )}
        {filtered.map((h) => {
          const on = selected.includes(h);
          return (
            <button
              key={h}
              type="button"
              className={`chip-btn${on ? " active" : ""}`}
              onClick={() =>
                onChange(
                  on ? selected.filter((x) => x !== h) : [...selected, h],
                )
              }
            >
              {h}
            </button>
          );
        })}
      </div>
      {showSelectedList && selected.length > 0 && (
        <div className="compact-pick-selected-list">
          {showSelectedCount && (
            <div className="compact-pick-selected-label muted">
              已选 {selected.length} 列
            </div>
          )}
          <div className="chip-row wrap">
            {selected.map((h) => (
              <button
                key={h}
                type="button"
                className="chip-btn active compact-pick-selected-chip"
                title="点击取消选择"
                onClick={() => onChange(selected.filter((x) => x !== h))}
              >
                {h}
                <span className="compact-pick-selected-x" aria-hidden>
                  ×
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

function SideBySideEditor({
  gridRows,
  gridCols,
  cells,
  tableOptions,
  headerCache,
  headerGroupsCache,
  headersLoading,
  onChange,
}: {
  gridRows: number;
  gridCols: number;
  cells: SideBlock[];
  tableOptions: { id: string; label: string; headers: string[] }[];
  headerCache: Record<string, string[]>;
  headerGroupsCache: Record<string, number[]>;
  headersLoading?: Record<string, boolean>;
  onChange: (next: {
    gridRows: number;
    gridCols: number;
    cells: SideBlock[];
    gapCols: number;
    gapRows: number;
    blocks: SideBlock[];
    arrange: "grid";
    gridColumns: number;
  }) => void;
}) {
  const rows = Math.max(1, gridRows);
  const cols = Math.max(1, gridCols);
  const size = rows * cols;
  const normalized = useMemo(() => {
    const next = [...cells];
    while (next.length < size) next.push({ tableId: "", columns: [] });
    return next.slice(0, size);
  }, [cells, size]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function emit(
    nextCells: SideBlock[],
    partial?: Partial<{ gridRows: number; gridCols: number }>,
  ) {
    const r = partial?.gridRows ?? rows;
    const c = partial?.gridCols ?? cols;
    const target = r * c;
    let packed = [...nextCells];
    while (packed.length < target) packed.push({ tableId: "", columns: [] });
    packed = packed.slice(0, target);
    onChange({
      gridRows: r,
      gridCols: c,
      cells: packed,
      gapCols: 1,
      gapRows: 1,
      blocks: packed.filter((x) => x.tableId.trim()),
      arrange: "grid",
      gridColumns: c,
    });
  }

  function resize(nextRows: number, nextCols: number) {
    emit(normalized, { gridRows: nextRows, gridCols: nextCols });
  }

  function setCell(index: number, cell: SideBlock) {
    const copy = [...normalized];
    copy[index] = cell;
    emit(copy);
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = Number(String(active.id).replace("cell-", ""));
    const to = Number(String(over.id).replace("cell-", ""));
    if (Number.isNaN(from) || Number.isNaN(to)) return;
    const copy = [...normalized];
    const tmp = copy[from];
    copy[from] = copy[to];
    copy[to] = tmp;
    emit(copy);
  }

  return (
    <div className="field-block">
      <p className="hint step-hint-tight">
        设定行列后，在每个格子里选要对照的表；拖动手柄可对调位置。
      </p>
      <div className="side-grid-dims">
        <label className="side-grid-dim">
          <span>行数</span>
          <input
            type="number"
            min={1}
            max={12}
            value={rows}
            onChange={(e) =>
              resize(Math.max(1, Number(e.target.value) || 1), cols)
            }
          />
        </label>
        <label className="side-grid-dim">
          <span>列数</span>
          <input
            type="number"
            min={1}
            max={12}
            value={cols}
            onChange={(e) =>
              resize(rows, Math.max(1, Number(e.target.value) || 1))
            }
          />
        </label>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={normalized.map((_, i) => `cell-${i}`)}
          strategy={verticalListSortingStrategy}
        >
          <div
            className="side-grid"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(160px, 1fr))`,
            }}
          >
            {normalized.map((cell, i) => (
              <SortableSideCell
                key={`cell-${i}`}
                id={`cell-${i}`}
                cell={cell}
                tableOptions={tableOptions}
                headerCache={headerCache}
                headerGroupsCache={headerGroupsCache}
                headersLoading={headersLoading}
                onChange={(next) => setCell(i, next)}
                onClear={() => setCell(i, { tableId: "", columns: [] })}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableSideCell({
  id,
  cell,
  tableOptions,
  headerCache,
  headerGroupsCache,
  headersLoading,
  onChange,
  onClear,
}: {
  id: string;
  cell: SideBlock;
  tableOptions: { id: string; label: string; headers: string[] }[];
  headerCache: Record<string, string[]>;
  headerGroupsCache: Record<string, number[]>;
  headersLoading?: Record<string, boolean>;
  onChange: (cell: SideBlock) => void;
  onClear: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const headers =
    headerCache[cell.tableId] ??
    tableOptions.find((t) => t.id === cell.tableId)?.headers ??
    [];
  const groups = headerGroupsCache[cell.tableId] ?? [];
  const selected = cell.columns ?? [];
  const showHeaders =
    selected.length > 0
      ? selected
      : headers;
  const showGroups =
    selected.length > 0
      ? selected.map((h) => {
          const idx = headers.indexOf(h);
          return idx >= 0 ? (groups[idx] ?? 0) : 0;
        })
      : groups.length === headers.length
        ? groups
        : [];

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.75 : 1,
      }}
      className="side-grid-cell"
    >
      <div className="side-grid-cell-head">
        <button
          className="drag-handle"
          type="button"
          title="拖到其他格子交换"
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <select
          className="side-grid-table-select"
          value={cell.tableId}
          aria-label="选择表"
          onChange={(e) =>
            onChange({ tableId: e.target.value, columns: [] })
          }
        >
          <option value="">选择表</option>
          {tableOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {cell.tableId ? (
          <button type="button" className="ghost danger" onClick={onClear}>
            清空
          </button>
        ) : null}
      </div>
      {cell.tableId ? (
        <>
          <div className="side-grid-mini">
            <table>
              <thead>
                <tr>
                  {showHeaders.slice(0, 8).map((h, hi) => (
                    <th
                      key={`${h}-${hi}`}
                      style={styleForHeaderGroups(
                        showGroups.length ? showGroups : undefined,
                        hi,
                      )}
                    >
                      {h}
                    </th>
                  ))}
                  {showHeaders.length > 8 && <th>…</th>}
                </tr>
              </thead>
            </table>
            {headers.length === 0 && (
              <div className="muted">
                {cell.tableId && headersLoading?.[cell.tableId]
                  ? "正在加载列…"
                  : "无表头"}
              </div>
            )}
          </div>
          <div className="chip-row wrap">
            <button
              type="button"
              className={`chip-btn ${selected.length === 0 ? "active" : ""}`}
              onClick={() => onChange({ tableId: cell.tableId, columns: [] })}
            >
              全部列
            </button>
            {headers.map((h) => {
              const on = selected.includes(h);
              return (
                <button
                  key={h}
                  type="button"
                  className={`chip-btn ${on ? "active" : ""}`}
                  onClick={() => {
                    const next = on
                      ? selected.filter((c) => c !== h)
                      : [...selected, h];
                    onChange({ tableId: cell.tableId, columns: next });
                  }}
                >
                  {h}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function StepEditor({
  step,
  tableOptions,
  headerCache,
  headerGroupsCache,
  headersLoading = {},
  ensureTableHeaders,
  tableLabel,
  onPickOutputDir,
  onPickSourceDir,
  onRefreshSources,
  sourceScanning = false,
  sourceCount = 0,
  busyFlag = false,
  onChange,
  loadOutputSheetPreview,
}: {
  step: Step;
  tableOptions: { id: string; label: string; headers: string[] }[];
  headerCache: Record<string, string[]>;
  headerGroupsCache: Record<string, number[]>;
  headersLoading?: Record<string, boolean>;
  ensureTableHeaders?: (tableId: string) => Promise<void>;
  tableLabel: (id: string) => string;
  onPickOutputDir?: () => void;
  onPickSourceDir?: () => void;
  onRefreshSources?: () => void;
  sourceScanning?: boolean;
  sourceCount?: number;
  busyFlag?: boolean;
  onChange: (s: Step) => void;
  loadOutputSheetPreview?: (tableId: string) => Promise<PreviewData>;
}) {
  const [activeCalcCol, setActiveCalcCol] = useState(0);
  const [calcRefQuery, setCalcRefQuery] = useState("");
  const [calcHelpOpen, setCalcHelpOpen] = useState(false);
  const [readingInputs, setReadingInputs] = useState(false);
  const formulaInputRef = useRef<HTMLTextAreaElement | null>(null);
  const formulaSelRef = useRef<{ start: number; end: number } | null>(null);
  const headersFor = (tableId: string) =>
    headerCache[tableId] ??
    tableOptions.find((t) => t.id === tableId)?.headers ??
    [];
  const op = step.operation;

  useLayoutEffect(() => {
    if (!ensureTableHeaders) {
      setReadingInputs(false);
      return;
    }
    const ids = new Set(
      stepInputIds(step.operation)
        .map((id) => id.trim())
        .filter(Boolean),
    );
    if (step.operation.type === "calculate") {
      for (const t of tableOptions) ids.add(t.id);
    }
    if (step.operation.type === "output") {
      for (const sh of step.operation.sheets) {
        if (sh.tableId.trim()) ids.add(sh.tableId.trim());
      }
    }

    const missing = [...ids].filter((id) => {
      const has =
        (headerCache[id]?.length ?? 0) > 0 ||
        (tableOptions.find((t) => t.id === id)?.headers.length ?? 0) > 0;
      return !has;
    });

    if (missing.length === 0) {
      setReadingInputs(false);
      return;
    }

    let cancelled = false;
    setReadingInputs(true);
    void (async () => {
      await Promise.all(missing.map((id) => ensureTableHeaders(id)));
      if (!cancelled) setReadingInputs(false);
    })();

    return () => {
      cancelled = true;
    };
    // 仅在打开/切换步骤时读取；避免 headerCache 回填触发反复进入读取态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id, ensureTableHeaders]);

  const emptyHeadersHint = (tableId: string) =>
    tableId && (headersLoading[tableId] || readingInputs)
      ? "正在加载列…"
      : "无表头";

  const preferredKeys = [
    "业务员代码",
    "业务员编码",
    "人员代码",
    "工号",
    "代码",
    "编号",
    "ID",
    "id",
  ];

  const guessJoinKeys = (baseId: string, foreignId: string) => {
    const baseH = headersFor(baseId);
    const foreignH = headersFor(foreignId);
    for (const key of preferredKeys) {
      if (baseH.includes(key) && foreignH.includes(key)) {
        return { baseKey: key, foreignKey: key };
      }
    }
    const shared = baseH.find((h) => h.trim() && foreignH.includes(h));
    if (shared) return { baseKey: shared, foreignKey: shared };
    return { baseKey: "", foreignKey: "" };
  };

  const patchCalc = (
    columns: { outputField: string; formula: string }[],
  ) => {
    if (op.type !== "calculate") return;
    const first = columns[0] ?? { outputField: "计算结果", formula: "=" };
    onChange({
      ...step,
      operation: {
        ...op,
        columns,
        outputField: first.outputField,
        formula: first.formula,
        // 不再维护跨表关联：执行/导出时按公式自动解析
        joins: [],
      },
    });
  };

  const calcColumns =
    op.type === "calculate"
      ? op.columns?.length
        ? op.columns
        : [{ outputField: "计算结果", formula: "=" }]
      : [];

  const rememberFormulaSel = () => {
    const el = formulaInputRef.current;
    if (!el) return;
    formulaSelRef.current = {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    };
  };

  const spliceIntoFormula = (token: string) => {
    if (op.type !== "calculate") return;
    const columns = [...calcColumns];
    const idx = Math.min(Math.max(activeCalcCol, 0), columns.length - 1);
    const cur = columns[idx];
    let formula = cur.formula ?? "";
    if (!formula.startsWith("=")) formula = `=${formula}`;
    // formulaSelRef 相对「去掉前导 =」的编辑区
    const sel = formulaSelRef.current;
    const dispLen = Math.max(formula.length - 1, 0);
    const dStart = Math.min(Math.max(sel?.start ?? dispLen, 0), dispLen);
    const dEnd = Math.min(Math.max(sel?.end ?? dispLen, 0), dispLen);
    const start = dStart + 1;
    const end = dEnd + 1;
    const next = `${formula.slice(0, start)}${token}${formula.slice(end)}`;
    columns[idx] = { ...cur, formula: next };
    patchCalc(columns);
    const caret = dStart + token.length;
    formulaSelRef.current = { start: caret, end: caret };
    window.requestAnimationFrame(() => {
      const el = formulaInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const insertFormulaRef = (tableId: string, column: string) => {
    if (op.type !== "calculate") return;
    const token =
      tableId && tableId === op.baseTableId
        ? `[${column}]`
        : `[${tableId}!${column}]`;
    spliceIntoFormula(token);
  };

  const FORMULA_FX: { label: string; snippet: string }[] = [
    { label: "IF", snippet: 'IF(条件,"是","否")' },
    { label: "IFERROR", snippet: "IFERROR(值,0)" },
    { label: "OR", snippet: "OR(条件1,条件2)" },
    { label: "AND", snippet: "AND(条件1,条件2)" },
    { label: "SUMIF", snippet: "SUMIF([表!条件列],条件,[表!求和列])" },
    { label: "COUNTIF", snippet: "COUNTIF([表!列],条件)" },
    { label: "LEFT", snippet: "LEFT([列],2)" },
    { label: "RIGHT", snippet: "RIGHT([列],2)" },
    { label: "MID", snippet: "MID([列],1,2)" },
    { label: "FIND", snippet: 'FIND("关键字",[列])' },
    { label: "TRIM", snippet: "TRIM([列])" },
    { label: "CONCAT", snippet: '[列1]&"_"&[列2]' },
    { label: "ROUND", snippet: "ROUND([列],2)" },
    { label: "TODAY", snippet: "TODAY()" },
  ];

  return (
    <div className="editor-body step-sheet">
      {readingInputs ? (
        <div className="step-modal-reading" role="status" aria-live="polite">
          <div className="step-modal-reading-spin" aria-hidden />
          <p>正在读取表结构…</p>
          <p className="muted">请稍候，读取完成后即可配置</p>
        </div>
      ) : (
        <>
      {op.type === "filter" && (
        <>
          <div className="step-inline-fields">
            <label className="step-inline-field">
              <span>数据表</span>
              <select
                value={op.inputTableId}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: { ...op, inputTableId: e.target.value },
                  })
                }
              >
                <option value="">请选择</option>
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="filter-conditions">
            {op.conditions.map((c, i) => (
              <div
                className={`cond-row${i > 0 ? " has-join" : ""}`}
                key={i}
              >
                {i > 0 && (
                  <select
                    className="cond-join-select"
                    value={c.join === "or" ? "or" : "and"}
                    title="与上一条件的关系"
                    onChange={(e) => {
                      const join = e.target.value === "or" ? "or" : "and";
                      const conditions = [...op.conditions];
                      conditions[i] = { ...c, join };
                      onChange({
                        ...step,
                        operation: { ...op, conditions },
                      });
                    }}
                  >
                    <option value="and">且</option>
                    <option value="or">或</option>
                  </select>
                )}
                <SearchableSelect
                  value={c.column}
                  options={headersFor(op.inputTableId)}
                  placeholder="列名"
                  onChange={(column) => {
                    const conditions = [...op.conditions];
                    conditions[i] = { ...c, column };
                    onChange({ ...step, operation: { ...op, conditions } });
                  }}
                />
                <select
                  value={c.op}
                  onChange={(e) => {
                    const conditions = [...op.conditions];
                    conditions[i] = { ...c, op: e.target.value as FilterOp };
                    onChange({ ...step, operation: { ...op, conditions } });
                  }}
                >
                  <option value="not_contains">不包含</option>
                  <option value="contains">包含</option>
                  <option value="eq">等于</option>
                  <option value="neq">不等于</option>
                  <option value="empty">为空</option>
                  <option value="not_empty">非空</option>
                </select>
                {c.op !== "empty" && c.op !== "not_empty" ? (
                  <div className="cond-value-wrap">
                    <input
                      value={c.value}
                      placeholder="值或 ${月份} 等参数"
                      onChange={(e) => {
                        const conditions = [...op.conditions];
                        conditions[i] = { ...c, value: e.target.value };
                        onChange({
                          ...step,
                          operation: { ...op, conditions },
                        });
                      }}
                    />
                  </div>
                ) : (
                  <span className="cond-spacer" />
                )}
                <button
                  type="button"
                  className="cond-remove"
                  onClick={() =>
                    onChange({
                      ...step,
                      operation: {
                        ...op,
                        conditions: op.conditions.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="step-add-btn"
              onClick={() =>
                onChange({
                  ...step,
                  operation: {
                    ...op,
                    conditions: [
                      ...op.conditions,
                      {
                        column: "",
                        op: "not_contains",
                        value: "",
                        join: "and",
                      },
                    ],
                  },
                })
              }
            >
              ＋ 条件
            </button>
            {op.conditions.length > 1 && (
              <p className="hint step-hint-tight">
                多个条件可用「且 / 或」组合：连续「且」是一组，组与组之间用「或」连接。
              </p>
            )}
          </div>
        </>
      )}

      {op.type === "pivot" && (
        <>
          <p className="hint step-hint-tight">
            按机构、人员等维度汇总金额或笔数，做成汇总表。先选分组用的「行字段」，再选要求和/计数的「值字段」。
          </p>
          <div className="step-inline-fields">
            <label className="step-inline-field">
              <span>数据表</span>
              <select
                value={op.inputTableId}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: { ...op, inputTableId: e.target.value },
                  })
                }
              >
                <option value="">请选择</option>
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ColumnPickList
            label="行字段（按什么分组，如机构、人员）"
            headers={headersFor(op.inputTableId)}
            selected={op.rowFields}
            emptyHint={emptyHeadersHint(op.inputTableId)}
            showSelectedCount={false}
            onChange={(rowFields) =>
              onChange({ ...step, operation: { ...op, rowFields } })
            }
          />
          <ColumnPickList
            label="值字段（汇总什么，如保费、人数）"
            headers={headersFor(op.inputTableId)}
            selected={op.valueFields.map((v) => v.field)}
            emptyHint={emptyHeadersHint(op.inputTableId)}
            showSelectedList={false}
            onChange={(fields) => {
              const prev = new Map(
                op.valueFields.map((v) => [v.field, v] as const),
              );
              const valueFields = fields.map(
                (field) =>
                  prev.get(field) ?? {
                    field,
                    aggregation: "sum",
                    alias: "",
                  },
              );
              onChange({ ...step, operation: { ...op, valueFields } });
            }}
          >
            {op.valueFields.length > 0 && (
              <div className="value-agg-list">
                {op.valueFields.map((v, i) => (
                  <div className="value-agg-row" key={`${v.field}-${i}`}>
                    <span className="chip">{v.field}</span>
                    <select
                      value={v.aggregation}
                      onChange={(e) => {
                        const valueFields = [...op.valueFields];
                        valueFields[i] = {
                          ...v,
                          aggregation: e.target.value,
                        };
                        onChange({
                          ...step,
                          operation: { ...op, valueFields },
                        });
                      }}
                    >
                      <option value="sum">求和</option>
                      <option value="count">计数</option>
                      <option value="avg">平均</option>
                    </select>
                    <button
                      type="button"
                      className="cond-remove"
                      title="移除值字段"
                      onClick={() =>
                        onChange({
                          ...step,
                          operation: {
                            ...op,
                            valueFields: op.valueFields.filter(
                              (_, j) => j !== i,
                            ),
                          },
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ColumnPickList>
        </>
      )}

      {op.type === "calculate" && (
        <>
          <div className="step-inline-fields">
            <label className="step-inline-field">
              <span>数据表</span>
              <select
                value={op.baseTableId}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: { ...op, baseTableId: e.target.value },
                  })
                }
              >
                <option value="">请选择</option>
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="calc-editor">
            <CalcColumnTabs
              columns={calcColumns}
              activeIndex={activeCalcCol}
              onSelect={setActiveCalcCol}
              onReorder={(columns, nextActive) => {
                setActiveCalcCol(nextActive);
                patchCalc(columns);
              }}
              onDelete={(index) => {
                const columns = calcColumns.filter((_, j) => j !== index);
                setActiveCalcCol(
                  Math.max(
                    0,
                    Math.min(
                      index < activeCalcCol ? activeCalcCol - 1 : activeCalcCol,
                      columns.length - 1,
                    ),
                  ),
                );
                patchCalc(columns);
              }}
              onAdd={() => {
                const columns = [
                  ...calcColumns,
                  {
                    outputField: `计算结果${calcColumns.length + 1}`,
                    formula: "=",
                  },
                ];
                setActiveCalcCol(columns.length - 1);
                patchCalc(columns);
              }}
            />

            {(() => {
              const i = Math.min(
                Math.max(activeCalcCol, 0),
                Math.max(calcColumns.length - 1, 0),
              );
              const col = calcColumns[i] ?? {
                outputField: "计算结果",
                formula: "=",
              };
              return (
                <div className="formula-bar">
                  <div className="formula-bar-top">
                    <input
                      className="formula-bar-name"
                      value={col.outputField}
                      placeholder="列名"
                      title="结果里这一列的名称"
                      onChange={(e) => {
                        const columns = [...calcColumns];
                        columns[i] = {
                          ...col,
                          outputField: e.target.value,
                        };
                        patchCalc(columns);
                      }}
                    />
                    <select
                      className="formula-bar-fx"
                      value=""
                      title="插入函数"
                      onChange={(e) => {
                        const snippet = e.target.value;
                        if (!snippet) return;
                        spliceIntoFormula(snippet);
                      }}
                    >
                      <option value="">fx</option>
                      {FORMULA_FX.map((f) => (
                        <option key={f.label} value={f.snippet}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="formula-bar-expr-wrap">
                    <span className="formula-bar-eq" aria-hidden>
                      =
                    </span>
                    <textarea
                      ref={formulaInputRef}
                      className="formula-bar-expr"
                      rows={4}
                      value={(col.formula || "=").replace(/^=/, "")}
                      placeholder='IF([发票号码]<>"",[发票号码],[数电发票号码])'
                      spellCheck={false}
                      onSelect={rememberFormulaSel}
                      onClick={rememberFormulaSel}
                      onKeyUp={rememberFormulaSel}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const formula = raw.startsWith("=") ? raw : `=${raw}`;
                        const columns = [...calcColumns];
                        columns[i] = { ...col, formula };
                        patchCalc(columns);
                        formulaSelRef.current = {
                          start: e.target.selectionStart ?? raw.length,
                          end: e.target.selectionEnd ?? raw.length,
                        };
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            <div className="formula-ref-panel">
              <div className="formula-ref-head">
                <span>插入列引用</span>
                <input
                  className="formula-ref-search"
                  value={calcRefQuery}
                  placeholder="搜索列名…"
                  onChange={(e) => setCalcRefQuery(e.target.value)}
                />
              </div>
              <div className="formula-ref-body">
                {tableOptions.map((t) => {
                  const headers = (headerCache[t.id] ?? t.headers).filter(
                    (h) => {
                      const q = calcRefQuery.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        h.toLowerCase().includes(q) ||
                        t.label.toLowerCase().includes(q)
                      );
                    },
                  );
                  if (calcRefQuery.trim() && headers.length === 0) return null;
                  const isBase = t.id === op.baseTableId;
                  return (
                    <div
                      key={t.id}
                      className={`formula-ref-table${isBase ? " is-base" : ""}`}
                    >
                      <div className="formula-ref-table-name">
                        {t.label}
                        {isBase ? " · 本表" : ""}
                      </div>
                      <div className="chip-row wrap">
                        {headers.map((h) => (
                          <button
                            key={h}
                            type="button"
                            className="chip-btn"
                            title={
                              isBase
                                ? `插入 [${h}]`
                                : `插入 [${t.id}!${h}]`
                            }
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertFormulaRef(t.id, h)}
                          >
                            {h}
                          </button>
                        ))}
                        {headers.length === 0 && (
                          <span className="muted">
                            {emptyHeadersHint(t.id)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              className="calc-help-toggle"
              onClick={() => setCalcHelpOpen((v) => !v)}
            >
              {calcHelpOpen ? "收起说明" : "公式说明"}
            </button>
            {calcHelpOpen && (
              <p className="hint calc-help">
                以 <code>=</code> 开头写公式即可新增业务列。本表字段写{" "}
                <code>[列名]</code>，其他表写 <code>[表!列名]</code>
                。常用：判断、求和计数、截取文本、找关键字、日期等；跨表会按关联键自动对齐。
                例：发票号为空时用数电票号——
                <code>
                  =IF([发票号码]&lt;&gt;&quot;&quot;,[发票号码],[数电发票号码])
                </code>
              </p>
            )}
          </div>
        </>
      )}

      {op.type === "sort" && (
        <>
          <div className="step-inline-fields">
            <label className="step-inline-field">
              <span>数据表</span>
              <select
                value={op.inputTableId}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: { ...op, inputTableId: e.target.value },
                  })
                }
              >
                <option value="">请选择</option>
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="field-block">
            <div className="field-label">排序（可按多列，如先机构再保费）</div>
            {op.keys.map((k, i) => (
              <div className="value-agg-row" key={i}>
                <SearchableSelect
                  value={k.column}
                  options={headersFor(op.inputTableId)}
                  placeholder="列名"
                  onChange={(column) => {
                    const keys = [...op.keys];
                    keys[i] = { ...k, column };
                    onChange({ ...step, operation: { ...op, keys } });
                  }}
                />
                <select
                  value={k.direction}
                  onChange={(e) => {
                    const keys = [...op.keys];
                    keys[i] = {
                      ...k,
                      direction: e.target.value as "asc" | "desc",
                    };
                    onChange({ ...step, operation: { ...op, keys } });
                  }}
                >
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                </select>
                <button
                  type="button"
                  className="cond-remove"
                  onClick={() =>
                    onChange({
                      ...step,
                      operation: {
                        ...op,
                        keys: op.keys.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="step-add-btn"
              onClick={() =>
                onChange({
                  ...step,
                  operation: {
                    ...op,
                    keys: [...op.keys, { column: "", direction: "asc" }],
                  },
                })
              }
            >
              ＋ 排序字段
            </button>
          </div>
        </>
      )}

      {op.type === "dedupe" && (
        <>
          <p className="hint step-hint-tight">
            名单或清单里若有重复，只留最先出现的一条。选出用来判断「算不算同一条」的列即可：例如只选「证件号」，证件号相同就去重；不选则整行内容都相同才去重。
          </p>
          <div className="step-inline-fields">
            <label className="step-inline-field">
              <span>数据表</span>
              <select
                value={op.inputTableId}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: {
                      ...op,
                      inputTableId: e.target.value,
                      columns: [],
                    },
                  })
                }
              >
                <option value="">请选择</option>
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ColumnPickList
            label="用来判断是否同一条的列（不选 = 整行都相同才算重复）"
            headers={headersFor(op.inputTableId)}
            selected={op.columns}
            emptyHint={emptyHeadersHint(op.inputTableId)}
            onChange={(columns) =>
              onChange({ ...step, operation: { ...op, columns } })
            }
          />
        </>
      )}

      {op.type === "sideBySide" && (
        <SideBySideEditor
          gridRows={op.gridRows ?? 1}
          gridCols={op.gridCols ?? op.gridColumns ?? 2}
          cells={op.cells ?? []}
          tableOptions={tableOptions}
          headerCache={headerCache}
          headerGroupsCache={headerGroupsCache}
          headersLoading={headersLoading}
          onChange={(next) =>
            onChange({
              ...step,
              operation: {
                ...op,
                ...next,
                columns: [],
                tableIds: [],
              },
            })
          }
        />
      )}

      {op.type === "vlookup" && (
        <VlookupEditor
          op={op}
          tableOptions={tableOptions}
          headersFor={headersFor}
          guessJoinKeys={guessJoinKeys}
          onChange={(next) => onChange({ ...step, operation: next })}
        />
      )}

      {op.type === "fullJoin" && (
        <FullJoinEditor
          op={op}
          tableOptions={tableOptions}
          headersFor={headersFor}
          guessJoinKeys={guessJoinKeys}
          onChange={(next) => onChange({ ...step, operation: next })}
        />
      )}

      {op.type === "lookupSubtract" && (
        <p className="hint">
          这是旧版步骤，建议删掉后改用「计算」重新配置业务差额或对比列。
        </p>
      )}

      {op.type === "start" && (
        <>
          <label className="grow">
            源表文件夹
            <div className="path-row">
              <input
                value={op.sourceDir}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: { ...op, sourceDir: e.target.value },
                  })
                }
                placeholder="选择源数据目录"
              />
              <button type="button" onClick={() => onPickSourceDir?.()}>
                浏览
              </button>
              <button
                type="button"
                disabled={!op.sourceDir.trim() || sourceScanning || busyFlag}
                onClick={() => onRefreshSources?.()}
              >
                {sourceScanning ? "…" : "刷新"}
              </button>
            </div>
          </label>
          <p className="hint">
            {sourceCount > 0
              ? `已找到 ${sourceCount} 张源表，显示在画布上；点源表节点可确认表头。`
              : "选好文件夹并刷新后，源表会出现在画布上。"}
          </p>
        </>
      )}

      {op.type === "output" && (
        <>
          <label className="grow">
            输出目录
            <div className="path-row">
              <input
                value={op.outputDir}
                onChange={(e) =>
                  onChange({
                    ...step,
                    operation: { ...op, outputDir: e.target.value },
                  })
                }
                placeholder="结果 Excel 输出位置"
              />
              <button type="button" onClick={() => onPickOutputDir?.()}>
                浏览
              </button>
            </div>
          </label>
          <div className="field-block">
            <div className="field-label">结果 Sheet</div>
            <OutputSheetList
              sheets={op.sheets}
              tableLabel={tableLabel}
              loadPreview={loadOutputSheetPreview}
              onReorder={(sheets) =>
                onChange({ ...step, operation: { ...op, sheets } })
              }
              onRename={(tableId, sheetName) =>
                onChange({
                  ...step,
                  operation: {
                    ...op,
                    sheets: op.sheets.map((s) =>
                      s.tableId === tableId ? { ...s, sheetName } : s,
                    ),
                  },
                })
              }
              onRemove={(tableId) =>
                onChange({
                  ...step,
                  operation: {
                    ...op,
                    sheets: op.sheets.filter((s) => s.tableId !== tableId),
                  },
                })
              }
            />
            {(() => {
              const names = op.sheets
                .map((o) => o.sheetName.trim())
                .filter(Boolean);
              const dup = names.find((n, i) => names.indexOf(n) !== i);
              return dup ? (
                <p className="warn-inline">
                  Sheet 名称「{dup}」重复，请修改后再执行
                </p>
              ) : null;
            })()}
            {op.sheets.length === 0 && (
              <p className="hint">
                把筛选、计算等步骤的结果连到本节点，或勾选步骤上的「输出为 Sheet」。
              </p>
            )}
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
