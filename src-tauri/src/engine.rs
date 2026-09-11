use crate::excel_io::{apply_filter, read_excel_first_sheet, read_folder_merged};
use crate::models::{DataTable, FolderMerge, Operation, Pipeline, PreviewData, SourceTable};
use crate::ops::{
    apply_calculate, apply_dedupe, apply_full_join, apply_lookup_subtract, apply_pivot,
    apply_side_by_side_blocks, apply_side_by_side_columns, apply_side_by_side_layout, apply_sort,
    apply_vlookup_multi,
    formulas_table_ids, resolve_calc_columns,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteStepProgress {
    pub index: usize,
    pub total: usize,
    pub step_id: String,
    pub step_name: String,
    /// "start" | "done"
    pub phase: &'static str,
}

fn load_source_table(
    source: &SourceTable,
    header_rows: &HashMap<String, usize>,
    folder_merges: &HashMap<String, FolderMerge>,
) -> Result<DataTable, String> {
    if source.kind == "folder" {
        let key = folder_merges
            .get(&source.id)
            .map(|m| m.key_column.as_str())
            .unwrap_or("");
        if key.trim().is_empty() {
            return Err(format!(
                "累计表「{}」尚未选择覆盖键列。请在源表中指定按哪一列用最新数据覆盖",
                source.name
            ));
        }
        read_folder_merged(Path::new(&source.path), header_rows, key)
    } else {
        let (table, _) =
            read_excel_first_sheet(Path::new(&source.path), Some(source.header_row))?;
        Ok(table)
    }
}

pub fn op_table_ids(op: &Operation) -> Vec<String> {
    match op {
        Operation::Filter { input_table_id, .. }
        | Operation::Pivot { input_table_id, .. }
        | Operation::Sort { input_table_id, .. }
        | Operation::Dedupe { input_table_id, .. } => vec![input_table_id.clone()],
        Operation::Calculate {
            base_table_id,
            output_field,
            formula,
            columns,
            joins,
        } => {
            let mut ids = vec![base_table_id.clone()];
            for j in joins {
                if !j.table_id.trim().is_empty() {
                    ids.push(j.table_id.clone());
                }
            }
            let cols = resolve_calc_columns(output_field, formula, columns);
            for tid in formulas_table_ids(cols.iter().map(|c| c.formula.as_str())) {
                ids.push(tid);
            }
            ids
        }
        Operation::LookupSubtract {
            left_table_id,
            right_table_id,
            ..
        } => vec![left_table_id.clone(), right_table_id.clone()],
        Operation::Vlookup {
            left_table_id,
            right_table_id,
            lookups,
            ..
        } => {
            let mut ids = vec![left_table_id.clone()];
            let rights = crate::ops::resolve_vlookup_lookups("", right_table_id, "", &[], lookups);
            for r in rights {
                if !r.table_id.trim().is_empty() {
                    ids.push(r.table_id);
                }
            }
            ids
        }
        Operation::FullJoin {
            left_table_id,
            right_table_id,
            ..
        } => vec![left_table_id.clone(), right_table_id.clone()],
        Operation::SideBySide {
            cells,
            blocks,
            columns,
            table_ids,
            ..
        } => {
            let mut ids: Vec<String> = cells
                .iter()
                .filter(|b| !b.table_id.trim().is_empty())
                .map(|b| b.table_id.clone())
                .collect();
            ids.extend(
                blocks
                    .iter()
                    .filter(|b| !b.table_id.trim().is_empty())
                    .map(|b| b.table_id.clone()),
            );
            ids.extend(
                columns
                    .iter()
                    .filter(|c| !c.table_id.trim().is_empty())
                    .map(|c| c.table_id.clone()),
            );
            ids.extend(table_ids.iter().cloned());
            ids
        }
        Operation::Output { sheets, .. } => sheets
            .iter()
            .map(|s| s.table_id.clone())
            .filter(|id| !id.trim().is_empty())
            .collect(),
        Operation::Start { .. } => vec![],
    }
}

/// Order steps so producers run before consumers (based on tmp: / output_table_id deps).
/// When `until_step_id` is set, only that step and its transitive dependencies are included.
pub fn ordered_steps_for_run<'a>(
    pipeline: &'a Pipeline,
    until_step_id: Option<&str>,
) -> Result<Vec<&'a crate::models::Step>, String> {
    let by_output: HashMap<&str, &crate::models::Step> = pipeline
        .steps
        .iter()
        .map(|s| (s.output_table_id.as_str(), s))
        .collect();
    let by_id: HashMap<&str, &crate::models::Step> =
        pipeline.steps.iter().map(|s| (s.id.as_str(), s)).collect();
    let order_index: HashMap<&str, usize> = pipeline
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();

    // step_id -> producer step ids it depends on
    let mut deps: HashMap<String, HashSet<String>> = HashMap::new();
    for step in &pipeline.steps {
        let mut need = HashSet::new();
        for tid in op_table_ids(&step.operation) {
            let tid = tid.trim();
            if tid.is_empty() {
                continue;
            }
            if let Some(prod) = by_output.get(tid) {
                if prod.id != step.id {
                    need.insert(prod.id.clone());
                }
            } else if tid.starts_with("tmp:") {
                return Err(format!(
                    "步骤「{}」引用了不存在的临时表「{}」。可能上游步骤已删除或未生成，请重新选择该步骤的输入表后再执行。",
                    step.name, tid
                ));
            }
        }
        deps.insert(step.id.clone(), need);
    }

    let mut include: HashSet<String> = HashSet::new();
    if let Some(uid) = until_step_id {
        if !by_id.contains_key(uid) {
            return Err(format!("步骤不存在: {uid}"));
        }
        let mut stack = vec![uid.to_string()];
        while let Some(id) = stack.pop() {
            if !include.insert(id.clone()) {
                continue;
            }
            if let Some(need) = deps.get(&id) {
                for p in need {
                    stack.push(p.clone());
                }
            }
        }
    } else {
        include = pipeline.steps.iter().map(|s| s.id.clone()).collect();
    }

    let mut indeg: HashMap<String, usize> = HashMap::new();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for id in &include {
        indeg.insert(id.clone(), 0);
    }
    for id in &include {
        for p in deps.get(id).into_iter().flatten() {
            if !include.contains(p) {
                continue;
            }
            *indeg.entry(id.clone()).or_insert(0) += 1;
            children.entry(p.clone()).or_default().push(id.clone());
        }
    }

    let mut ready: Vec<String> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| k.clone())
        .collect();
    ready.sort_by_key(|id| order_index.get(id.as_str()).copied().unwrap_or(usize::MAX));

    let mut out: Vec<&crate::models::Step> = Vec::new();
    while let Some(id) = ready.first().cloned() {
        ready.remove(0);
        let step = by_id
            .get(id.as_str())
            .copied()
            .ok_or_else(|| format!("步骤不存在: {id}"))?;
        out.push(step);
        if let Some(chs) = children.get(&id) {
            let mut newly = Vec::new();
            for c in chs {
                if let Some(d) = indeg.get_mut(c) {
                    *d = d.saturating_sub(1);
                    if *d == 0 {
                        newly.push(c.clone());
                    }
                }
            }
            ready.extend(newly);
            ready.sort_by_key(|id| order_index.get(id.as_str()).copied().unwrap_or(usize::MAX));
        }
    }

    if out.len() != include.len() {
        return Err("步骤之间存在循环依赖，无法执行。请检查步骤输入是否互相引用。".into());
    }
    Ok(out)
}

