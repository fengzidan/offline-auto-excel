import { scanSourceDir, dirExists } from "./api";
import { stepInputIds } from "./flowOps";
import { applySourceMatchers } from "./sourceMatch";
import type { Pipeline, SourceMatcher } from "./types";

export type ImportSetupMatcher = {
  id: string;
  /** 方案内显示名（不可改成别的源表） */
  label: string;
  keyword: string;
  matchedName: string;
  ok: boolean;
};

export type ImportSetupState = {
  schemeName: string;
  warnings: string[];
  sourceDir: string;
  outputDir: string;
  sourceDirOk: boolean;
  outputDirOk: boolean;
  matchers: ImportSetupMatcher[];
  scanning: boolean;
};

/** 步骤中引用的源表 id（src:…） */
export function requiredSourceIds(pipeline: Pipeline): string[] {
  const ids = new Set<string>();
  for (const step of pipeline.steps) {
    if (
      step.operation.type === "start" ||
      step.operation.type === "output"
    ) {
      continue;
    }
    for (const id of stepInputIds(step.operation)) {
      if (id.startsWith("src:")) ids.add(id);
    }
  }
  return [...ids];
}

/** 方案内固定的源表清单（不可增删，仅可改关键字） */
export function schemeSourceMatchers(pipeline: Pipeline): SourceMatcher[] {
  const byId = new Map<string, SourceMatcher>();
  for (const m of pipeline.sourceMatchers ?? []) {
    if (!m.id?.trim()) continue;
    byId.set(m.id, {
      id: m.id,
      keyword: m.keyword ?? "",
      label: m.label?.trim() || m.keyword?.trim() || m.id.replace(/^src:/, ""),
    });
  }
  for (const id of requiredSourceIds(pipeline)) {
    if (byId.has(id)) continue;
    const name = id.replace(/^src:/, "");
    byId.set(id, { id, keyword: name, label: name });
  }
  return [...byId.values()];
}

function sourceLabel(pipeline: Pipeline, id: string): string {
  const m = pipeline.sourceMatchers?.find((x) => x.id === id);
  const name = id.replace(/^src:/, "");
  if (m?.keyword?.trim()) {
    return `${m.label?.trim() || name}（关键字「${m.keyword.trim()}」）`;
  }
  return m?.label?.trim() || name;
}

export async function collectImportWarnings(
  pipeline: Pipeline,
): Promise<string[]> {
  const warnings: string[] = [];
  const sourceDir = pipeline.sourceDir.trim();
  const outputDir = pipeline.outputDir.trim();

  const sourceOk = sourceDir ? await dirExists(sourceDir) : false;
  const outputOk = outputDir ? await dirExists(outputDir) : false;

  if (!sourceDir) {
    warnings.push("未配置源数据文件夹（开始节点）");
  } else if (!sourceOk) {
    warnings.push(`源数据文件夹不存在：${sourceDir}`);
  }

  if (!outputDir) {
    warnings.push("未配置输出文件夹（输出节点）");
  } else if (!outputOk) {
    warnings.push(`输出文件夹不存在：${outputDir}`);
  }

  const required = schemeSourceMatchers(pipeline);
  if (required.length === 0) return warnings;

  if (!sourceDir || !sourceOk) {
    warnings.push(
      `以下方案源表无法校验（源文件夹不可用）：${required
        .map((m) => m.label || m.id.replace(/^src:/, ""))
        .join("、")}`,
    );
    return warnings;
  }

  try {
    const raw = await scanSourceDir(sourceDir, pipeline.headerRows ?? {});
    const tables = applySourceMatchers(raw, required);
    const missing: string[] = [];
    for (const m of required) {
      const t = tables.find((x) => x.id === m.id);
      if (!t || !t.path?.trim()) {
        missing.push(sourceLabel(pipeline, m.id));
      }
    }
    if (missing.length) {
      warnings.push(`以下方案源表未找到（可改关键字匹配）：${missing.join("、")}`);
    }
  } catch (e) {
    warnings.push(`扫描源数据文件夹失败：${String(e)}`);
  }

  return warnings;
}

