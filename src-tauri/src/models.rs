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
        output_field: String,
        formula: String,
        #[serde(default)]
        joins: Vec<CalcJoin>,
    },
    #[serde(rename_all = "camelCase")]
    Sort {
        input_table_id: String,
        keys: Vec<SortKey>,
    },
    /// Keep first row for each unique key formed by `columns` (empty = all columns).
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
        /// Ordered columns to place left-to-right. Empty `column` means a spacer column.
        #[serde(default)]
        columns: Vec<SideColumn>,
        /// Legacy: whole tables (converted when columns empty)
        #[serde(default)]
        table_ids: Vec<String>,
    },
    /// VLOOKUP-style: match a key column between table A and B, then append columns.
    #[serde(rename_all = "camelCase")]
    Vlookup {
        left_table_id: String,
        right_table_id: String,
        left_key: String,
        right_key: String,
        /// Columns from A to keep. Empty = all of A, original order.
        #[serde(default)]
        left_columns: Vec<String>,
        /// Columns from B to append. Empty = all of B, original order.
        #[serde(default)]
        right_columns: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideColumn {
    pub table_id: String,
    /// Empty string = spacer / empty column
    #[serde(default)]
    pub column: String,
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
        }
    }
}
