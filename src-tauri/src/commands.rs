use crate::engine::Runtime;
use crate::models::{
    ExecuteResult, Operation, Pipeline, PreviewData, RawSheetPreview, SchemeSummary, SourceTable,
};
use crate::writer::{
    sanitize_sheet_name, write_formula_template, write_results, CalcJoinTemplate, CalculateTemplate,
    FilterTemplate, NewPremiumTemplate, PivotTemplate, SortTemplate,
};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
pub fn scan_source_dir(
    path: String,
    header_rows: HashMap<String, usize>,
) -> Result<Vec<SourceTable>, String> {
    let runtime = Runtime::from_scan(PathBuf::from(&path).as_path(), &header_rows)?;
    Ok(runtime.source_meta)
}

#[tauri::command]
pub fn preview_source_table(
    path: String,
    header_row: Option<usize>,
    limit: usize,
    key_column: Option<String>,
    header_rows: Option<HashMap<String, usize>>,
) -> Result<PreviewData, String> {
    let _ = key_column; // folder preview ignores merge key; full merge uses it at execute
    let p = PathBuf::from(&path);
    if p.is_dir() {
        let rows = header_rows.unwrap_or_default();
        let preview = crate::excel_io::read_folder_preview(&p, &rows, limit.max(1))?;
        return Ok(crate::models::PreviewData {
            headers: preview.headers,
            rows: preview.rows,
            total_rows: preview.total_rows,
            header_groups: vec![],
        });
    }
    let (table, _, total) =
        crate::excel_io::read_excel_preview(&p, header_row, limit.max(1))?;
    Ok(crate::models::PreviewData {
        headers: table.headers,
        rows: table.rows,
        total_rows: total,
        header_groups: table.header_groups,
    })
}

#[tauri::command]
pub fn peek_raw_sheet(path: String, limit: usize) -> Result<RawSheetPreview, String> {
    let (rows, total_rows) =
        crate::excel_io::peek_raw_rows(PathBuf::from(&path).as_path(), limit.max(1))?;
    Ok(RawSheetPreview { rows, total_rows })
}

#[tauri::command]
pub fn preview_step(pipeline: Pipeline, step_id: String, limit: usize) -> Result<PreviewData, String> {
    if pipeline.source_dir.trim().is_empty() {
        return Err("请先配置源数据目录".into());
    }
    let mut runtime = Runtime::from_pipeline(&pipeline)?;
    runtime.preview_step(&pipeline, &step_id, limit.max(1))
}

#[tauri::command]
pub fn execute_pipeline(pipeline: Pipeline) -> Result<ExecuteResult, String> {
    run_pipeline_inner(pipeline)
}

