import { invoke } from "@tauri-apps/api/core";
import type {
  ExecuteResult,
  Pipeline,
  PreviewData,
  RawSheetPreview,
  SchemeSummary,
  SourceTable,
} from "./types";

export function scanSourceDir(path: string, headerRows: Record<string, number> = {}) {
  return invoke<SourceTable[]>("scan_source_dir", { path, headerRows });
}

export function previewSourceTable(
  path: string,
  headerRow?: number | null,
  limit = 30,
  opts?: { keyColumn?: string; headerRows?: Record<string, number> },
) {
  return invoke<PreviewData>("preview_source_table", {
    path,
    headerRow: headerRow ?? null,
    limit,
    keyColumn: opts?.keyColumn ?? null,
    headerRows: opts?.headerRows ?? null,
  });
}

export function peekRawSheet(path: string, limit = 30) {
  return invoke<RawSheetPreview>("peek_raw_sheet", { path, limit });
}

export function previewStep(pipeline: Pipeline, stepId: string, limit = 30) {
  return invoke<PreviewData>("preview_step", { pipeline, stepId, limit });
}

export function executePipeline(pipeline: Pipeline) {
  return invoke<ExecuteResult>("execute_pipeline", { pipeline });
}

export function exportFormulaTemplate(pipeline: Pipeline, outputPath: string) {
  return invoke<string>("export_formula_template", { pipeline, outputPath });
}

export function listSchemes() {
  return invoke<SchemeSummary[]>("list_schemes");
}

export function loadScheme(id: string) {
  return invoke<Pipeline>("load_scheme", { id });
}

export function saveScheme(pipeline: Pipeline) {
  return invoke<Pipeline>("save_scheme", { pipeline });
}

export function deleteScheme(id: string) {
  return invoke<void>("delete_scheme", { id });
}

export function renameScheme(id: string, name: string) {
  return invoke<Pipeline>("rename_scheme", { id, name });
}

export function copyScheme(id: string) {
  return invoke<Pipeline>("copy_scheme", { id });
}

export function exportScheme(id: string, outputPath: string) {
  return invoke<string>("export_scheme", { id, outputPath });
}

export function exportPipelineFile(pipeline: Pipeline, outputPath: string) {
  return invoke<string>("export_pipeline_file", { pipeline, outputPath });
}

export function importScheme(inputPath: string) {
  return invoke<Pipeline>("import_scheme", { inputPath });
}
