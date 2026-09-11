use crate::engine::op_table_ids;
use crate::excel_io::scan_directory;
use crate::models::{ExecuteResult, Operation, Pipeline};
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
        if !stem.starts_with("src:") {
            keys.push(format!("src:{stem}"));
        }
    }
    // Stable matcher id already stored as key
    if path.starts_with("src:") {
        keys.push(path.to_string());
    }
    keys
}

/// Expand header-row map with portable keys (basename / stem / src:id) for export & reuse.
pub fn enrich_header_rows(old: &HashMap<String, usize>) -> HashMap<String, usize> {
    let mut out = old.clone();
    for (path, row) in old {
        for key in basename_key(path) {
            out.entry(key).or_insert(*row);
        }
    }
    out
}

/// Map old absolute/relative header-row paths onto files in `folder` by same file/folder name.
pub fn remap_header_rows(
    old: &HashMap<String, usize>,
    folder: &Path,
) -> Result<HashMap<String, usize>, String> {
    let enriched = enrich_header_rows(old);
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (path, row) in &enriched {
        for key in basename_key(path) {
            by_name.entry(key).or_insert(*row);
        }
        // Also keep raw key lookup (e.g. src:人员清单)
        by_name.entry(path.clone()).or_insert(*row);
    }

    let mut mapped = HashMap::new();
    // Preserve portable keys so future exports / remaps still work
    for (path, row) in &enriched {
        if path.starts_with("src:")
            || !path.contains('/') && !path.contains('\\')
            || Path::new(path).components().count() == 1
        {
            mapped.insert(path.clone(), *row);
        }
    }

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
            .or_else(|| by_name.get(&format!("src:{stem}")))
            .copied();
        if let Some(row) = row {
            let path_str = path.display().to_string();
            mapped.insert(path_str, row);
            mapped.insert(name, row);
            if !stem.is_empty() {
                mapped.insert(stem.clone(), row);
                mapped.insert(format!("src:{stem}"), row);
            }
        }
    }
    Ok(mapped)
}

fn effective_source_dir(pipeline: &Pipeline) -> String {
    if let Some(start) = pipeline
        .steps
        .iter()
        .find(|s| matches!(s.operation, Operation::Start { .. }))
    {
        if let Operation::Start { source_dir } = &start.operation {
            if !source_dir.trim().is_empty() {
                return source_dir.clone();
            }
        }
    }
    pipeline.source_dir.clone()
}

