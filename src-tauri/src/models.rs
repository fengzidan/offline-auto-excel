use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTable {
    pub id: String,
    pub name: String,
    pub path: String,
    pub headers: Vec<String>,
    pub row_count: usize,
    #[serde(default = "default_header_row")]
    pub header_row: usize,
    #[serde(default = "default_true")]
    pub header_ok: bool,
    #[serde(default)]
    pub header_message: String,
    /// "file" | "folder"
    #[serde(default = "default_file_kind")]
    pub kind: String,
    #[serde(default)]
    pub file_count: usize,
    /// For folder sources, a sample file used for header-row mapping.
    #[serde(default)]
    pub sample_path: String,
    /// When bound via sourceMatchers: the actual scanned file/folder name.
    #[serde(default)]
    pub matched_name: String,
    /// When bound via sourceMatchers: the keyword used.
    #[serde(default)]
    pub match_keyword: String,
}

fn default_header_row() -> usize {
    1
}
fn default_true() -> bool {
    true
}
fn default_file_kind() -> String {
    "file".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMerge {
    #[serde(default)]
    pub key_column: String,
}

/// Fuzzy bind a stable logical source id to scanned tables by keyword.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMatcher {
    /// Stable id used in steps / formulas, e.g. `src:人员清单`.
    pub id: String,
    /// Match against scanned file/folder name (contains, case-insensitive).
    pub keyword: String,
    /// Optional display label (defaults to keyword).
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub source_dir: String,
    pub output_dir: String,
    #[serde(default)]
    pub header_rows: HashMap<String, usize>,
    pub steps: Vec<Step>,
    /// Final export sheet order & names (step_id references). Empty = derive from steps.
    #[serde(default)]
    pub output_sheets: Vec<OutputSheet>,
    /// Per logical folder table: which column overwrites older rows.
    #[serde(default)]
    pub folder_merges: HashMap<String, FolderMerge>,
    /// Flowchart node positions `{ nodeId: { x, y } }`.
    #[serde(default)]
    pub flow_positions: HashMap<String, FlowPosition>,
    /// Flowchart edges (may diverge from step table bindings when reconnected).
    #[serde(default)]
    pub flow_edges: Vec<FlowEdgeSpec>,
    /// Fuzzy source name matchers (stable id ← keyword).
    #[serde(default)]
    pub source_matchers: Vec<SourceMatcher>,
    /// Runtime prompt fields; referenced as `${key}` in filter values etc.
    #[serde(default)]
    pub prompt_fields: Vec<PromptField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub default_value: String,
    #[serde(default = "default_true")]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdgeSpec {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub source_handle: Option<String>,
    #[serde(default)]
    pub target_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSheet {
    pub step_id: String,
    pub sheet_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemeSummary {
    pub id: String,
    pub name: String,
    pub source_dir: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub name: String,
    pub output_table_id: String,
    pub operation: Operation,
    #[serde(default)]
    pub result: Option<ResultSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSpec {
    pub enabled: bool,
    pub file_key: String,
    pub sheet_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotValue {
    pub field: String,
    #[serde(default = "default_sum")]
    pub aggregation: String,
    #[serde(default)]
    pub alias: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcJoin {
    pub table_id: String,
    pub base_key: String,
    pub foreign_key: String,
}

/// One output column produced by a calculate step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcColumn {
    pub output_field: String,
    pub formula: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    /// asc | desc
    #[serde(default = "default_asc")]
    pub direction: String,
}

fn default_asc() -> String {
    "asc".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Operation {
    #[serde(rename_all = "camelCase")]
    Filter {
        input_table_id: String,
        conditions: Vec<FilterCondition>,
        /// "and" | "or"；缺省为 and（兼容旧方案）
        #[serde(default = "default_filter_match_and")]
        match_mode: String,
    },
    #[serde(rename_all = "camelCase")]
    Pivot {
        input_table_id: String,
        row_fields: Vec<String>,
        #[serde(default)]
        value_fields: Vec<PivotValue>,
        #[serde(default)]
        value_field: String,
        #[serde(default = "default_sum")]
        aggregation: String,
    },
    #[serde(rename_all = "camelCase")]
    Calculate {
        base_table_id: String,
        /// Legacy single-column fields (used when `columns` is empty).
        #[serde(default)]
        output_field: String,
        #[serde(default)]
        formula: String,
        /// Multiple calculated columns in one step.
        #[serde(default)]
        columns: Vec<CalcColumn>,
        #[serde(default)]
        joins: Vec<CalcJoin>,
    },
    #[serde(rename_all = "camelCase")]
    Sort {
        input_table_id: String,
        keys: Vec<SortKey>,
    },
    /// 列数据去重：按指定列判断重复行并只留最先出现的一行（空 = 整行相同才去重）。
    #[serde(rename_all = "camelCase")]
    Dedupe {
        input_table_id: String,
        #[serde(default)]
        columns: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    LookupSubtract {
        left_table_id: String,
        right_table_id: String,
        left_key: String,
        right_key: String,
        left_value_field: String,
        right_value_field: String,
        output_field: String,
    },
    #[serde(rename_all = "camelCase")]
    SideBySide {
        /// Grid size (preferred).
        #[serde(default = "default_grid_rows")]
        grid_rows: usize,
        #[serde(default = "default_grid_cols")]
        grid_cols: usize,
        /// Row-major cells; empty table_id = vacant slot.
        #[serde(default)]
        cells: Vec<SideBlock>,
        /// Empty columns between grid cells. Default 1.
        #[serde(default = "default_gap_one")]
        gap_cols: usize,
        /// Empty rows between grid cells. Default 1.
        #[serde(default = "default_gap_one")]
        gap_rows: usize,
        /// Legacy flat blocks.
        #[serde(default)]
        blocks: Vec<SideBlock>,
        /// Legacy arrange: horizontal | vertical | grid
        #[serde(default = "default_side_arrange")]
        arrange: String,
        #[serde(default = "default_grid_columns")]
        grid_columns: usize,
        /// Legacy: ordered columns left-to-right.
        #[serde(default)]
        columns: Vec<SideColumn>,
        #[serde(default)]
        table_ids: Vec<String>,
    },
    /// VLOOKUP-style: match keys from table A into one or more right tables, then append columns.
    #[serde(rename_all = "camelCase")]
    Vlookup {
        left_table_id: String,
        /// Legacy single-right fields (used when `lookups` is empty).
        #[serde(default)]
        left_key: String,
        #[serde(default)]
        right_table_id: String,
        #[serde(default)]
        right_key: String,
        /// Columns from A to keep. Empty = all of A, original order.
        #[serde(default)]
        left_columns: Vec<String>,
        /// Legacy: columns from single right table B.
        #[serde(default)]
        right_columns: Vec<String>,
        /// Multiple right-table lookups (preferred).
        #[serde(default)]
        lookups: Vec<VlookupRight>,
    },
    /// Full outer join: keep all rows from A and B (unmatched side blank).
    #[serde(rename_all = "camelCase")]
    FullJoin {
        left_table_id: String,
        right_table_id: String,
        left_key: String,
        right_key: String,
        /// Columns from A. Empty = all.
        #[serde(default)]
        left_columns: Vec<String>,
        /// Columns from B. Empty = all.
        #[serde(default)]
        right_columns: Vec<String>,
    },
    /// Export sink: write connected tables to Excel (no table transform).
    #[serde(rename_all = "camelCase")]
    Output {
        #[serde(default)]
        output_dir: String,
        #[serde(default)]
        sheets: Vec<OutputSheetRef>,
    },
    /// Start / input: configure source directory (no table transform).
    #[serde(rename_all = "camelCase")]
    Start {
        #[serde(default)]
        source_dir: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSheetRef {
    pub table_id: String,
    #[serde(default)]
    pub sheet_name: String,
}

/// One right-hand table in a multi-table VLOOKUP step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VlookupRight {
    pub table_id: String,
    pub left_key: String,
    pub right_key: String,
    /// Columns to append from this table. Empty = all columns.
    #[serde(default)]
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideColumn {
    pub table_id: String,
    /// Empty string = spacer / empty column
    #[serde(default)]
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideBlock {
    pub table_id: String,
    /// Empty = all columns of the table
    #[serde(default)]
    pub columns: Vec<String>,
}

fn default_side_arrange() -> String {
    "grid".into()
}

fn default_gap_one() -> usize {
    1
}

fn default_grid_columns() -> usize {
    2
}

fn default_grid_rows() -> usize {
    1
}

fn default_grid_cols() -> usize {
    2
}

fn default_filter_match_and() -> String {
    "and".into()
}

fn default_sum() -> String {
    "sum".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCondition {
    pub column: String,
    pub op: String,
    #[serde(default)]
    pub value: String,
    /// How this condition combines with the previous one (`and` / `or`). First is ignored.
    /// Evaluation: consecutive `and` form a group; groups are OR-ed.
    #[serde(default = "default_and_join")]
    pub join: String,
}

impl Default for FilterCondition {
    fn default() -> Self {
        Self {
            column: String::new(),
            op: String::new(),
            value: String::new(),
            join: default_and_join(),
        }
    }
}

fn default_and_join() -> String {
    "and".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    /// Same meaning as DataTable.header_groups (per-column group for header color).
    #[serde(default)]
    pub header_groups: Vec<u32>,
    /// Extra header bands for multi-table sheet layouts (row is sheet row index).
    #[serde(default)]
    pub header_bands: Vec<HeaderBand>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderBand {
    pub row: usize,
    pub col: usize,
    pub groups: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSheetPreview {
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub output_files: Vec<String>,
    pub sheet_names: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct DataTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// Per-column group id for header coloring (e.g. vlookup: 0=表A, 1=表B).
    /// Empty = single default header style.
    pub header_groups: Vec<u32>,
    /// Skip autofilter / freeze; used by multi-table sheet layouts.
    pub plain_sheet: bool,
    /// Header rows to style (for layout sheets with multiple tables).
    pub header_bands: Vec<HeaderBand>,
}

impl DataTable {
    pub fn col_index(&self, name: &str) -> Result<usize, String> {
        self.headers
            .iter()
            .position(|h| h == name)
            .ok_or_else(|| {
                format!(
                    "列「{}」不存在。当前表头: [{}]。请在该步骤重新映射/选择列。",
                    name,
                    self.headers.join(", ")
                )
            })
    }

    pub fn preview(&self, limit: usize) -> PreviewData {
        PreviewData {
            headers: self.headers.clone(),
            rows: self.rows.iter().take(limit).cloned().collect(),
            total_rows: self.rows.len(),
            header_groups: self.header_groups.clone(),
            header_bands: self.header_bands.clone(),
        }
    }
}
