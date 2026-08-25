use crate::excel_io::{apply_filter, read_excel_first_sheet, read_folder_merged};
use crate::models::{DataTable, FolderMerge, Operation, Pipeline, PreviewData, SourceTable};
use crate::ops::{
    apply_calculate, apply_dedupe, apply_lookup_subtract, apply_pivot, apply_side_by_side,
    apply_side_by_side_columns, apply_sort, apply_vlookup, formula_table_ids,
};
use std::collections::{HashMap, HashSet};
use std::path::Path;

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
            formula,
            joins,
            ..
        } => {
            let mut ids = vec![base_table_id.clone()];
            for j in joins {
                if !j.table_id.trim().is_empty() {
                    ids.push(j.table_id.clone());
                }
            }
            for tid in formula_table_ids(formula) {
                ids.push(tid);
            }
            ids
        }
        Operation::LookupSubtract {
            left_table_id,
            right_table_id,
            ..
        }
        | Operation::Vlookup {
            left_table_id,
            right_table_id,
            ..
        } => vec![left_table_id.clone(), right_table_id.clone()],
        Operation::SideBySide { columns, table_ids } => {
            let mut ids: Vec<String> = columns
                .iter()
                .filter(|c| !c.table_id.trim().is_empty())
                .map(|c| c.table_id.clone())
                .collect();
            ids.extend(table_ids.iter().cloned());
            ids
        }
    }
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
        let mut needed: HashSet<String> = HashSet::new();
        for step in &pipeline.steps {
            for id in op_table_ids(&step.operation) {
                if self.is_source_id(&id) {
                    needed.insert(id);
                }
            }
            if until_step_id == Some(step.id.as_str()) {
                break;
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
        Err(format!(
            "找不到表「{id}」。可用源表: {:?}；临时表: {:?}",
            self.sources.keys().collect::<Vec<_>>(),
            self.temps.keys().collect::<Vec<_>>()
        ))
    }

    pub fn run_until(&mut self, pipeline: &Pipeline, until_step_id: Option<&str>) -> Result<(), String> {
        self.ensure_sources_for_pipeline(pipeline, until_step_id)?;
        self.temps.clear();
        for step in &pipeline.steps {
            let output = self.execute_step(step)?;
            self.temps.insert(step.output_table_id.clone(), output);
            if until_step_id == Some(step.id.as_str()) {
                break;
            }
        }
        Ok(())
    }

    fn execute_step(&self, step: &crate::models::Step) -> Result<DataTable, String> {
        match &step.operation {
            Operation::Filter {
                input_table_id,
                conditions,
            } => {
                let input = self.get_table(input_table_id)?;
                apply_filter(input, conditions).map_err(|e| format!("步骤「{}」: {e}", step.name))
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
                joins,
            } => {
                if base_table_id.trim().is_empty() {
                    return Err(format!("步骤「{}」: 请选择基准表", step.name));
                }
                let base = self.get_table(base_table_id)?;
                let mut tables: HashMap<String, &DataTable> = HashMap::new();
                tables.insert(base_table_id.clone(), base);

                let mut joins: Vec<crate::models::CalcJoin> = joins
                    .iter()
                    .filter(|j| !j.table_id.trim().is_empty())
                    .cloned()
                    .collect();

                for tid in formula_table_ids(formula) {
                    if tid == *base_table_id {
                        continue;
                    }
                    let foreign = self.get_table(&tid)?;
                    tables.entry(tid.clone()).or_insert(foreign);

                    if !joins.iter().any(|j| j.table_id == tid) {
                        joins.push(crate::models::CalcJoin {
                            table_id: tid,
                            base_key: String::new(),
                            foreign_key: String::new(),
                        });
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
                                "步骤「{}」: 无法自动猜测与表「{}」的关联键，请手动选择对应列",
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

                apply_calculate(&tables, base_table_id, output_field, formula, &joins)
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
            Operation::SideBySide { columns, table_ids } => {
                if !columns.is_empty() {
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
                    let tables: Result<Vec<_>, _> =
                        table_ids.iter().map(|id| self.get_table(id)).collect();
                    let tables = tables.map_err(|e| format!("步骤「{}」: {e}", step.name))?;
                    apply_side_by_side(&tables)
                        .map_err(|e| format!("步骤「{}」: {e}", step.name))
                } else {
                    Err(format!("步骤「{}」: 请选择要拼版的列", step.name))
                }
            }
            Operation::Vlookup {
                left_table_id,
                right_table_id,
                left_key,
                right_key,
                left_columns,
                right_columns,
            } => {
                if left_table_id.trim().is_empty() || right_table_id.trim().is_empty() {
                    return Err(format!("步骤「{}」: 请选择表A与表B", step.name));
                }
                let left = self.get_table(left_table_id)?;
                let right = self.get_table(right_table_id)?;
                apply_vlookup(
                    left,
                    right,
                    left_key,
                    right_key,
                    left_columns,
                    right_columns,
                )
                .map_err(|e| format!("步骤「{}」: {e}", step.name))
            }
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