fn paths_same_dir(folder: &Path, other: &str) -> bool {
    let other = other.trim();
    if other.is_empty() {
        return false;
    }
    let canon_folder = folder
        .canonicalize()
        .unwrap_or_else(|_| folder.to_path_buf());
    let other_path = PathBuf::from(other);
    let canon_other = other_path
        .canonicalize()
        .unwrap_or_else(|_| other_path.clone());
    if canon_folder == canon_other {
        return true;
    }
    let norm = |p: &Path| {
        p.display()
            .to_string()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    norm(&canon_folder) == norm(&canon_other)
}

fn set_pipeline_dirs(pipeline: &mut Pipeline, folder_str: &str) {
    pipeline.source_dir = folder_str.to_string();
    pipeline.output_dir = folder_str.to_string();
    for step in &mut pipeline.steps {
        match &mut step.operation {
            Operation::Start { source_dir } => {
                *source_dir = folder_str.to_string();
            }
            Operation::Output { output_dir, .. } => {
                *output_dir = folder_str.to_string();
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRunPrep {
    pub pipeline: Pipeline,
    pub missing_tables: Vec<String>,
    pub header_unready: Vec<String>,
    /// Whether source/output dirs were rewritten to the target folder.
    pub dirs_changed: bool,
}

/// Point a scheme at `folder`: reuse header rows by same-named files, set source/output dirs.
/// If `folder` already matches the scheme's source folder, dirs are left unchanged.
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

    let scheme_source = effective_source_dir(&pipeline);
    let dirs_changed = !paths_same_dir(folder, &scheme_source);

    if dirs_changed {
        pipeline.header_rows = remap_header_rows(&pipeline.header_rows, folder)?;
        set_pipeline_dirs(&mut pipeline, &folder_str);
    } else {
        // Same folder: keep dirs; still enrich portable header keys for lookup.
        pipeline.header_rows = enrich_header_rows(&pipeline.header_rows);
        // Remap absolute keys onto current files in case paths drifted (symlink etc.)
        if let Ok(mapped) = remap_header_rows(&pipeline.header_rows, folder) {
            pipeline.header_rows = mapped;
        }
    }

    let meta = scan_directory(Path::new(&pipeline.source_dir), &pipeline.header_rows)?;
    let meta = crate::source_match::apply_source_matchers(&meta, &pipeline.source_matchers);
    let present: HashSet<String> = meta
        .iter()
        .filter(|t| t.header_ok && !t.path.is_empty())
        .map(|t| t.id.clone())
        .collect();
    let required = required_source_ids(&pipeline);

    let mut missing_tables: Vec<String> = required
        .iter()
        .filter(|id| !present.contains(*id))
        .map(|id| {
            pipeline
                .source_matchers
                .iter()
                .find(|m| m.id == *id)
                .map(|m| {
                    if m.keyword.is_empty() {
                        m.id.strip_prefix("src:").unwrap_or(&m.id).to_string()
                    } else {
                        format!(
                            "{}（关键字「{}」）",
                            m.id.strip_prefix("src:").unwrap_or(&m.id),
                            m.keyword
                        )
                    }
                })
                .unwrap_or_else(|| id.strip_prefix("src:").unwrap_or(id).to_string())
        })
        .collect();
    missing_tables.sort();

    let mut header_unready: Vec<String> = meta
        .iter()
        .filter(|t| required.contains(&t.id) && !t.path.is_empty() && !t.header_ok)
        .map(|t| t.name.clone())
        .collect();
    header_unready.sort();

    Ok(FolderRunPrep {
        pipeline,
        missing_tables,
        header_unready,
        dirs_changed,
    })
}

/// Load scheme, bind to folder, persist dirs only when they changed, then execute.
pub fn execute_scheme_in_folder(
    app: &tauri::AppHandle,
    scheme_id: &str,
    folder: &Path,
    runtime_params: Option<&HashMap<String, String>>,
) -> Result<ExecuteResult, String> {
    let pipeline = crate::schemes::load_scheme(app, scheme_id)?;
    let prep = prepare_scheme_for_folder(pipeline, folder)?;
    if !prep.missing_tables.is_empty() {
        return Err(format!(
            "当前文件夹中未找到方案所需的表（可按关键字模糊匹配）：{}",
            prep.missing_tables.join("、")
        ));
    }
    if !prep.header_unready.is_empty() {
        return Err(format!(
            "以下同名表无法按方案表头行读取（请确认文件内容一致）：{}",
            prep.header_unready.join("、")
        ));
    }
    // Only persist when the right-clicked folder differs from the scheme source folder.
    let saved = if prep.dirs_changed {
        crate::schemes::save_scheme(app, prep.pipeline)?
    } else {
        prep.pipeline
    };
    let values = runtime_params.cloned().unwrap_or_default();
    let fields = crate::runtime_params::collect_prompt_fields(&saved);
    crate::runtime_params::validate_runtime_params(&fields, &values)?;
    let ready = crate::runtime_params::apply_runtime_params(saved, &values);
    crate::commands::run_pipeline_inner(Some(app), ready)
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
        assert_eq!(mapped.get("demo.xlsx"), Some(&7));
        assert_eq!(mapped.get("src:demo"), Some(&7));
    }

    #[test]
    fn enrich_adds_portable_keys() {
        let mut old = HashMap::new();
        old.insert("/data/人员清单.xlsx".into(), 3usize);
        let enriched = enrich_header_rows(&old);
        assert_eq!(enriched.get("人员清单.xlsx"), Some(&3));
        assert_eq!(enriched.get("src:人员清单"), Some(&3));
    }
}