/// Shared execute path (GUI + folder context-menu run).
pub fn run_pipeline_inner(pipeline: Pipeline) -> Result<ExecuteResult, String> {
    if pipeline.output_dir.trim().is_empty() {
        return Err("请先配置输出目录".into());
    }
    if pipeline.source_dir.trim().is_empty() {
        return Err("请先配置源数据目录".into());
    }

    let mut runtime = Runtime::from_pipeline(&pipeline)?;
    let used = runtime.used_source_ids(&pipeline);
    let bad: Vec<_> = runtime
        .source_meta
        .iter()
        .filter(|s| used.contains(&s.id) && !s.header_ok)
        .map(|s| s.name.clone())
        .collect();
    if !bad.is_empty() {
        return Err(format!(
            "以下步骤用到的源表未识别表头，请先手动指定表头行：{}",
            bad.join("、")
        ));
    }

    runtime.run_until(&pipeline, None)?;

    // Resolve final sheet list: prefer pipeline.output_sheets order
    let mut resolved_sheets: Vec<(String, String, crate::models::DataTable)> = Vec::new();
    // (sheet_name, step_id for debug, table)

    if !pipeline.output_sheets.is_empty() {
        for os in &pipeline.output_sheets {
            let step = pipeline
                .steps
                .iter()
                .find(|s| s.id == os.step_id)
                .ok_or_else(|| format!("输出配置引用了不存在的步骤: {}", os.step_id))?;
            if !step.result.as_ref().map(|r| r.enabled).unwrap_or(false) {
                continue;
            }
            let table = runtime
                .temps
                .get(&step.output_table_id)
                .ok_or_else(|| format!("步骤「{}」无输出表", step.name))?
                .clone();
            let sheet_name = if os.sheet_name.trim().is_empty() {
                step.name.clone()
            } else {
                os.sheet_name.trim().to_string()
            };
            if sheet_name.is_empty() {
                return Err(format!("步骤「{}」的 Sheet 名称为空", step.name));
            }
            if resolved_sheets.iter().any(|(n, _, _)| n == &sheet_name) {
                return Err(format!(
                    "结果 Sheet 名称重复：「{sheet_name}」。请修改后再执行"
                ));
            }
            resolved_sheets.push((sheet_name, step.id.clone(), table));
        }
    } else {
        // Legacy: enabled steps in reverse order
        for step in pipeline.steps.iter().rev() {
            if let Some(spec) = &step.result {
                if !spec.enabled {
                    continue;
                }
                let table = runtime
                    .temps
                    .get(&step.output_table_id)
                    .ok_or_else(|| format!("步骤「{}」无输出表", step.name))?
                    .clone();
                let sheet_name = if spec.sheet_name.trim().is_empty() {
                    step.name.clone()
                } else {
                    spec.sheet_name.trim().to_string()
                };
                if sheet_name.is_empty() {
                    return Err(format!("步骤「{}」已作为结果，但 Sheet 名称为空", step.name));
                }
                if resolved_sheets.iter().any(|(n, _, _)| n == &sheet_name) {
                    return Err(format!(
                        "结果 Sheet 名称重复：「{sheet_name}」。请修改后再执行"
                    ));
                }
                resolved_sheets.push((sheet_name, step.id.clone(), table));
            }
        }
    }

    if resolved_sheets.is_empty() {
        return Err("没有标记为结果的步骤，请至少勾选一个步骤的「作为结果」".into());
    }

    let sheet_names: Vec<String> = resolved_sheets.iter().map(|(n, _, _)| n.clone()).collect();
    let mut sheets_by_file: BTreeMap<String, Vec<(String, crate::models::DataTable)>> =
        BTreeMap::new();
    for (sheet_name, _, table) in resolved_sheets {
        sheets_by_file
            .entry("main".to_string())
            .or_default()
            .push((sheet_name, table));
    }

    let name = if pipeline.name.trim().is_empty() {
        "结果"
    } else {
        pipeline.name.as_str()
    };
    let outputs = write_results(
        PathBuf::from(&pipeline.output_dir).as_path(),
        name,
        &sheets_by_file,
    )?;

    Ok(ExecuteResult {
        output_files: outputs,
        sheet_names,
        message: "执行完成".into(),
    })
}

#[tauri::command]
pub fn prepare_folder_run(
    app: AppHandle,
    scheme_id: String,
    folder: String,
) -> Result<crate::folder_run::FolderRunPrep, String> {
    let pipeline = crate::schemes::load_scheme(&app, &scheme_id)?;
    let path = crate::folder_run::resolve_folder_arg(&folder)?;
    crate::folder_run::prepare_scheme_for_folder(pipeline, &path)
}

#[tauri::command]
pub fn execute_scheme_in_folder(
    app: AppHandle,
    scheme_id: String,
    folder: String,
) -> Result<ExecuteResult, String> {
    let path = crate::folder_run::resolve_folder_arg(&folder)?;
    crate::folder_run::execute_scheme_in_folder(&app, &scheme_id, &path)
}

#[tauri::command]
pub fn sync_folder_context_menu(app: AppHandle) -> Result<(), String> {
    crate::shell_menu::sync_from_app(&app)
}

#[tauri::command]
pub fn unregister_folder_context_menu() -> Result<String, String> {
    crate::shell_menu::unregister()
}

