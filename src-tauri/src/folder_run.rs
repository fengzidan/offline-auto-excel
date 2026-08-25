use crate::engine::op_table_ids;
use crate::excel_io::scan_directory;
use crate::models::{ExecuteResult, Pipeline};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Source ids referenced by steps (`src:…`), regardless of whether they exist on disk.
pub fn required_source_ids(pipeline: &Pipeline) -> HashSet<String> {
    let mut ids = HashSet::new();
    for step in &pipeline.steps {
        for id in op_table_ids(&step.operation) {
            if id.starts_with("src:") {
                ids.insert(id);
            }
        }
    }
    ids
}

fn basename_key(path: &str) -> Vec<String> {
    let p = Path::new(path);
    let mut keys = Vec::new();
    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
        keys.push(name.to_string());
    }
    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
        keys.push(stem.to_string());
    }
    keys
}

/// Map old absolute/relative header-row paths onto files in `folder` by same file/folder name.
pub fn remap_header_rows(
    old: &HashMap<String, usize>,
    folder: &Path,
) -> Result<HashMap<String, usize>, String> {
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (path, row) in old {
        for key in basename_key(path) {
            by_name.entry(key).or_insert(*row);
        }
    }

    let mut mapped = HashMap::new();
    let entries = std::fs::read_dir(folder).map_err(|e| format!("无法读取文件夹: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.starts_with('.') {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let row = by_name
            .get(&name)
            .or_else(|| by_name.get(&stem))
            .copied();
        if let Some(row) = row {
            mapped.insert(path.display().to_string(), row);
        }
    }
    Ok(mapped)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRunPrep {
    pub pipeline: Pipeline,
    pub missing_tables: Vec<String>,
    pub header_unready: Vec<String>,
}

/// Point a scheme at `folder`: reuse header rows by same-named files, set source/output dirs.
pub fn prepare_scheme_for_folder(
    mut pipeline: Pipeline,
    folder: &Path,
) -> Result<FolderRunPrep, String> {
    if !folder.is_dir() {
        return Err(format!("不是有效文件夹: {}", folder.display()));
    }
    let folder_str = folder
        .canonicalize()
        .unwrap_or_else(|_| folder.to_path_buf())
        .display()
        .to_string();

    pipeline.header_rows = remap_header_rows(&pipeline.header_rows, folder)?;
    pipeline.source_dir = folder_str.clone();
    // Write results into the folder being processed
    pipeline.output_dir = folder_str;

    let meta = scan_directory(Path::new(&pipeline.source_dir), &pipeline.header_rows)?;
    let present: HashSet<String> = meta.iter().map(|t| t.id.clone()).collect();
    let required = required_source_ids(&pipeline);

    let mut missing_tables: Vec<String> = required
        .iter()
        .filter(|id| !present.contains(*id))
        .map(|id| id.strip_prefix("src:").unwrap_or(id).to_string())
        .collect();
    missing_tables.sort();

    let mut header_unready: Vec<String> = meta
        .iter()
        .filter(|t| required.contains(&t.id) && !t.header_ok)
        .map(|t| t.name.clone())
        .collect();
    header_unready.sort();

    Ok(FolderRunPrep {
        pipeline,
        missing_tables,
        header_unready,
    })
}

/// Load scheme, bind to folder, execute. Fails early if required tables are missing.
pub fn execute_scheme_in_folder(
    app: &tauri::AppHandle,
    scheme_id: &str,
    folder: &Path,
) -> Result<ExecuteResult, String> {
    let pipeline = crate::schemes::load_scheme(app, scheme_id)?;
    let prep = prepare_scheme_for_folder(pipeline, folder)?;
    if !prep.missing_tables.is_empty() {
        return Err(format!(
            "当前文件夹中未找到方案所需的表（需与方案内文件同名）：{}",
            prep.missing_tables.join("、")
        ));
    }
    if !prep.header_unready.is_empty() {
        return Err(format!(
            "以下同名表无法按方案表头行读取（请确认文件内容一致）：{}",
            prep.header_unready.join("、")
        ));
    }
    crate::commands::run_pipeline_inner(prep.pipeline)
}

/// Resolve a path that may be relative to cwd.
pub fn resolve_folder_arg(raw: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(raw.trim());
    if p.as_os_str().is_empty() {
        return Err("文件夹路径为空".into());
    }
    if p.is_dir() {
        return Ok(p.canonicalize().unwrap_or(p));
    }
    Err(format!("不是有效文件夹: {}", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn remap_matches_by_filename() {
        let dir = std::env::temp_dir().join("ae_folder_run_remap");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("demo.xlsx");
        fs::write(&f, b"PK").unwrap(); // placeholder; remap only needs path

        let mut old = HashMap::new();
        old.insert("/old/path/demo.xlsx".into(), 7usize);
        let mapped = remap_header_rows(&old, &dir).unwrap();
        assert_eq!(mapped.get(&f.display().to_string()), Some(&7));
    }
}