pub struct Runtime {
    pub sources: HashMap<String, DataTable>,
    pub source_meta: Vec<SourceTable>,
    pub temps: HashMap<String, DataTable>,
    pub header_rows: HashMap<String, usize>,
    pub folder_merges: HashMap<String, FolderMerge>,
}

impl Runtime {
    pub fn from_pipeline(pipeline: &Pipeline) -> Result<Self, String> {
        let dir = Path::new(&pipeline.source_dir);
        let meta = crate::excel_io::scan_directory(dir, &pipeline.header_rows)?;
        let meta = crate::source_match::apply_source_matchers(&meta, &pipeline.source_matchers);
        Ok(Self {
            sources: HashMap::new(),
            source_meta: meta,
            temps: HashMap::new(),
            header_rows: pipeline.header_rows.clone(),
            folder_merges: pipeline.folder_merges.clone(),
        })
    }

    pub fn from_scan(dir: &Path, header_rows: &HashMap<String, usize>) -> Result<Self, String> {
        let meta = crate::excel_io::scan_directory(dir, header_rows)?;
        Ok(Self {
            sources: HashMap::new(),
            source_meta: meta,
            temps: HashMap::new(),
            header_rows: header_rows.clone(),
            folder_merges: HashMap::new(),
        })
    }

    fn is_source_id(&self, id: &str) -> bool {
        self.source_meta.iter().any(|s| s.id == id)
    }