#[tauri::command]
pub fn export_formula_template(pipeline: Pipeline, output_path: String) -> Result<String, String> {
    if pipeline.source_dir.trim().is_empty() {
        return Err("请先配置源数据目录".into());
    }
    let mut runtime = Runtime::from_pipeline(&pipeline)?;
    runtime.load_all_sources()?;

    let source_refs: Vec<(String, &crate::models::DataTable)> = runtime
        .source_meta
        .iter()
        .filter_map(|m| {
            runtime
                .sources
                .get(&m.id)
                .map(|t| (m.name.clone(), t))
        })
        .collect();

    // Map logical table id -> Excel sheet name + headers (for chaining filter/pivot/sort/…)
    struct SheetRef {
        name: String,
        headers: Vec<String>,
    }
    let mut by_id: HashMap<String, SheetRef> = HashMap::new();
    for m in &runtime.source_meta {
        if let Some(t) = runtime.sources.get(&m.id) {
            by_id.insert(
                m.id.clone(),
                SheetRef {
                    name: sanitize_sheet_name(&format!("数据_{}", m.name)),
                    headers: t.headers.clone(),
                },
            );
        }
    }

    let mut filter_tpl = None;
    let mut pivot_tpl = None;
    let mut calculate_tpl = None;
    let mut sort_tpls: Vec<SortTemplate> = Vec::new();
    let mut new_premium_tpl = None;

    for step in &pipeline.steps {
        let sheet_name = step
            .result
            .as_ref()
            .map(|r| r.sheet_name.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| step.name.clone());
        let sheet_name = sanitize_sheet_name(&sheet_name);

        match &step.operation {
            Operation::Filter {
                input_table_id,
                conditions,
            } => {
                let src_name = runtime
                    .source_meta
                    .iter()
                    .find(|s| s.id == *input_table_id)
                    .map(|s| s.name.clone())
                    .unwrap_or_else(|| input_table_id.clone());
                let table = runtime.get_table(input_table_id)?;
                filter_tpl = Some(FilterTemplate {
                    sheet_name: sheet_name.clone(),
                    data_sheet: src_name,
                    headers: table.headers.clone(),
                    conditions: conditions
                        .iter()
                        .map(|c| (c.column.clone(), c.op.clone(), c.value.clone()))
                        .collect(),
                    data_rows: table.rows.len(),
                });
                by_id.insert(
                    step.output_table_id.clone(),
                    SheetRef {
                        name: sheet_name,
                        headers: table.headers.clone(),
                    },
                );
            }
            Operation::Pivot {
                input_table_id,
                row_fields,
                value_fields,
                value_field,
                ..
            } => {
                let input_ref = by_id.get(input_table_id);
                let filtered_sheet = input_ref
                    .map(|r| r.name.clone())
                    .or_else(|| filter_tpl.as_ref().map(|f| f.sheet_name.clone()))
                    .unwrap_or_else(|| "筛选结果".into());
                let filtered_headers = input_ref
                    .map(|r| r.headers.clone())
                    .or_else(|| filter_tpl.as_ref().map(|f| f.headers.clone()))
                    .unwrap_or_default();
                let first_value = value_fields
                    .first()
                    .map(|v| v.field.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| value_field.clone());
                let mut headers = row_fields.clone();
                let value_header = if let Some(v) = value_fields.first() {
                    if !v.alias.trim().is_empty() {
                        v.alias.clone()
                    } else {
                        let suffix = match v.aggregation.as_str() {
                            "count" => "计数",
                            "avg" => "平均",
                            _ => "求和",
                        };
                        format!("{}_{suffix}", v.field)
                    }
                } else {
                    format!("{first_value}_求和")
                };
                headers.push(value_header);
                pivot_tpl = Some(PivotTemplate {
                    sheet_name: sheet_name.clone(),
                    filtered_sheet,
                    row_fields: row_fields.clone(),
                    value_field: first_value,
                    filtered_headers,
                });
                by_id.insert(
                    step.output_table_id.clone(),
                    SheetRef {
                        name: sheet_name,
                        headers,
                    },
                );
            }
            Operation::Sort {
                input_table_id,
                keys,
            } => {
                let input = by_id.get(input_table_id).ok_or_else(|| {
                    format!(
                        "排序步骤「{}」的输入表未找到（公式模板需能追溯到筛选/透视等上游）",
                        step.name
                    )
                })?;
                let sort_keys: Vec<(String, bool)> = keys
                    .iter()
                    .filter(|k| !k.column.trim().is_empty())
                    .map(|k| {
                        (
                            k.column.clone(),
                            k.direction.eq_ignore_ascii_case("desc"),
                        )
                    })
                    .collect();
                if sort_keys.is_empty() {
                    return Err(format!("排序步骤「{}」未配置排序字段", step.name));
                }
                let headers = input.headers.clone();
                sort_tpls.push(SortTemplate {
                    sheet_name: sheet_name.clone(),
                    source_sheet: input.name.clone(),
                    headers: headers.clone(),
                    keys: sort_keys,
                });
                by_id.insert(
                    step.output_table_id.clone(),
                    SheetRef {
                        name: sheet_name,
                        headers,
                    },
                );
            }
            Operation::Calculate {
                base_table_id,
                output_field,
                formula,
                joins,
            } => {
                let base = by_id.get(base_table_id).ok_or_else(|| {
                    format!(
                        "计算步骤「{}」的基准表未找到（公式模板需能追溯到筛选/透视等上游）",
                        step.name
                    )
                })?;
                let mut join_tpls = Vec::new();
                for j in joins {
                    let right = by_id.get(&j.table_id).ok_or_else(|| {
                        format!(
                            "计算步骤「{}」的关联表「{}」未找到",
                            step.name, j.table_id
                        )
                    })?;
                    join_tpls.push(CalcJoinTemplate {
                        table_id: j.table_id.clone(),
                        sheet_name: right.name.clone(),
                        base_key: j.base_key.clone(),
                        foreign_key: j.foreign_key.clone(),
                        headers: right.headers.clone(),
                    });
                }
                let mut headers = base.headers.clone();
                headers.push(output_field.clone());
                calculate_tpl = Some(CalculateTemplate {
                    sheet_name: sheet_name.clone(),
                    base_sheet: base.name.clone(),
                    base_table_id: base_table_id.clone(),
                    base_headers: base.headers.clone(),
                    output_field: output_field.clone(),
                    formula: formula.clone(),
                    joins: join_tpls,
                });
                by_id.insert(
                    step.output_table_id.clone(),
                    SheetRef {
                        name: sheet_name,
                        headers,
                    },
                );
            }
            Operation::LookupSubtract {
                left_table_id,
                right_table_id,
                left_key,
                right_key,
                left_value_field,
                right_value_field,
                output_field,
            } => {
                let right_name = runtime
                    .source_meta
                    .iter()
                    .find(|s| s.id == *right_table_id)
                    .map(|s| s.name.clone())
                    .unwrap_or_else(|| right_table_id.clone());
                let right = runtime.get_table(right_table_id)?;
                let left = by_id.get(left_table_id);
                let pivot_sheet = left
                    .map(|r| r.name.clone())
                    .or_else(|| pivot_tpl.as_ref().map(|p| p.sheet_name.clone()))
                    .unwrap_or_else(|| "透视".into());
                let pivot_headers = left
                    .map(|r| r.headers.clone())
                    .or_else(|| {
                        pivot_tpl.as_ref().map(|p| {
                            let mut h = p.row_fields.clone();
                            h.push(format!("{}_求和", p.value_field));
                            h
                        })
                    })
                    .unwrap_or_default();
                new_premium_tpl = Some(NewPremiumTemplate {
                    sheet_name: sheet_name.clone(),
                    pivot_sheet,
                    right_data_sheet: right_name,
                    left_key: left_key.clone(),
                    right_key: right_key.clone(),
                    left_value_field: left_value_field.clone(),
                    right_value_field: right_value_field.clone(),
                    output_field: output_field.clone(),
                    pivot_headers: pivot_headers.clone(),
                    right_headers: right.headers.clone(),
                });
                let mut headers = pivot_headers;
                headers.push(output_field.clone());
                by_id.insert(
                    step.output_table_id.clone(),
                    SheetRef {
                        name: sheet_name,
                        headers,
                    },
                );
            }
            Operation::Dedupe { .. } => {}
            Operation::SideBySide { .. } => {}
            Operation::Vlookup { .. } => {}
        }
    }

    write_formula_template(
        PathBuf::from(&output_path).as_path(),
        &source_refs,
        filter_tpl,
        pivot_tpl,
        calculate_tpl,
        &sort_tpls,
        new_premium_tpl,
    )?;

    Ok(output_path)
}

