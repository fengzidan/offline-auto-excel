import { useCallback, useEffect, useMemo, useState } from "react";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  copyScheme,
  deleteScheme,
  executePipeline,
  exportFormulaTemplate,
  listSchemes,
  loadScheme,
  peekRawSheet,
  previewSourceTable,
  previewStep,
  saveScheme,
  scanSourceDir,
} from "./api";
import {
  createEmptyPipeline,
  createNicheDemoSteps,
  createStep,
  syncOutputSheets,
  type ExecuteResult,
  type FilterOp,
  type Operation,
  type OutputSheet,
  type Pipeline,
  type PreviewData,
  type RawSheetPreview,
  type SchemeSummary,
  type SourceTable,
  type Step,
} from "./types";
import "./App.css";

function isFolderSource(t: SourceTable) {
  return t.kind === "folder";
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

function opLabel(op: Operation): string {
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
      return "列去重";
    case "lookupSubtract":
      return "计算(旧)";
    case "sideBySide":
      return "拼版";
    case "vlookup":
      return "表对表";
  }
}

function PreviewTable({ data }: { data: PreviewData | null }) {
  if (!data) return <div className="muted pad-sm">暂无预览</div>;
  const groups = data.headerGroups ?? [];
  const useGroups =
    groups.length === data.headers.length &&
    groups.some((g) => g !== groups[0]);
  const palette = [
    { bg: "#ED7D31", fg: "#fff" },
    { bg: "#5B9BD5", fg: "#fff" },
    { bg: "#70AD47", fg: "#fff" },
    { bg: "#7030A0", fg: "#fff" },
    { bg: "#C45911", fg: "#fff" },
    { bg: "#00B0F0", fg: "#fff" },
    { bg: "#FFC000", fg: "#333" },
    { bg: "#A9D08E", fg: "#333" },
  ];
  const groupOrder: number[] = [];
  for (const g of groups) {
    if (!groupOrder.includes(g)) groupOrder.push(g);
  }
  const styleFor = (i: number) => {
    if (!useGroups) return undefined;
    const g = groups[i] ?? 0;
    const idx = Math.max(0, groupOrder.indexOf(g));
    const c = palette[idx % palette.length];
    return { background: c.bg, color: c.fg };
  };

  return (
    <div className="preview-wrap">
      <div className="muted">
        共 {data.totalRows} 行，预览前 {data.rows.length} 行
        {useGroups ? " · 表头按来源表分色" : ""}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {data.headers.map((h, i) => (
                <th key={`${h}-${i}`} style={styleFor(i)}>
                  {h || "(空列)"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, ri) => (
              <tr key={ri}>
                {data.headers.map((_, ci) => (
                  <td key={ci}>{row[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortableStepItem({
  step,
  active,
  onSelect,
}: {
  step: Step;
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: step.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`step-item ${active ? "active" : ""}`}
      onClick={onSelect}
    >
      <button className="drag-handle" type="button" {...attributes} {...listeners}>
        ⋮⋮
      </button>
      <div className="step-item-body">
        <div className="step-title">{step.name}</div>
        <div className="step-meta">
          {opLabel(step.operation)}
          {step.result?.enabled ? " · 结果" : ""}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [schemes, setSchemes] = useState<SchemeSummary[]>([]);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [sources, setSources] = useState<SourceTable[]>([]);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
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
    | { type: "unsaved"; nextId: string }
    | null
  >(null);
  const [dialogInput, setDialogInput] = useState("未命名方案");
  const [status, setStatus] = useState("就绪");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [headerCache, setHeaderCache] = useState<Record<string, string[]>>({});
  const [lastExport, setLastExport] = useState<ExecuteResult | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const activeStep = useMemo(
    () => pipeline?.steps.find((s) => s.id === activeStepId) ?? null,
    [pipeline, activeStepId],
  );

  const activeSource = useMemo(
    () => sources.find((s) => s.id === activeSourceId) ?? null,
    [sources, activeSourceId],
  );

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

  const refreshSchemeList = useCallback(async () => {
    try {
      setSchemes(await listSchemes());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refreshSchemeList();
  }, [refreshSchemeList]);

  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  async function refreshSources(p: Pipeline) {
    if (!p.sourceDir) {
      setSources([]);
      return;
    }
    setScanning(true);
    setError(null);
    try {
      const tables = await scanSourceDir(p.sourceDir, p.headerRows ?? {});
      setSources(tables);
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
        updatePipeline((prev) => ({ ...prev, folderMerges: merges }));
      }
      const need = tables.filter((t) => !t.headerOk);
      if (need.length) {
        setStatus(`已扫描 ${tables.length} 张表，${need.length} 张需手动指定表头行`);
        setActiveSourceId(need[0].id);
        setSourceCollapsed(false);
      } else {
        setStatus(`已扫描 ${tables.length} 张源表（大表仅在预览/执行时完整加载）`);
        if (!activeSourceId && tables[0]) setActiveSourceId(tables[0].id);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (!pipeline?.sourceDir) return;
    const t = setTimeout(() => void refreshSources(pipeline), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.sourceDir, pipeline?.headerRows]);

  function updatePipeline(updater: (p: Pipeline) => Pipeline) {
    setPipeline((prev) => {
      if (!prev) return prev;
      setDirty(true);
      return updater(prev);
    });
  }

  async function createSchemeWithName(name: string) {
    const p = createEmptyPipeline(name.trim() || "未命名方案");
    setBusy(true);
    setError(null);
    try {
      const saved = await saveScheme(p);
      setPipeline(saved);
      setDirty(false);
      setActiveStepId(null);
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

  async function openScheme(id: string) {
    setBusy(true);
    setError(null);
    try {
      const loaded = await loadScheme(id);
      if (!loaded.headerRows) loaded.headerRows = {};
      if (!loaded.outputSheets) loaded.outputSheets = [];
      if (!loaded.folderMerges) loaded.folderMerges = {};
      loaded.outputSheets = syncOutputSheets(loaded);
      setPipeline(loaded);
      setDirty(false);
      setActiveStepId(loaded.steps[0]?.id ?? null);
      setSourcePreview(null);
      setStepPreview(null);
      setRawPreview(null);
      setMappingTableId(null);
      setDialog(null);
      setStatus(`已打开「${loaded.name}」`);
    } catch (e) {
      setError(String(e));
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

  async function handleSave() {
    if (!pipeline) return;
    setBusy(true);
    try {
      const saved = await saveScheme(pipeline);
      setPipeline(saved);
      setDirty(false);
      await refreshSchemeList();
      setStatus("方案已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
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
      try {
        await saveScheme(pipeline);
        setDirty(false);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    await openScheme(nextId);
  }

  async function pickSourceDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string" || !pipeline) return;
    updatePipeline((p) => ({ ...p, sourceDir: selected }));
    setSourceCollapsed(false);
  }

  async function pickOutputDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string" || !pipeline) return;
    updatePipeline((p) => ({ ...p, outputDir: selected }));
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
      setHeaderCache((prev) => ({ ...prev, [table.id]: data.headers }));
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
    updatePipeline((p) => ({
      ...p,
      headerRows: { ...p.headerRows, [table.path]: pickedHeaderRow },
    }));
    setBusy(true);
    try {
      const nextRows = {
        ...pipeline.headerRows,
        [table.path]: pickedHeaderRow,
      };
      const tables = await scanSourceDir(pipeline.sourceDir, nextRows);
      setSources(tables);
      setPipeline((p) =>
        p ? { ...p, headerRows: nextRows } : p,
      );
      setDirty(true);
      const updated = tables.find((t) => t.id === mappingTableId);
      setMappingTableId(null);
      setRawPreview(null);
      if (updated?.headerOk) {
        const data = await previewSourceTable(updated.path, pickedHeaderRow, 40, {
          keyColumn: pipeline.folderMerges?.[updated.id]?.keyColumn,
          headerRows: nextRows,
        });
        setSourcePreview(data);
        setHeaderCache((prev) => ({ ...prev, [updated.id]: data.headers }));
        setStatus(`已将「${updated.name}」表头设为第 ${pickedHeaderRow} 行`);
      } else {
        setError(updated?.headerMessage || "表头仍无效，请换一行");
        if (updated) await openHeaderMapping(updated);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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
      setHeaderCache((prev) => ({ ...prev, [table.id]: data.headers }));
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

  function addStep(type: Operation["type"]) {
    if (!pipeline) return;
    const step = createStep(type, sources.find((s) => s.headerOk)?.id ?? "");
    updatePipeline((p) => ({ ...p, steps: [...p.steps, step] }));
    setActiveStepId(step.id);
    setActiveSourceId(null);
  }

  function updateStep(id: string, updater: (s: Step) => Step) {
    updatePipeline((p) => {
      const steps = p.steps.map((s) => (s.id === id ? updater(s) : s));
      const next = { ...p, steps };
      return { ...next, outputSheets: syncOutputSheets(next) };
    });
  }

  function removeStep(id: string) {
    updatePipeline((p) => {
      const next = {
        ...p,
        steps: p.steps.filter((s) => s.id !== id),
      };
      return { ...next, outputSheets: syncOutputSheets(next) };
    });
    if (activeStepId === id) setActiveStepId(null);
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !pipeline) return;
    updatePipeline((p) => {
      const oldIndex = p.steps.findIndex((s) => s.id === active.id);
      const newIndex = p.steps.findIndex((s) => s.id === over.id);
      return { ...p, steps: arrayMove(p.steps, oldIndex, newIndex) };
    });
  }

  async function runPreviewStep() {
    if (!pipeline || !activeStep) return;
    setBusy(true);
    setError(null);
    try {
      const data = await previewStep(pipeline, activeStep.id, 40);
      setStepPreview(data);
      setHeaderCache((prev) => ({
        ...prev,
        [activeStep.outputTableId]: data.headers,
      }));
      setStatus(`预览步骤「${activeStep.name}」`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runExecute() {
    if (!pipeline) return;
    setBusy(true);
    setError(null);
    setLastExport(null);
    try {
      const saved = await saveScheme(pipeline);
      setPipeline(saved);
      setDirty(false);
      const result = await executePipeline(saved);
      setLastExport(result);
      setStatus(result.message);
      await refreshSchemeList();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openResultFile(path: string) {
    try {
      await openPath(path);
    } catch (e) {
      setError(`无法打开文件：${e}`);
    }
  }

  async function revealResultFile(path: string) {
    try {
      await revealItemInDir(path);
    } catch (e) {
      setError(`无法在访达中显示：${e}`);
    }
  }

  async function runExportTemplate() {
    if (!pipeline) return;
    const path = await save({
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
      defaultPath: `${pipeline.name || "公式模板"}_template.xlsx`,
    });
    if (!path) return;
    setBusy(true);
    try {
      const out = await exportFormulaTemplate(pipeline, path);
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
      return { ...next, outputSheets: syncOutputSheets(next) };
    });
    setActiveStepId(steps[0]?.id ?? null);
    setStatus("已填入示例步骤，请核对表与列");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">AE</span>
          <div>
            <h1>Auto Excel</h1>
            <p>方案编排 · 本地离线</p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" className="primary" onClick={() => void handleNewScheme()}>
            新建方案
          </button>
          <button type="button" disabled={!pipeline || busy} onClick={() => void handleSave()}>
            保存{dirty ? " *" : ""}
          </button>
          <button type="button" disabled={!pipeline || busy} onClick={() => void runExecute()}>
            执行生成
          </button>
          <button
            type="button"
            disabled={!pipeline || busy}
            onClick={() => void runExportTemplate()}
          >
            导出公式模板
          </button>
        </div>
      </header>

      <div className="main">
        <aside className="scheme-rail">
          <div className="rail-head">方案列表</div>
          <div className="scheme-list">
            {schemes.length === 0 && (
              <div className="muted pad-sm">暂无方案，点击上方「新建方案」</div>
            )}
            {schemes.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`scheme-item ${pipeline?.id === s.id ? "active" : ""}`}
                onClick={() => void handleSelectScheme(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, id: s.id });
                }}
              >
                <strong>{s.name}</strong>
                <span>{s.updatedAt || "—"}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="workspace">
          {!pipeline ? (
            <div className="empty-state">
              <h2>选择或新建方案</h2>
              <p>左侧为方案列表；右侧将展示源表识别与步骤编排。</p>
            </div>
          ) : (
            <>
              <div className="scheme-title-row">
                <label>
                  方案名称
                  <input
                    value={pipeline.name}
                    onChange={(e) =>
                      updatePipeline((p) => ({ ...p, name: e.target.value }))
                    }
                  />
                </label>
              </div>

              <div className={`source-block ${sourceCollapsed ? "collapsed" : ""}`}>
                <div className="block-head">
                  <button
                    type="button"
                    className="collapse-btn"
                    onClick={() => setSourceCollapsed((v) => !v)}
                  >
                    {sourceCollapsed ? "▸" : "▾"} 源表
                  </button>
                  <div className="path-row grow">
                    <input
                      value={pipeline.sourceDir}
                      onChange={(e) =>
                        updatePipeline((p) => ({
                          ...p,
                          sourceDir: e.target.value,
                        }))
                      }
                      placeholder="第一步：选择源数据目录"
                    />
                    <button type="button" onClick={() => void pickSourceDir()}>
                      浏览
                    </button>
                    <button
                      type="button"
                      disabled={!pipeline.sourceDir || scanning || busy}
                      onClick={() => void refreshSources(pipeline)}
                    >
                      {scanning ? "扫描中…" : "刷新"}
                    </button>
                  </div>
                </div>

                {!sourceCollapsed && (
                  <div className="source-body">
                    <div className="source-list">
                      {sources.length === 0 && (
                        <div className="muted pad-sm">选择目录并刷新后显示表</div>
                      )}
                      {sources.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`source-item ${activeSourceId === t.id ? "active" : ""} ${!t.headerOk ? "warn" : ""}`}
                          onClick={() => void openSourcePreview(t)}
                        >
                          <strong>
                            {isFolderSource(t) ? `${t.name}（累计）` : t.name}
                          </strong>
                          <span>
                            {!t.headerOk
                              ? "未识别表头，点击映射"
                                : isFolderSource(t)
                                  ? `${t.fileCount ?? 0} 个文件 · 约 ${t.rowCount} 行（预览用最新文件）`
                                  : `${t.rowCount} 行 · ${t.headers.length} 列 · 表头第${t.headerRow}行`}
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="source-preview">
                      {mappingTableId && rawPreview ? (
                        <div className="header-map">
                          <div className="warn-banner">
                            {activeSource && isFolderSource(activeSource)
                              ? "累计文件夹：以下为最新文件的前几行，确认的表头行将用于该文件夹内全部文件"
                              : "未识别到有效表头"}
                            {activeSource?.headerMessage
                              ? `：${activeSource.headerMessage}`
                              : activeSource && isFolderSource(activeSource)
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
                          {activeSource && isFolderSource(activeSource) && (
                            <div className="folder-merge-bar">
                              <label>
                                覆盖键列（相同值保留最新一天）
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
                                预览只读最新一个文件；执行生成时按日期合并全部文件，同一覆盖键保留最新行，并增加「来源日期」。若某文件缺列或无法读取，会报错并中止。
                                {activeSource.headerMessage
                                  ? ` ${activeSource.headerMessage}`
                                  : ""}
                              </p>
                            </div>
                          )}
                          <PreviewTable data={sourcePreview} />
                        </>
                      )}
                      {activeSource?.headerOk && !mappingTableId && (
                        <div className="preview-actions">
                          <button
                            type="button"
                            onClick={() =>
                              activeSource && void openHeaderMapping(activeSource)
                            }
                          >
                            重新指定表头行
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="steps-block">
                <div className="block-head">
                  <h2>步骤</h2>
                  <div className="row-actions">
                    <button type="button" onClick={() => addStep("filter")}>
                      +筛选
                    </button>
                    <button type="button" onClick={() => addStep("pivot")}>
                      +透视
                    </button>
                    <button type="button" onClick={() => addStep("calculate")}>
                      +计算
                    </button>
                    <button type="button" onClick={() => addStep("sort")}>
                      +排序
                    </button>
                    <button type="button" onClick={() => addStep("dedupe")}>
                      +列去重
                    </button>
                    <button type="button" onClick={() => addStep("sideBySide")}>
                      +拼版
                    </button>
                    <button type="button" onClick={() => addStep("vlookup")}>
                      +表对表
                    </button>
                    <button
                      type="button"
                      disabled={sources.length === 0}
                      onClick={loadDemoSteps}
                    >
                      示例步骤
                    </button>
                  </div>
                </div>

                <div className="steps-body">
                  <div className="steps-list">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={onDragEnd}
                    >
                      <SortableContext
                        items={pipeline.steps.map((s) => s.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {pipeline.steps.length === 0 && (
                          <div className="muted pad-sm">
                            源表就绪后，点击上方新增步骤
                          </div>
                        )}
                        {pipeline.steps.map((step) => (
                          <SortableStepItem
                            key={step.id}
                            step={step}
                            active={step.id === activeStepId}
                            onSelect={() => {
                              setActiveStepId(step.id);
                            }}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  </div>

                  <div className="step-editor">
                    {!activeStep ? (
                      <div className="muted pad-sm">选择步骤进行配置</div>
                    ) : (
                      <>
                        <div className="editor-toolbar">
                          <button
                            type="button"
                            onClick={() => void runPreviewStep()}
                            disabled={busy}
                          >
                            预览本步
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => removeStep(activeStep.id)}
                          >
                            删除
                          </button>
                        </div>
                        <StepEditor
                          step={activeStep}
                          tableOptions={tableOptions}
                          headerCache={headerCache}
                          onChange={(s) => updateStep(activeStep.id, () => s)}
                        />
                      </>
                    )}
                  </div>

                  <div className="step-preview">
                    <div className="mini-head">预览</div>
                    <PreviewTable data={stepPreview} />
                  </div>
                </div>
              </div>

              <div className="output-block">
                <div className="block-head">
                  <h2>输出</h2>
                </div>
                <div className="output-body">
                  <label className="grow">
                    输出目录
                    <div className="path-row">
                      <input
                        value={pipeline.outputDir}
                        onChange={(e) =>
                          updatePipeline((p) => ({
                            ...p,
                            outputDir: e.target.value,
                          }))
                        }
                        placeholder="结果 Excel 输出位置"
                      />
                      <button type="button" onClick={() => void pickOutputDir()}>
                        浏览
                      </button>
                    </div>
                  </label>

                  <div className="field-block">
                    <div className="field-label">
                      结果 Sheet（拖动排序，可改名称；来自已勾选「作为结果」的步骤）
                    </div>
                    <OutputSheetList
                      sheets={pipeline.outputSheets ?? []}
                      steps={pipeline.steps}
                      onReorder={(sheets) =>
                        updatePipeline((p) => ({ ...p, outputSheets: sheets }))
                      }
                      onRename={(stepId, sheetName) => {
                        updatePipeline((p) => {
                          const outputSheets = (p.outputSheets ?? []).map((o) =>
                            o.stepId === stepId ? { ...o, sheetName } : o,
                          );
                          const steps = p.steps.map((s) =>
                            s.id === stepId && s.result
                              ? {
                                  ...s,
                                  result: { ...s.result, sheetName },
                                }
                              : s,
                          );
                          return { ...p, outputSheets, steps };
                        });
                      }}
                    />
                    {(() => {
                      const names = (pipeline.outputSheets ?? [])
                        .map((o) => o.sheetName.trim())
                        .filter(Boolean);
                      const dup = names.find(
                        (n, i) => names.indexOf(n) !== i,
                      );
                      return dup ? (
                        <p className="warn-inline">
                          Sheet 名称「{dup}」重复，请修改后再执行
                        </p>
                      ) : null;
                    })()}
                    {(pipeline.outputSheets ?? []).length === 0 && (
                      <p className="hint">
                        请在步骤中勾选「作为结果 sheet」，然后在此调整顺序与名称
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {lastExport && lastExport.outputFiles.length > 0 && (
        <div className="export-banner">
          <div className="export-banner-main">
            <strong>生成成功</strong>
            <span className="export-sheets">
              Sheet：{lastExport.sheetNames.join("、") || "—"}
            </span>
            {lastExport.outputFiles.map((path) => (
              <div key={path} className="export-file-row">
                <button
                  type="button"
                  className="linkish"
                  title="打开文件"
                  onClick={() => void openResultFile(path)}
                >
                  {path}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void openResultFile(path)}
                >
                  打开
                </button>
                <button type="button" onClick={() => void revealResultFile(path)}>
                  在文件夹中显示
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

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => void handleCopyScheme(ctxMenu.id)}>
            复制
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
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div
            className="modal"
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
          </div>
        </div>
      )}
    </div>
  );
}

function OutputSheetList({
  sheets,
  steps,
  onReorder,
  onRename,
}: {
  sheets: OutputSheet[];
  steps: Step[];
  onReorder: (sheets: OutputSheet[]) => void;
  onRename: (stepId: string, sheetName: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sheets.findIndex((s) => s.stepId === active.id);
    const newIndex = sheets.findIndex((s) => s.stepId === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(sheets, oldIndex, newIndex));
  }

  if (sheets.length === 0) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={sheets.map((s) => s.stepId)}
        strategy={verticalListSortingStrategy}
      >
        <div className="output-sheet-list">
          {sheets.map((o, i) => {
            const step = steps.find((s) => s.id === o.stepId);
            return (
              <SortableOutputSheet
                key={o.stepId}
                id={o.stepId}
                index={i}
                sheetName={o.sheetName}
                stepLabel={step?.name || o.stepId}
                onRename={(name) => onRename(o.stepId, name)}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableOutputSheet({
  id,
  index,
  sheetName,
  stepLabel,
  onRename,
}: {
  id: string;
  index: number;
  sheetName: string;
  stepLabel: string;
  onRename: (name: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className="output-sheet-item"
    >
      <button className="drag-handle" type="button" {...attributes} {...listeners}>
        ⋮⋮
      </button>
      <span className="output-sheet-idx">{index + 1}</span>
      <div className="output-sheet-fields">
        <input
          value={sheetName}
          onChange={(e) => onRename(e.target.value)}
          placeholder="Sheet 名称"
        />
        <span className="muted">来自步骤：{stepLabel}</span>
      </div>
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
  const leftHeaders = headersFor(op.leftTableId);
  const rightHeaders = headersFor(op.rightTableId);

  function patch(next: Partial<Extract<Operation, { type: "vlookup" }>>) {
    const merged = { ...op, ...next };
    if (
      merged.leftTableId &&
      merged.rightTableId &&
      (!merged.leftKey || !merged.rightKey)
    ) {
      const guessed = guessJoinKeys(merged.leftTableId, merged.rightTableId);
      if (!merged.leftKey) merged.leftKey = guessed.baseKey;
      if (!merged.rightKey) merged.rightKey = guessed.foreignKey;
    }
    onChange(merged);
  }

  return (
    <>
      <p className="hint">
        按匹配列在表 B 中查找与表 A 对应的行（类似 VLOOKUP），再把所选列拼到表 A
        右侧。未匹配的表 B 列留空；数字按数值相等匹配（如 1 与 1.0）。
      </p>
      <label>
        表 A（基准，决定输出行）
        <select
          value={op.leftTableId}
          onChange={(e) =>
            patch({
              leftTableId: e.target.value,
              leftKey: "",
              leftColumns: [],
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
      <label>
        表 B（查找）
        <select
          value={op.rightTableId}
          onChange={(e) =>
            patch({
              rightTableId: e.target.value,
              rightKey: "",
              rightColumns: [],
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
      <div className="join-row">
        <label>
          表 A 匹配列
          <SearchableSelect
            value={op.leftKey}
            options={leftHeaders}
            placeholder="搜索表 A 字段"
            onChange={(leftKey) => patch({ leftKey })}
          />
        </label>
        <label>
          表 B 匹配列
          <SearchableSelect
            value={op.rightKey}
            options={rightHeaders}
            placeholder="搜索表 B 字段"
            onChange={(rightKey) => patch({ rightKey })}
          />
        </label>
        <button
          type="button"
          disabled={!op.leftTableId || !op.rightTableId}
          onClick={() => {
            const guessed = guessJoinKeys(op.leftTableId, op.rightTableId);
            patch({ leftKey: guessed.baseKey, rightKey: guessed.foreignKey });
          }}
        >
          重新猜测
        </button>
      </div>
      {op.leftTableId && op.rightTableId && (!op.leftKey || !op.rightKey) && (
        <p className="warn-inline">未猜到共同列，请手动选择匹配列</p>
      )}
      {op.leftKey && op.rightKey && (
        <p className="hint">
          当前按「{op.leftKey}」=「{op.rightKey}」查找
        </p>
      )}

      <ColumnPickList
        label="表 A 输出列（不勾选则全部保留）"
        headers={leftHeaders}
        selected={op.leftColumns}
        onChange={(leftColumns) => patch({ leftColumns })}
      />
      <ColumnPickList
        label="表 B 拼接列（不勾选则全部拼到右侧）"
        headers={rightHeaders}
        selected={op.rightColumns}
        onChange={(rightColumns) => patch({ rightColumns })}
      />
    </>
  );
}

function ColumnPickList({
  label,
  headers,
  selected,
  onChange,
}: {
  label: string;
  headers: string[];
  selected: string[];
  onChange: (cols: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = fuzzyFilter(headers, query);

  return (
    <div className="field-block">
      <div className="field-label">{label}</div>
      <input
        className="col-search"
        value={query}
        placeholder="模糊搜索字段，如「业代」可匹配「业务员代码」"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="chip-row">
        <button
          type="button"
          onClick={() => {
            const next = [...selected];
            for (const h of filtered) {
              if (!next.includes(h)) next.push(h);
            }
            onChange(next);
          }}
        >
          {query.trim() ? "勾选筛选结果" : "全选"}
        </button>
        <button type="button" onClick={() => onChange([])}>
          默认全部
        </button>
      </div>
      <div className="multi-scroll">
        {headers.length === 0 && (
          <div className="muted">无表头可选；可先预览该表或上游步骤</div>
        )}
        {headers.length > 0 && filtered.length === 0 && (
          <div className="muted">无匹配字段</div>
        )}
        {filtered.map((h) => {
          const checked = selected.includes(h);
          return (
            <label key={h} className="check-row">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  onChange(
                    e.target.checked
                      ? [...selected, h]
                      : selected.filter((x) => x !== h),
                  );
                }}
              />
              {h}
            </label>
          );
        })}
      </div>
      {selected.length > 0 && (
        <div className="chip-row">
          {selected.map((h) => (
            <span key={h} className="chip">
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SideBySideEditor({
  columns,
  tableOptions,
  headerCache,
  onChangeColumns,
}: {
  columns: { tableId: string; column: string }[];
  tableOptions: { id: string; label: string; headers: string[] }[];
  headerCache: Record<string, string[]>;
  onChangeColumns: (cols: { tableId: string; column: string }[]) => void;
}) {
  const [pickTableId, setPickTableId] = useState(tableOptions[0]?.id ?? "");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const headers =
    headerCache[pickTableId] ??
    tableOptions.find((t) => t.id === pickTableId)?.headers ??
    [];

  // Stable ids for dnd
  const items = columns.map((c, i) => ({
    ...c,
    key: `${i}-${c.tableId}-${c.column || "spacer"}`,
  }));

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((x) => x.key === active.id);
    const newIndex = items.findIndex((x) => x.key === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onChangeColumns(arrayMove(columns, oldIndex, newIndex));
  }

  return (
    <div className="field-block">
      <div className="field-label">从表中点选列加入拼版</div>
      <label>
        来源表
        <select
          value={pickTableId}
          onChange={(e) => setPickTableId(e.target.value)}
        >
          {tableOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="chip-row wrap">
        {headers.map((h) => (
          <button
            key={h}
            type="button"
            className="chip-btn"
            onClick={() =>
              onChangeColumns([...columns, { tableId: pickTableId, column: h }])
            }
          >
            + {h}
          </button>
        ))}
        {headers.length === 0 && (
          <span className="muted">无表头（先预览该表/步骤）</span>
        )}
      </div>
      <button
        type="button"
        onClick={() =>
          onChangeColumns([...columns, { tableId: "", column: "" }])
        }
      >
        插入空列
      </button>

      <div className="field-label">已选列（拖动排序）</div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={items.map((x) => x.key)}
          strategy={verticalListSortingStrategy}
        >
          <div className="side-col-list">
            {items.length === 0 && (
              <div className="muted">尚未选择列</div>
            )}
            {items.map((item, i) => (
              <SortableSideCol
                key={item.key}
                id={item.key}
                label={
                  !item.column
                    ? `${i + 1}. （空列）`
                    : `${i + 1}. ${
                        tableOptions.find((t) => t.id === item.tableId)?.label ||
                        item.tableId
                      } · ${item.column}`
                }
                onRemove={() =>
                  onChangeColumns(columns.filter((_, j) => j !== i))
                }
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <p className="hint">点列追加到末尾，拖动手柄调整左右顺序；空列用于表间分隔</p>
    </div>
  );
}

function SortableSideCol({
  id,
  label,
  onRemove,
}: {
  id: string;
  label: string;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className="side-col-item"
    >
      <button className="drag-handle" type="button" {...attributes} {...listeners}>
        ⋮⋮
      </button>
      <span className="side-col-label">{label}</span>
      <button type="button" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function StepEditor({
  step,
  tableOptions,
  headerCache,
  onChange,
}: {
  step: Step;
  tableOptions: { id: string; label: string; headers: string[] }[];
  headerCache: Record<string, string[]>;
  onChange: (s: Step) => void;
}) {
  const headersFor = (tableId: string) =>
    headerCache[tableId] ??
    tableOptions.find((t) => t.id === tableId)?.headers ??
    [];
  const op = step.operation;

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

  const insertFormulaRef = (tableId: string, column: string) => {
    if (op.type !== "calculate") return;
    const token = `[${tableId}!${column}]`;
    const formula = op.formula?.startsWith("=") ? op.formula : `=${op.formula || ""}`;
    let joins = op.joins.filter((j) => j.tableId.trim());
    if (tableId !== op.baseTableId && !joins.some((j) => j.tableId === tableId)) {
      const guessed = guessJoinKeys(op.baseTableId, tableId);
      joins = [...joins, { tableId, ...guessed }];
    }
    onChange({
      ...step,
      operation: { ...op, formula: `${formula}${token}`, joins },
    });
  };

  const removeJoinAndRefs = (tableId: string) => {
    if (op.type !== "calculate") return;
    const joins = op.joins.filter((j) => j.tableId !== tableId);
    // Strip formula tokens that reference this table
    const formula = op.formula.replace(
      new RegExp(`\\[${tableId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}![^\\]]*\\]`, "g"),
      "",
    );
    onChange({
      ...step,
      operation: { ...op, joins, formula },
    });
  };

  return (
    <div className="editor-body">
      <label>
        步骤名称
        <input
          value={step.name}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
        />
      </label>

      <fieldset className="result-box">
        <legend>结果输出</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={!!step.result?.enabled}
            onChange={(e) =>
              onChange({
                ...step,
                result: {
                  enabled: e.target.checked,
                  fileKey: "main",
                  sheetName: step.result?.sheetName || step.name,
                },
              })
            }
          />
          作为结果 sheet
        </label>
        {step.result?.enabled && (
          <p className="hint">Sheet 顺序与名称请在下方「输出」中调整</p>
        )}
      </fieldset>

      {op.type === "filter" && (
        <>
          <label>
            输入表
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
          {op.conditions.map((c, i) => (
            <div className="cond-row" key={i}>
              <input
                list={`fc-${step.id}-${i}`}
                value={c.column}
                placeholder="列名"
                onChange={(e) => {
                  const conditions = [...op.conditions];
                  conditions[i] = { ...c, column: e.target.value };
                  onChange({ ...step, operation: { ...op, conditions } });
                }}
              />
              <datalist id={`fc-${step.id}-${i}`}>
                {headersFor(op.inputTableId).map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
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
              <input
                value={c.value}
                placeholder="值"
                onChange={(e) => {
                  const conditions = [...op.conditions];
                  conditions[i] = { ...c, value: e.target.value };
                  onChange({ ...step, operation: { ...op, conditions } });
                }}
              />
              <button
                type="button"
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
            onClick={() =>
              onChange({
                ...step,
                operation: {
                  ...op,
                  conditions: [
                    ...op.conditions,
                    { column: "", op: "not_contains", value: "" },
                  ],
                },
              })
            }
          >
            添加条件
          </button>
        </>
      )}

      {op.type === "pivot" && (
        <>
          <label>
            输入表
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
          <div className="field-block">
            <div className="field-label">行字段（多选）</div>
            <div className="multi-scroll">
              {headersFor(op.inputTableId).length === 0 && (
                <div className="muted">无表头可选；可先预览上游步骤，或下方手动添加</div>
              )}
              {headersFor(op.inputTableId).map((h) => {
                const checked = op.rowFields.includes(h);
                return (
                  <label key={h} className="check-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const rowFields = e.target.checked
                          ? [...op.rowFields, h]
                          : op.rowFields.filter((x) => x !== h);
                        onChange({ ...step, operation: { ...op, rowFields } });
                      }}
                    />
                    {h}
                  </label>
                );
              })}
            </div>
            {op.rowFields.length > 0 && (
              <div className="chip-row">
                {op.rowFields.map((h) => (
                  <span key={h} className="chip">
                    {h}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="field-block">
            <div className="field-label">值字段（多选，各自聚合）</div>
            <div className="multi-scroll">
              {headersFor(op.inputTableId).map((h) => {
                const selected = op.valueFields.some((v) => v.field === h);
                return (
                  <label key={h} className="check-row">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => {
                        const valueFields = e.target.checked
                          ? [
                              ...op.valueFields,
                              { field: h, aggregation: "sum", alias: "" },
                            ]
                          : op.valueFields.filter((v) => v.field !== h);
                        onChange({ ...step, operation: { ...op, valueFields } });
                      }}
                    />
                    {h}
                  </label>
                );
              })}
            </div>
            {op.valueFields.map((v, i) => (
              <div className="value-agg-row" key={`${v.field}-${i}`}>
                <span className="chip">{v.field}</span>
                <select
                  value={v.aggregation}
                  onChange={(e) => {
                    const valueFields = [...op.valueFields];
                    valueFields[i] = { ...v, aggregation: e.target.value };
                    onChange({ ...step, operation: { ...op, valueFields } });
                  }}
                >
                  <option value="sum">求和</option>
                  <option value="count">计数</option>
                  <option value="avg">平均</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...step,
                      operation: {
                        ...op,
                        valueFields: op.valueFields.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {op.type === "calculate" && (
        <>
          <label>
            基准表（决定行）
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
          <label>
            输出列名
            <input
              value={op.outputField}
              onChange={(e) =>
                onChange({
                  ...step,
                  operation: { ...op, outputField: e.target.value },
                })
              }
            />
          </label>
          <div className="field-block">
            <div className="field-label">点击表头插入公式引用</div>
            <div className="ref-picker">
              {tableOptions.map((t) => (
                <div key={t.id} className="ref-table">
                  <div className="ref-table-name">{t.label}</div>
                  <div className="chip-row wrap">
                    {(headerCache[t.id] ?? t.headers).map((h) => (
                      <button
                        key={h}
                        type="button"
                        className="chip-btn"
                        onClick={() => insertFormulaRef(t.id, h)}
                      >
                        {h}
                      </button>
                    ))}
                    {(headerCache[t.id] ?? t.headers).length === 0 && (
                      <span className="muted">无表头（先预览该表/步骤）</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <label>
            计算公式（Excel 风格，引用格式 [表ID!列名]）
            <textarea
              className="formula-input"
              rows={3}
              value={op.formula}
              onChange={(e) =>
                onChange({
                  ...step,
                  operation: { ...op, formula: e.target.value },
                })
              }
              placeholder="=[tmp:xxx!保费变化量不含税_求和]-[src:2025同月保费!保费]"
            />
          </label>
          <div className="field-block">
            <div className="field-label">跨表关联（自动猜测，可改）</div>
            {op.joins.filter((j) => j.tableId.trim()).length === 0 && (
              <p className="hint">点击其他表的表头插入公式时，会自动添加关联并猜测键列</p>
            )}
            {op.joins
              .filter((j) => j.tableId.trim())
              .map((j) => (
              <div className="join-card" key={j.tableId}>
                <div className="join-card-head">
                  <strong>
                    {tableOptions.find((t) => t.id === j.tableId)?.label || j.tableId}
                  </strong>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeJoinAndRefs(j.tableId)}
                  >
                    删除关联表
                  </button>
                </div>
                <div className="join-row">
                  <label>
                    基准表键列
                    <select
                      value={j.baseKey}
                      onChange={(e) => {
                        const joins = op.joins.map((x) =>
                          x.tableId === j.tableId
                            ? { ...x, baseKey: e.target.value }
                            : x,
                        );
                        onChange({ ...step, operation: { ...op, joins } });
                      }}
                    >
                      <option value="">请选择</option>
                      {headersFor(op.baseTableId).map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    关联表键列
                    <select
                      value={j.foreignKey}
                      onChange={(e) => {
                        const joins = op.joins.map((x) =>
                          x.tableId === j.tableId
                            ? { ...x, foreignKey: e.target.value }
                            : x,
                        );
                        onChange({ ...step, operation: { ...op, joins } });
                      }}
                    >
                      <option value="">请选择</option>
                      {headersFor(j.tableId).map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const guessed = guessJoinKeys(op.baseTableId, j.tableId);
                      const joins = op.joins.map((x) =>
                        x.tableId === j.tableId ? { ...x, ...guessed } : x,
                      );
                      onChange({ ...step, operation: { ...op, joins } });
                    }}
                  >
                    重新猜测
                  </button>
                </div>
                {!j.baseKey || !j.foreignKey ? (
                  <p className="warn-inline">未猜到共同列，请手动选择键列</p>
                ) : (
                  <p className="hint">
                    当前按「{j.baseKey}」=「{j.foreignKey}」对齐
                  </p>
                )}
              </div>
            ))}
            <p className="hint">
              支持 + - * / ()。示例：=[基准表ID!列A]-[其他表ID!列B]
            </p>
          </div>
        </>
      )}

      {op.type === "sort" && (
        <>
          <label>
            输入表
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
          <div className="field-block">
            <div className="field-label">排序字段（可多级）</div>
            {op.keys.map((k, i) => (
              <div className="value-agg-row" key={i}>
                <select
                  value={k.column}
                  onChange={(e) => {
                    const keys = [...op.keys];
                    keys[i] = { ...k, column: e.target.value };
                    onChange({ ...step, operation: { ...op, keys } });
                  }}
                >
                  <option value="">选择列</option>
                  {headersFor(op.inputTableId).map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
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
              添加排序字段
            </button>
          </div>
        </>
      )}

      {op.type === "dedupe" && (
        <>
          <label>
            输入表
            <select
              value={op.inputTableId}
              onChange={(e) =>
                onChange({
                  ...step,
                  operation: { ...op, inputTableId: e.target.value, columns: [] },
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
          <p className="hint">
            按所选列组合判断重复，保留首次出现的行；不勾选则按全部列去重。
          </p>
          <ColumnPickList
            label="去重依据列（不勾选 = 全部列）"
            headers={headersFor(op.inputTableId)}
            selected={op.columns}
            onChange={(columns) =>
              onChange({ ...step, operation: { ...op, columns } })
            }
          />
        </>
      )}

      {op.type === "sideBySide" && (
        <SideBySideEditor
          columns={op.columns ?? []}
          tableOptions={tableOptions}
          headerCache={headerCache}
          onChangeColumns={(columns) =>
            onChange({
              ...step,
              operation: { ...op, columns, tableIds: [] },
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

      {op.type === "lookupSubtract" && (
        <p className="hint">
          这是旧版「左右表相减」步骤，建议删除后用新的「计算」步骤重配。
        </p>
      )}
    </div>
  );
}
