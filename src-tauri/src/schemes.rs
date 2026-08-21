use crate::models::{Pipeline, SchemeSummary};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

fn schemes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("schemes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn scheme_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

pub fn list_schemes(app: &AppHandle) -> Result<Vec<SchemeSummary>, String> {
    let dir = schemes_dir(app)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let pipeline: Pipeline =
            serde_json::from_str(&text).map_err(|e| format!("解析方案失败 {}: {e}", path.display()))?;
        let meta = entry.metadata().ok();
        let updated_at = meta
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                dt.format("%Y-%m-%d %H:%M").to_string()
            })
            .unwrap_or_default();
        items.push(SchemeSummary {
            id: if pipeline.id.is_empty() {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            } else {
                pipeline.id
            },
            name: pipeline.name,
            source_dir: pipeline.source_dir,
            updated_at,
        });
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

pub fn load_scheme(app: &AppHandle, id: &str) -> Result<Pipeline, String> {
    let path = scheme_path(&schemes_dir(app)?, id);
    let text = fs::read_to_string(&path).map_err(|e| format!("方案不存在: {e}"))?;
    let mut pipeline: Pipeline =
        serde_json::from_str(&text).map_err(|e| format!("解析失败: {e}"))?;
    if pipeline.id.is_empty() {
        pipeline.id = id.to_string();
    }
    Ok(pipeline)
}

pub fn save_scheme(app: &AppHandle, mut pipeline: Pipeline) -> Result<Pipeline, String> {
    if pipeline.id.trim().is_empty() {
        pipeline.id = Uuid::new_v4().to_string();
    }
    if pipeline.name.trim().is_empty() {
        pipeline.name = "未命名方案".into();
    }
    let path = scheme_path(&schemes_dir(app)?, &pipeline.id);
    let json = serde_json::to_string_pretty(&pipeline).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(pipeline)
}

pub fn delete_scheme(app: &AppHandle, id: &str) -> Result<(), String> {
    let path = scheme_path(&schemes_dir(app)?, id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn rename_scheme(app: &AppHandle, id: &str, name: &str) -> Result<Pipeline, String> {
    let mut pipeline = load_scheme(app, id)?;
    pipeline.name = name.trim().to_string();
    if pipeline.name.is_empty() {
        return Err("方案名称不能为空".into());
    }
    save_scheme(app, pipeline)
}

pub fn copy_scheme(app: &AppHandle, id: &str) -> Result<Pipeline, String> {
    let mut pipeline = load_scheme(app, id)?;
    let existing: Vec<String> = list_schemes(app)?.into_iter().map(|s| s.name).collect();
    pipeline.id = Uuid::new_v4().to_string();
    pipeline.name = unique_copy_name(&pipeline.name, &existing);
    save_scheme(app, pipeline)
}

fn unique_copy_name(original: &str, existing: &[String]) -> String {
    let base = format!("{original} 副本");
    if !existing.iter().any(|n| n == &base) {
        return base;
    }
    let mut n = 2usize;
    loop {
        let candidate = format!("{base} {n}");
        if !existing.iter().any(|name| name == &candidate) {
            return candidate;
        }
        n += 1;
    }
}