#[tauri::command]
pub fn list_schemes(app: AppHandle) -> Result<Vec<SchemeSummary>, String> {
    crate::schemes::list_schemes(&app)
}

#[tauri::command]
pub fn load_scheme(app: AppHandle, id: String) -> Result<Pipeline, String> {
    crate::schemes::load_scheme(&app, &id)
}

#[tauri::command]
pub fn save_scheme(app: AppHandle, pipeline: Pipeline) -> Result<Pipeline, String> {
    crate::schemes::save_scheme(&app, pipeline)
}

#[tauri::command]
pub fn delete_scheme(app: AppHandle, id: String) -> Result<(), String> {
    crate::schemes::delete_scheme(&app, &id)
}

#[tauri::command]
pub fn rename_scheme(app: AppHandle, id: String, name: String) -> Result<Pipeline, String> {
    crate::schemes::rename_scheme(&app, &id, &name)
}

#[tauri::command]
pub fn copy_scheme(app: AppHandle, id: String) -> Result<Pipeline, String> {
    crate::schemes::copy_scheme(&app, &id)
}

#[tauri::command]
pub fn export_scheme(app: AppHandle, id: String, output_path: String) -> Result<String, String> {
    crate::schemes::export_scheme(&app, &id, &output_path)
}

#[tauri::command]
pub fn export_pipeline_file(pipeline: Pipeline, output_path: String) -> Result<String, String> {
    crate::schemes::export_pipeline(&pipeline, &output_path)
}

#[tauri::command]
pub fn import_scheme(app: AppHandle, input_path: String) -> Result<Pipeline, String> {
    crate::schemes::import_scheme(&app, &input_path)
}