    fn ensure_source(&mut self, id: &str) -> Result<(), String> {
        if self.sources.contains_key(id) || self.temps.contains_key(id) {
            return Ok(());
        }
        if !self.is_source_id(id) {
            return Ok(());
        }
        let meta = self
            .source_meta
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("找不到源表「{id}」"))?;
        if meta.path.trim().is_empty() {
            let kw = if meta.match_keyword.is_empty() {
                meta.name.clone()
            } else {
                meta.match_keyword.clone()
            };
            return Err(format!(
                "源表「{}」未匹配到文件（关键字「{kw}」），请检查源目录或调整关键字",
                meta.name
            ));
        }
        if !meta.header_ok {
            return Err(format!(
                "源表「{}」表头未就绪，请先指定表头行",
                meta.name
            ));
        }
        let table = load_source_table(&meta, &self.header_rows, &self.folder_merges)?;
        self.sources.insert(id.to_string(), table);
        Ok(())
    }

    /// Source table ids directly referenced by steps (not intermediate tmp: outputs).
    pub fn used_source_ids(&self, pipeline: &Pipeline) -> HashSet<String> {
        let mut needed = HashSet::new();
        for step in &pipeline.steps {
            for id in op_table_ids(&step.operation) {
                if self.is_source_id(&id) {
                    needed.insert(id);
                }
            }
        }
        needed
    }

    fn ensure_sources_for_pipeline(
        &mut self,
        pipeline: &Pipeline,
        until_step_id: Option<&str>,
    ) -> Result<(), String> {
        let ordered = ordered_steps_for_run(pipeline, until_step_id)?;
        let mut needed: HashSet<String> = HashSet::new();
        for step in ordered {
            for id in op_table_ids(&step.operation) {
                if self.is_source_id(&id) {
                    needed.insert(id);
                }
            }
        }
        for id in needed {
            self.ensure_source(&id)?;
        }
        Ok(())
    }

    /// Load every healthy source (e.g. formula-template export of all data sheets).
    pub fn load_all_sources(&mut self) -> Result<(), String> {
        let ids: Vec<String> = self
            .source_meta
            .iter()
            .filter(|s| s.header_ok)
            .map(|s| s.id.clone())
            .collect();
        for id in ids {
            self.ensure_source(&id)?;
        }
        Ok(())
    }

    pub fn get_table(&self, id: &str) -> Result<&DataTable, String> {
        if let Some(t) = self.sources.get(id) {
            return Ok(t);
        }
        if let Some(t) = self.temps.get(id) {
            return Ok(t);
        }
        if id.starts_with("tmp:") {
            return Err(format!(
                "临时表「{id}」尚未生成或不存在。请确认上游步骤已配置且位于依赖链中；可用临时表: {:?}",
                self.temps.keys().collect::<Vec<_>>()
            ));
        }
        Err(format!(
            "找不到表「{id}」。可用源表: {:?}；临时表: {:?}",
            self.sources.keys().collect::<Vec<_>>(),
            self.temps.keys().collect::<Vec<_>>()
        ))
    }

    pub fn run_until(&mut self, pipeline: &Pipeline, until_step_id: Option<&str>) -> Result<(), String> {
        self.run_until_with_progress(pipeline, until_step_id, |_| {})
    }

    pub fn run_until_with_progress<F>(
        &mut self,
        pipeline: &Pipeline,
        until_step_id: Option<&str>,
        mut on_progress: F,
    ) -> Result<(), String>
    where
        F: FnMut(ExecuteStepProgress),
    {
        let ordered = ordered_steps_for_run(pipeline, until_step_id)?;
        let total = ordered.len();
        self.ensure_sources_for_pipeline(pipeline, until_step_id)?;
        self.temps.clear();
        for (i, step) in ordered.into_iter().enumerate() {
            on_progress(ExecuteStepProgress {
                index: i,
                total,
                step_id: step.id.clone(),
                step_name: step.name.clone(),
                phase: "start",
            });
            if !matches!(
                step.operation,
                Operation::Output { .. } | Operation::Start { .. }
            ) {
                let output = self.execute_step(step)?;
                self.temps.insert(step.output_table_id.clone(), output);
            }
            on_progress(ExecuteStepProgress {
                index: i,
                total,
                step_id: step.id.clone(),
                step_name: step.name.clone(),
                phase: "done",
            });
        }
        Ok(())
    }

    fn execute_step(&self, step: &crate::models::Step) -> Result<DataTable, String> {
        match &step.operation {
            Operation::Filter {
                input_table_id,
                conditions,
                match_mode,
            } => {
                let input = self.get_table(input_table_id)?;
                apply_filter(input, conditions, match_mode)
                    .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::Pivot {
                input_table_id,
                row_fields,
                value_fields,
                value_field,
                aggregation,
            } => {
                let input = self.get_table(input_table_id)?;
                apply_pivot(input, row_fields, value_fields, value_field, aggregation)
                    .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::Calculate {
                base_table_id,
                output_field,
                formula,
                columns,
                joins,
            } => {
                if base_table_id.trim().is_empty() {
                    return Err(format!("步骤「{}」: 请选择基准表", step.name));
                }
                let calc_cols = resolve_calc_columns(output_field, formula, columns);
                if calc_cols.is_empty() {
                    return Err(format!("步骤「{}」: 请至少添加一列计算", step.name));
                }
                let base = self.get_table(base_table_id)?;
                let mut tables: HashMap<String, &DataTable> = HashMap::new();
                tables.insert(base_table_id.clone(), base);

                let mut joins: Vec<crate::models::CalcJoin> = joins
                    .iter()
                    .filter(|j| !j.table_id.trim().is_empty())
                    .cloned()
                    .collect();

                for tid in formulas_table_ids(calc_cols.iter().map(|c| c.formula.as_str())) {
                    if tid == *base_table_id {
                        continue;
                    }
                    let foreign = self.get_table(&tid)?;
                    tables.entry(tid.clone()).or_insert(foreign);

                    // Only auto-join when a shared key can be guessed.
                    // SUMIF/COUNTIF 等整列函数不需要关联键。
                    if !joins.iter().any(|j| j.table_id == tid) {
                        if let Some((bk, fk)) =
                            crate::ops::guess_join_keys(&base.headers, &foreign.headers)
                        {
                            joins.push(crate::models::CalcJoin {
                                table_id: tid,
                                base_key: bk,
                                foreign_key: fk,
                            });
                        }
                    }
                }

                for j in &mut joins {
                    let foreign = if let Some(t) = tables.get(&j.table_id) {
                        *t
                    } else {
                        let t = self.get_table(&j.table_id)?;
                        tables.insert(j.table_id.clone(), t);
                        t
                    };
                    if j.base_key.trim().is_empty() || j.foreign_key.trim().is_empty() {
                        let Some((bk, fk)) =
                            crate::ops::guess_join_keys(&base.headers, &foreign.headers)
                        else {
                            return Err(format!(
                                "步骤「{}」: 无法自动猜测与表「{}」的关联键，请手动选择对应列（若只用 SUMIF 整列汇总可不添加关联）",
                                step.name, j.table_id
                            ));
                        };
                        if j.base_key.trim().is_empty() {
                            j.base_key = bk.clone();
                        }
                        if j.foreign_key.trim().is_empty() {
                            j.foreign_key = fk;
                        }
                    }
                }

                apply_calculate(&tables, base_table_id, &calc_cols, &joins)
                    .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::Sort {
                input_table_id,
                keys,
            } => {
                let input = self.get_table(input_table_id)?;
                apply_sort(input, keys).map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::Dedupe {
                input_table_id,
                columns,
            } => {
                let input = self.get_table(input_table_id)?;
                apply_dedupe(input, columns).map_err(|e| format!("步骤「{}」: {e}", step.name))
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
                let left = self.get_table(left_table_id)?;
                let right = self.get_table(right_table_id)?;
                apply_lookup_subtract(
                    left,
                    right,
                    left_key,
                    right_key,
                    left_value_field,
                    right_value_field,
                    output_field,
                )
                .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::SideBySide {
                cells,
                grid_rows,
                grid_cols,
                gap_cols,
                gap_rows,
                blocks,
                arrange,
                grid_columns,
                columns,
                table_ids,
            } => {
                let has_cells = cells.iter().any(|c| !c.table_id.trim().is_empty());
                if has_cells || (*grid_rows > 0 && *grid_cols > 0 && !cells.is_empty()) {
                    let mut map: HashMap<String, &DataTable> = HashMap::new();
                    for b in cells.iter().chain(blocks.iter()) {
                        if b.table_id.trim().is_empty() {
                            continue;
                        }
                        if !map.contains_key(&b.table_id) {
                            map.insert(b.table_id.clone(), self.get_table(&b.table_id)?);
                        }
                    }
                    let rows = if *grid_rows > 0 {
                        *grid_rows
                    } else {
                        1
                    };
                    let cols = if *grid_cols > 0 {
                        *grid_cols
                    } else {
                        (*grid_columns).max(1)
                    };
                    apply_side_by_side_layout(&map, cells, rows, cols, *gap_cols, *gap_rows)
                        .map_err(|e| format!("步骤「{}」: {e}", step.name))
                } else if !blocks.is_empty() {
                    let mut map: HashMap<String, &DataTable> = HashMap::new();
                    for b in blocks {
                        if b.table_id.trim().is_empty() {
                            continue;
                        }
                        if !map.contains_key(&b.table_id) {
                            map.insert(b.table_id.clone(), self.get_table(&b.table_id)?);
                        }
                    }
                    apply_side_by_side_blocks(
                        &map,
                        blocks,
                        arrange,
                        *gap_cols,
                        *gap_rows,
                        *grid_columns,
                    )
                    .map_err(|e| format!("步骤「{}」: {e}", step.name))
                } else if !columns.is_empty() {
                    let mut map: HashMap<String, &DataTable> = HashMap::new();
                    for c in columns {
                        if c.column.trim().is_empty() || c.table_id.trim().is_empty() {
                            continue;
                        }
                        if !map.contains_key(&c.table_id) {
                            map.insert(c.table_id.clone(), self.get_table(&c.table_id)?);
                        }
                    }
                    apply_side_by_side_columns(&map, columns)
                        .map_err(|e| format!("步骤「{}」: {e}", step.name))
                } else if !table_ids.is_empty() {
                    let legacy_blocks: Vec<crate::models::SideBlock> = table_ids
                        .iter()
                        .filter(|id| !id.trim().is_empty())
                        .map(|id| crate::models::SideBlock {
                            table_id: id.clone(),
                            columns: Vec::new(),
                        })
                        .collect();
                    let mut map: HashMap<String, &DataTable> = HashMap::new();
                    for b in &legacy_blocks {
                        map.insert(b.table_id.clone(), self.get_table(&b.table_id)?);
                    }
                    apply_side_by_side_blocks(&map, &legacy_blocks, "horizontal", 1, 1, 2)
                        .map_err(|e| format!("步骤「{}」: {e}", step.name))
                } else {
                    Err(format!("步骤「{}」: 请在拼版格子中选择表", step.name))
                }
            }
            Operation::Vlookup {
                left_table_id,
                left_key,
                right_table_id,
                right_key,
                left_columns,
                right_columns,
                lookups,
            } => {
                if left_table_id.trim().is_empty() {
                    return Err(format!("步骤「{}」: 请选择表A（基准表）", step.name));
                }
                let resolved = crate::ops::resolve_vlookup_lookups(
                    left_key,
                    right_table_id,
                    right_key,
                    right_columns,
                    lookups,
                );
                if resolved.is_empty() {
                    return Err(format!("步骤「{}」: 请至少添加一张查找表", step.name));
                }
                for (i, r) in resolved.iter().enumerate() {
                    if r.table_id.trim().is_empty() {
                        return Err(format!(
                            "步骤「{}」: 第 {} 张查找表未选择",
                            step.name,
                            i + 1
                        ));
                    }
                }
                let left = self.get_table(left_table_id)?;
                let right_tables: Vec<&DataTable> = resolved
                    .iter()
                    .map(|r| self.get_table(&r.table_id))
                    .collect::<Result<_, _>>()?;
                let refs: Vec<_> = resolved
                    .iter()
                    .zip(right_tables.iter())
                    .map(|(r, t)| {
                        (
                            *t,
                            r.left_key.as_str(),
                            r.right_key.as_str(),
                            r.columns.as_slice(),
                        )
                    })
                    .collect();
                apply_vlookup_multi(left, left_columns, &refs)
                    .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::FullJoin {
                left_table_id,
                right_table_id,
                left_key,
                right_key,
                left_columns,
                right_columns,
            } => {
                if left_table_id.trim().is_empty() {
                    return Err(format!("步骤「{}」: 请选择表A", step.name));
                }
                if right_table_id.trim().is_empty() {
                    return Err(format!("步骤「{}」: 请选择表B", step.name));
                }
                let left = self.get_table(left_table_id)?;
                let right = self.get_table(right_table_id)?;
                apply_full_join(
                    left,
                    right,
                    left_key,
                    right_key,
                    left_columns,
                    right_columns,
                )
                .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
            Operation::Output { .. } => Err(format!(
                "步骤「{}」是输出节点，无需单独执行",
                step.name
            )),
            Operation::Start { .. } => Err(format!(
                "步骤「{}」是开始节点，无需单独执行",
                step.name
            )),
        }
    }

    pub fn preview_step(
        &mut self,
        pipeline: &Pipeline,
        step_id: &str,
        limit: usize,
    ) -> Result<PreviewData, String> {
        self.run_until(pipeline, Some(step_id))?;
        let step = pipeline
            .steps
            .iter()
            .find(|s| s.id == step_id)
            .ok_or_else(|| format!("步骤不存在: {step_id}"))?;
        let table = self
            .temps
            .get(&step.output_table_id)
            .ok_or_else(|| "步骤无输出".to_string())?;
        Ok(table.preview(limit))
    }
}

#[cfg(test)]
mod order_tests {
    use super::ordered_steps_for_run;
    use crate::models::{Operation, Pipeline, Step};
    use std::collections::HashMap;

    fn filter_step(id: &str, out: &str, input: &str) -> Step {
        Step {
            id: id.into(),
            name: id.into(),
            output_table_id: out.into(),
            operation: Operation::Filter {
                input_table_id: input.into(),
                conditions: vec![],
                match_mode: "and".into(),
            },
            result: None,
        }
    }

    #[test]
    fn topo_runs_producer_before_consumer_even_if_listed_later() {
        let pipeline = Pipeline {
            id: "p".into(),
            name: "p".into(),
            source_dir: "".into(),
            output_dir: "".into(),
            header_rows: HashMap::new(),
            output_sheets: vec![],
            folder_merges: HashMap::new(),
            flow_positions: HashMap::new(),
            flow_edges: vec![],
            source_matchers: vec![],
            prompt_fields: vec![],
            // Consumer listed BEFORE producer in the array
            steps: vec![
                filter_step("consumer", "tmp:c", "tmp:p"),
                filter_step("producer", "tmp:p", "src:a"),
            ],
        };
        let ordered = ordered_steps_for_run(&pipeline, None).unwrap();
        assert_eq!(ordered[0].id, "producer");
        assert_eq!(ordered[1].id, "consumer");
    }

    #[test]
    fn dangling_tmp_gives_clear_error() {
        let pipeline = Pipeline {
            id: "p".into(),
            name: "p".into(),
            source_dir: "".into(),
            output_dir: "".into(),
            header_rows: HashMap::new(),
            output_sheets: vec![],
            folder_merges: HashMap::new(),
            flow_positions: HashMap::new(),
            flow_edges: vec![],
            source_matchers: vec![],
            prompt_fields: vec![],
            steps: vec![filter_step("x", "tmp:x", "tmp:missing")],
        };
        let err = ordered_steps_for_run(&pipeline, None).unwrap_err();
        assert!(err.contains("不存在的临时表"));
        assert!(err.contains("tmp:missing"));
    }
}