export function buildImportSetupState(
  pipeline: Pipeline,
  warnings: string[],
): ImportSetupState {
  const matchers = schemeSourceMatchers(pipeline).map((m) => ({
    id: m.id,
    label: m.label?.trim() || m.id.replace(/^src:/, ""),
    keyword: m.keyword ?? "",
    matchedName: "",
    ok: false,
  }));
  return {
    schemeName: pipeline.name,
    warnings,
    sourceDir: pipeline.sourceDir ?? "",
    outputDir: pipeline.outputDir ?? "",
    sourceDirOk: false,
    outputDirOk: false,
    matchers,
    scanning: false,
  };
}

/** 按当前目录与关键字重算匹配状态（不增删方案源表） */
export async function refreshImportSetupMatch(
  state: ImportSetupState,
  headerRows: Record<string, number> = {},
): Promise<ImportSetupState> {
  const sourceDir = state.sourceDir.trim();
  const outputDir = state.outputDir.trim();
  const sourceDirOk = sourceDir ? await dirExists(sourceDir) : false;
  const outputDirOk = outputDir ? await dirExists(outputDir) : false;

  const matchersBase = state.matchers.map((m) => ({
    ...m,
    matchedName: "",
    ok: false,
  }));

  if (!sourceDir || !sourceDirOk) {
    return {
      ...state,
      sourceDirOk,
      outputDirOk,
      matchers: matchersBase,
      scanning: false,
    };
  }

  try {
    const raw = await scanSourceDir(sourceDir, headerRows);
    const asMatchers: SourceMatcher[] = matchersBase.map((m) => ({
      id: m.id,
      keyword: m.keyword,
      label: m.label,
    }));
    const tables = applySourceMatchers(raw, asMatchers);
    const matchers = matchersBase.map((m) => {
      const t = tables.find((x) => x.id === m.id);
      const ok = !!(t && t.path?.trim());
      return {
        ...m,
        ok,
        matchedName: ok
          ? t?.matchedName || t?.name || ""
          : t?.headerMessage || "未匹配到文件",
      };
    });
    return {
      ...state,
      sourceDirOk,
      outputDirOk,
      matchers,
      scanning: false,
    };
  } catch (e) {
    return {
      ...state,
      sourceDirOk,
      outputDirOk,
      matchers: matchersBase.map((m) => ({
        ...m,
        ok: false,
        matchedName: String(e),
      })),
      scanning: false,
    };
  }
}

export function importSetupIsReady(state: ImportSetupState): boolean {
  if (!state.sourceDir.trim() || !state.sourceDirOk) return false;
  if (!state.outputDir.trim() || !state.outputDirOk) return false;
  if (state.scanning) return false;
  if (state.matchers.some((m) => !m.keyword.trim())) return false;
  return state.matchers.every((m) => m.ok);
}

export function importSetupBlockingReasons(state: ImportSetupState): string[] {
  const reasons: string[] = [];
  if (!state.sourceDir.trim()) reasons.push("请选择源数据文件夹");
  else if (!state.sourceDirOk) reasons.push("源数据文件夹不存在");
  if (!state.outputDir.trim()) reasons.push("请选择输出文件夹");
  else if (!state.outputDirOk) reasons.push("输出文件夹不存在");
  const emptyKw = state.matchers.filter((m) => !m.keyword.trim());
  if (emptyKw.length) {
    reasons.push(
      `请填写关键字：${emptyKw.map((m) => m.label).join("、")}`,
    );
  }
  const missing = state.matchers.filter((m) => m.keyword.trim() && !m.ok);
  if (missing.length) {
    reasons.push(
      `以下源表尚未匹配到文件：${missing.map((m) => m.label).join("、")}`,
    );
  }
  return reasons;
}
