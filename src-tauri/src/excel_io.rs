use crate::models::DataTable;
use calamine::{open_workbook_auto, Data, Reader};
use chrono::{Local, NaiveDate};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const SOURCE_DATE_HEADER: &str = "来源日期";

fn is_excel(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|ext| {
            let ext = ext.to_lowercase();
            ext == "xlsx" || ext == "xlsm" || ext == "xls"
        })
        .unwrap_or(false)
}

fn list_excel_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_excel(p))
        .collect();
    files.sort();
    Ok(files)
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Parse YYYY-MM-DD from filename (e.g. 20260819 / 2026-08-19); else file mtime.
pub fn parse_source_date(name: &str, mtime: Option<SystemTime>) -> String {
    if let Some(d) = extract_date_from_name(name) {
        return d;
    }
    if let Some(t) = mtime {
        let dt: chrono::DateTime<Local> = t.into();
        return dt.format("%Y-%m-%d").to_string();
    }
    String::new()
}

fn extract_date_from_name(name: &str) -> Option<String> {
    let n = name
        .replace('年', "-")
        .replace('月', "-")
        .replace('日', "-");
    let chars: Vec<char> = n.chars().collect();
    let len = chars.len();
    for i in 0..len {
        if let Some(d) = try_ymd_at(&chars, i) {
            return Some(d);
        }
        if let Some(d) = try_yyyymmdd_at(&chars, i) {
            return Some(d);
        }
    }
    None
}

fn try_yyyymmdd_at(chars: &[char], i: usize) -> Option<String> {
    if i + 8 > chars.len() {
        return None;
    }
    let slice: String = chars[i..i + 8].iter().collect();
    if !slice.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !slice.starts_with("19") && !slice.starts_with("20") {
        return None;
    }
    let y: i32 = slice[0..4].parse().ok()?;
    let m: u32 = slice[4..6].parse().ok()?;
    let d: u32 = slice[6..8].parse().ok()?;
    format_valid_date(y, m, d)
}

fn try_ymd_at(chars: &[char], i: usize) -> Option<String> {
    if i + 8 > chars.len() {
        return None;
    }
    let rest: String = chars[i..].iter().collect();
    let mut it = rest.chars();
    let mut y = String::new();
    for _ in 0..4 {
        let c = it.next()?;
        if !c.is_ascii_digit() {
            return None;
        }
        y.push(c);
    }
    if !y.starts_with("19") && !y.starts_with("20") {
        return None;
    }
    let sep1 = it.next()?;
    if sep1 != '-' && sep1 != '_' && sep1 != '.' && sep1 != '/' {
        return None;
    }
    let mut m = String::new();
    let sep2: char;
    loop {
        let c = it.next()?;
        if c.is_ascii_digit() {
            m.push(c);
            if m.len() == 2 {
                sep2 = it.next()?;
                break;
            }
        } else if !m.is_empty() {
            sep2 = c;
            break;
        } else {
            return None;
        }
    }
    if sep2 != '-' && sep2 != '_' && sep2 != '.' && sep2 != '/' {
        return None;
    }
    let mut d = String::new();
    for c in it {
        if c.is_ascii_digit() {
            d.push(c);
            if d.len() == 2 {
                break;
            }
        } else {
            break;
        }
    }
    if m.is_empty() || d.is_empty() {
        return None;
    }
    format_valid_date(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)
}

fn format_valid_date(y: i32, m: u32, d: u32) -> Option<String> {
    NaiveDate::from_ymd_opt(y, m, d).map(|dt| dt.format("%Y-%m-%d").to_string())
}

struct RankedFile {
    path: PathBuf,
    date: String,
    mtime: u64,
}

fn rank_excel_files(files: Vec<PathBuf>) -> Vec<RankedFile> {
    let mut ranked: Vec<RankedFile> = files
        .into_iter()
        .map(|path| {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let mtime = file_mtime(&path);
            let date = parse_source_date(&stem, mtime);
            let mtime_secs = mtime
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            RankedFile {
                path,
                date,
                mtime: mtime_secs,
            }
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.mtime.cmp(&b.mtime))
            .then(a.path.cmp(&b.path))
    });
    ranked
}

fn header_override_for(
    header_overrides: &HashMap<String, usize>,
    file_path: &str,
    folder_path: Option<&str>,
) -> Option<usize> {
    header_overrides
        .get(file_path)
        .copied()
        .or_else(|| folder_path.and_then(|fp| header_overrides.get(fp).copied()))
}

fn canonical_merge_key(s: &str) -> String {
    match_key(s)
}

/// Merge dated tables (old → new). Same key keeps the newest row. Adds 来源日期.
pub fn merge_dated_tables(
    parts: &[(String, DataTable)],
    key_column: &str,
) -> Result<DataTable, String> {
    if parts.is_empty() {
        return Err("子文件夹中没有可合并的表".into());
    }
    let mut headers: Vec<String> = Vec::new();
    for (_, t) in parts {
        for h in &t.headers {
            if h == SOURCE_DATE_HEADER {
                continue;
            }
            if !headers.iter().any(|x| x == h) {
                headers.push(h.clone());
            }
        }
    }
    headers.push(SOURCE_DATE_HEADER.to_string());

    let key_idx = if key_column.trim().is_empty() {
        None
    } else {
        Some(headers.iter().position(|h| h == key_column).ok_or_else(|| {
            format!(
                "覆盖键列「{key_column}」不在累计表中。当前列: [{}]",
                headers.join(", ")
            )
        })?)
    };
    let date_idx = headers.len() - 1;

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for (date, table) in parts {
        let col_map: Vec<Option<usize>> = headers
            .iter()
            .take(headers.len() - 1)
            .map(|h| table.headers.iter().position(|x| x == h))
            .collect();
        for src in &table.rows {
            let mut out = vec![String::new(); headers.len()];
            for (i, src_idx) in col_map.iter().enumerate() {
                if let Some(si) = src_idx {
                    out[i] = src.get(*si).cloned().unwrap_or_default();
                }
            }
            out[date_idx] = date.clone();
            if let Some(ki) = key_idx {
                let key = canonical_merge_key(out.get(ki).map(|s| s.as_str()).unwrap_or(""));
                if key.is_empty() {
                    rows.push(out);
                } else if let Some(&idx) = index.get(&key) {
                    rows[idx] = out;
                } else {
                    index.insert(key, rows.len());
                    rows.push(out);
                }
            } else {
                rows.push(out);
            }
        }
    }

    Ok(DataTable { headers, rows, ..Default::default() })
}

pub fn read_folder_merged(
    folder: &Path,
    header_overrides: &HashMap<String, usize>,
    key_column: &str,
) -> Result<DataTable, String> {
    let files = list_excel_files(folder)?;
    if files.is_empty() {
        return Err(format!("子文件夹中没有 Excel: {}", folder.display()));
    }
    let ranked = rank_excel_files(files);
    let folder_str = folder.display().to_string();
    let mut parts: Vec<(String, DataTable)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for f in &ranked {
        let path_str = f.path.display().to_string();
        let file_name = f
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path_str.as_str());
        let override_row = header_override_for(header_overrides, &path_str, Some(&folder_str));
        match read_excel_first_sheet(&f.path, override_row) {
            Ok((table, _)) => {
                if !key_column.trim().is_empty() && !table.headers.iter().any(|h| h == key_column)
                {
                    errors.push(format!(
                        "「{file_name}」缺少覆盖键列「{key_column}」。当前表头: [{}]",
                        table.headers.join(", ")
                    ));
                } else {
                    parts.push((f.date.clone(), table));
                }
            }
            Err(e) => errors.push(format!("「{file_name}」: {e}")),
        }
    }

    if !errors.is_empty() {
        return Err(format!(
            "累计文件夹「{}」有 {} 个文件不符合规范，已中止合并：\n{}",
            folder
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&folder_str),
            errors.len(),
            errors
                .iter()
                .enumerate()
                .map(|(i, e)| format!("{}. {e}", i + 1))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if parts.is_empty() {
        return Err(format!(
            "子文件夹「{}」没有可读的 Excel",
            folder.display()
        ));
    }
    merge_dated_tables(&parts, key_column)
}

/// Preview cumulative folder using only the latest sample file (fast).
/// Full merge happens at execute time via `read_folder_merged`.
pub fn read_folder_preview(
    folder: &Path,
    header_overrides: &HashMap<String, usize>,
    limit: usize,
) -> Result<PreviewDataLike, String> {
    let files = list_excel_files(folder)?;
    if files.is_empty() {
        return Err(format!("子文件夹中没有 Excel: {}", folder.display()));
    }
    let ranked = rank_excel_files(files);
    let sample = ranked
        .last()
        .ok_or_else(|| format!("子文件夹为空: {}", folder.display()))?;
    let folder_str = folder.display().to_string();
    let path_str = sample.path.display().to_string();
    let override_row = header_override_for(header_overrides, &path_str, Some(&folder_str));
    let (mut table, _, total) = read_excel_preview(&sample.path, override_row, limit)?;
    // Align preview headers with merge output (来源日期 at end)
    if !table.headers.iter().any(|h| h == SOURCE_DATE_HEADER) {
        table.headers.push(SOURCE_DATE_HEADER.to_string());
        for row in &mut table.rows {
            row.push(sample.date.clone());
        }
    }
    Ok(PreviewDataLike {
        headers: table.headers,
        rows: table.rows,
        total_rows: total,
    })
}

pub struct PreviewDataLike {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

/// Read first sheet. `header_row` is 1-based. If None, auto-pick first non-empty row.
pub fn read_excel_first_sheet(
    path: &Path,
    header_row: Option<usize>,
) -> Result<(DataTable, usize), String> {
    let range = open_first_sheet_range(path)?;
    let (headers, chosen, data_start) = resolve_headers_from_range(&range, header_row, path)?;
    let width = headers.len();
    let mut rows = Vec::new();
    for (ri, row) in range.rows().enumerate() {
        if ri < data_start {
            continue;
        }
        let values: Vec<String> = (0..width)
            .map(|i| row.get(i).map(cell_to_string).unwrap_or_default())
            .collect();
        if values.iter().all(|v| v.trim().is_empty()) {
            continue;
        }
        rows.push(values);
    }
    Ok((DataTable { headers, rows, ..Default::default() }, chosen))
}

/// Preview: parse sheet once but only materialize first `limit` data rows (saves RAM/CPU).
/// Returns (preview table, header_row, total_data_rows).
pub fn read_excel_preview(
    path: &Path,
    header_row: Option<usize>,
    limit: usize,
) -> Result<(DataTable, usize, usize), String> {
    let range = open_first_sheet_range(path)?;
    let (headers, chosen, data_start) = resolve_headers_from_range(&range, header_row, path)?;
    let width = headers.len();
    let limit = limit.max(1);
    let mut rows = Vec::new();
    let mut total = 0usize;
    for (ri, row) in range.rows().enumerate() {
        if ri < data_start {
            continue;
        }
        let values: Vec<String> = (0..width)
            .map(|i| row.get(i).map(cell_to_string).unwrap_or_default())
            .collect();
        if values.iter().all(|v| v.trim().is_empty()) {
            continue;
        }
        total += 1;
        if rows.len() < limit {
            rows.push(values);
        }
    }
    Ok((
        DataTable {
            headers,
            rows,
            ..Default::default()
        },
        chosen,
        total,
    ))
}

/// Lightweight scan: headers + row count, without keeping all cell strings.
pub fn scan_sheet_meta(
    path: &Path,
    header_row: Option<usize>,
) -> Result<(Vec<String>, usize, usize), String> {
    let range = open_first_sheet_range(path)?;
    let (headers, chosen, data_start) = resolve_headers_from_range(&range, header_row, path)?;
    let width = headers.len();
    let mut row_count = 0usize;
    for (ri, row) in range.rows().enumerate() {
        if ri < data_start {
            continue;
        }
        let empty = (0..width).all(|i| row.get(i).map(cell_is_blank).unwrap_or(true));
        if !empty {
            row_count += 1;
        }
    }
    Ok((headers, chosen, row_count))
}

pub fn peek_raw_rows(path: &Path, limit: usize) -> Result<(Vec<Vec<String>>, usize), String> {
    let range = open_first_sheet_range(path)?;
    let total = range.height();
    let mut rows = Vec::new();
    for row in range.rows().take(limit.max(1)) {
        rows.push(row.iter().map(cell_to_string).collect());
    }
    Ok((rows, total))
}

fn open_first_sheet_range(path: &Path) -> Result<calamine::Range<Data>, String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| format!("打开失败 {}: {e}", path.display()))?;
    let sheet_names = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names
        .first()
        .ok_or_else(|| format!("文件无 sheet: {}", path.display()))?
        .clone();
    workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("读取 sheet 失败 {}: {e}", path.display()))
}

fn resolve_headers_from_range(
    range: &calamine::Range<Data>,
    header_row: Option<usize>,
    path: &Path,
) -> Result<(Vec<String>, usize, usize), String> {
    if range.height() == 0 {
        return Err(format!("空表: {}", path.display()));
    }
    let chosen = match header_row {
        Some(r) if r >= 1 && r <= range.height() => r,
        Some(r) => {
            return Err(format!(
                "表头行 {} 超出范围（共 {} 行）: {}",
                r,
                range.height(),
                path.display()
            ))
        }
        None => {
            let max_probe = range.height().min(30);
            let mut probe: Vec<Vec<String>> = Vec::with_capacity(max_probe);
            for row in range.rows().take(max_probe) {
                probe.push(row.iter().map(cell_to_string).collect());
            }
            detect_header_row(&probe).unwrap_or(1)
        }
    };
    let header_idx = chosen - 1;
    let header_cells: Vec<String> = range
        .rows()
        .nth(header_idx)
        .map(|row| row.iter().map(cell_to_string).collect())
        .ok_or_else(|| format!("无法读取表头行: {}", path.display()))?;
    let last_non_empty = header_cells
        .iter()
        .rposition(|h| !h.trim().is_empty())
        .map(|i| i + 1)
        .unwrap_or(0);
    let headers: Vec<String> = header_cells.into_iter().take(last_non_empty).collect();
    let forced = header_row.is_some();
    if headers.is_empty() || (!forced && !looks_like_header(&headers)) {
        return Err(format!(
            "未识别到有效表头（当前尝试第 {} 行）。请手动指定表头行: {}",
            chosen,
            path.display()
        ));
    }
    Ok((headers, chosen, header_idx + 1))
}

fn cell_is_blank(cell: &Data) -> bool {
    match cell {
        Data::Empty => true,
        other => cell_to_string(other).trim().is_empty(),
    }
}

fn detect_header_row(rows: &[Vec<String>]) -> Option<usize> {
    for (i, row) in rows.iter().enumerate().take(20) {
        let non_empty: Vec<_> = row.iter().filter(|c| !c.trim().is_empty()).cloned().collect();
        if non_empty.len() >= 2 && looks_like_header(&non_empty) {
            return Some(i + 1);
        }
    }
    rows.iter()
        .position(|r| r.iter().any(|c| !c.trim().is_empty()))
        .map(|i| i + 1)
}

fn looks_like_header(cells: &[String]) -> bool {
    let non_empty: Vec<_> = cells.iter().filter(|c| !c.trim().is_empty()).collect();
    if non_empty.is_empty() {
        return false;
    }
    let textish = non_empty
        .iter()
        .filter(|c| {
            let t = c.trim();
            t.parse::<f64>().is_err()
        })
        .count();
    textish * 2 >= non_empty.len()
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => format_plain_number(*f),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR:{e:?}"),
    }
}

/// Format a float without scientific notation (`1.04E+18`).
pub fn format_plain_number(f: f64) -> String {
    if !f.is_finite() {
        return String::new();
    }
    if f.fract() == 0.0 || (f.round() - f).abs() < 1e-9 {
        format!("{:.0}", f)
    } else {
        let s = format!("{f:.15}");
        s.trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

/// Key used for row match/overwrite. Long digit IDs stay as text (not f64).
pub fn match_key(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    if let Some(n) = safe_numeric_key(t) {
        n
    } else {
        t.to_string()
    }
}

/// Only coerce short, precise numbers (e.g. 1 vs 1.0). 18-digit IDs stay literal.
pub fn safe_numeric_key(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains('E') || t.contains('e') {
        return None;
    }
    let cleaned = t.replace(',', "").replace('，', "");
    let body = cleaned.trim_start_matches('-');
    let int_digits = body.split('.').next().unwrap_or("").len();
    if int_digits > 15 {
        return None;
    }
    let n: f64 = cleaned.parse().ok()?;
    if !n.is_finite() || n.abs() >= 1e15 {
        return None;
    }
    if n.fract() == 0.0 {
        Some(format!("{}", n as i64))
    } else {
        Some(format_plain_number(n))
    }
}

/// Scan directory. `header_overrides`: path -> 1-based header row.
/// Files that fail header detection are still returned with `header_ok = false`.
pub fn scan_directory(
    dir: &Path,
    header_overrides: &HashMap<String, usize>,
) -> Result<Vec<crate::models::SourceTable>, String> {
    if !dir.is_dir() {
        return Err(format!("不是有效目录: {}", dir.display()));
    }

    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            dirs.push(path);
        } else if is_excel(&path) {
            files.push(path);
        }
    }
    files.sort();
    dirs.sort();

    let mut tables = Vec::new();
    let mut used_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for path in files {
        let table = scan_file_table(&path, header_overrides)?;
        used_ids.insert(table.id.clone());
        tables.push(table);
    }

    for dir_path in dirs {
        if let Some(table) = scan_folder_table(&dir_path, header_overrides, &used_ids)? {
            used_ids.insert(table.id.clone());
            tables.push(table);
        }
    }
    Ok(tables)
}

fn scan_file_table(
    path: &Path,
    header_overrides: &HashMap<String, usize>,
) -> Result<crate::models::SourceTable, String> {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let path_str = path.display().to_string();
    let id = format!("src:{name}");
    let override_row = header_overrides.get(&path_str).copied();

    match scan_sheet_meta(path, override_row) {
        Ok((headers, header_row, row_count)) => Ok(crate::models::SourceTable {
            id,
            name,
            path: path_str.clone(),
            row_count,
            headers,
            header_row,
            header_ok: true,
            header_message: String::new(),
            kind: "file".into(),
            file_count: 1,
            sample_path: path_str,
        }),
        Err(msg) => Ok(crate::models::SourceTable {
            id,
            name,
            path: path_str.clone(),
            headers: vec![],
            row_count: 0,
            header_row: override_row.unwrap_or(1),
            header_ok: false,
            header_message: msg,
            kind: "file".into(),
            file_count: 1,
            sample_path: path_str,
        }),
    }
}

fn scan_folder_table(
    dir_path: &Path,
    header_overrides: &HashMap<String, usize>,
    used_ids: &std::collections::HashSet<String>,
) -> Result<Option<crate::models::SourceTable>, String> {
    let name = dir_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let excel_files = list_excel_files(dir_path)?;
    if excel_files.is_empty() {
        return Ok(None);
    }
    let mut id = format!("src:{name}");
    if used_ids.contains(&id) {
        id = format!("src:{name}_累计");
    }
    let folder_str = dir_path.display().to_string();
    let ranked = rank_excel_files(excel_files);
    let file_count = ranked.len();
    let sample = ranked
        .last()
        .ok_or_else(|| format!("子文件夹为空: {}", dir_path.display()))?;
    let sample_path = sample.path.display().to_string();
    let override_row = header_override_for(header_overrides, &sample_path, Some(&folder_str));

    let (mut headers, header_row, sample_rows, header_ok, header_message) =
        match scan_sheet_meta(&sample.path, override_row) {
            Ok((headers, hr, rc)) => {
                let msg = if file_count > 1 {
                    format!(
                        "列表仅扫描最新文件「{}」；预览也只读该文件。执行生成时会合并全部 {} 个文件",
                        sample
                            .path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("样本"),
                        file_count
                    )
                } else {
                    String::new()
                };
                (headers, hr, rc, true, msg)
            }
            Err(msg) => (vec![], override_row.unwrap_or(1), 0, false, msg),
        };

    if header_ok && !headers.iter().any(|h| h == SOURCE_DATE_HEADER) {
        headers.push(SOURCE_DATE_HEADER.to_string());
    }

    // Approximate until full merge at execute time
    let row_count = sample_rows.saturating_mul(file_count);

    Ok(Some(crate::models::SourceTable {
        id,
        name,
        path: folder_str,
        headers,
        row_count,
        header_row,
        header_ok,
        header_message,
        kind: "folder".into(),
        file_count,
        sample_path,
    }))
}

pub fn apply_filter(
    table: &DataTable,
    conditions: &[crate::models::FilterCondition],
) -> Result<DataTable, String> {
    let idxs: Vec<(usize, &crate::models::FilterCondition)> = conditions
        .iter()
        .map(|c| Ok((table.col_index(&c.column)?, c)))
        .collect::<Result<Vec<_>, String>>()?;

    let rows = table
        .rows
        .iter()
        .filter(|row| {
            idxs.iter().all(|(idx, cond)| {
                let cell = row.get(*idx).map(|s| s.as_str()).unwrap_or("");
                match cond.op.as_str() {
                    "eq" => cell == cond.value,
                    "neq" => cell != cond.value,
                    "contains" => cell.contains(&cond.value),
                    "not_contains" => !cell.contains(&cond.value),
                    "empty" => cell.trim().is_empty(),
                    "not_empty" => !cell.trim().is_empty(),
                    _ => true,
                }
            })
        })
        .cloned()
        .collect();

    Ok(DataTable {
        headers: table.headers.clone(),
        rows,
        header_groups: table.header_groups.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Runtime;
    use crate::models::{FilterCondition, Operation, Pipeline, PivotValue, ResultSpec, Step};
    use crate::ops::{apply_calculate, apply_pivot, apply_side_by_side};
    use std::collections::HashMap;

    fn sample_niche() -> DataTable {
        DataTable {
            headers: vec![
                "二级机构".into(),
                "渠道".into(),
                "业务员代码".into(),
                "业务员名称".into(),
                "保费变化量不含税".into(),
            ],
            rows: vec![
                vec![
                    "江苏南京支公司".into(),
                    "个险".into(),
                    "A001".into(),
                    "张三".into(),
                    "1000".into(),
                ],
                vec![
                    "江苏苏州支公司".into(),
                    "个险".into(),
                    "A002".into(),
                    "李四".into(),
                    "5000".into(),
                ],
                vec![
                    "江苏无锡支公司".into(),
                    "DIY".into(),
                    "A003".into(),
                    "王五".into(),
                    "2000".into(),
                ],
                vec![
                    "江苏南京支公司".into(),
                    "银保".into(),
                    "A001".into(),
                    "张三".into(),
                    "500".into(),
                ],
            ],
            ..Default::default()
        }
    }

    fn sample_hist() -> DataTable {
        DataTable {
            headers: vec!["业务员代码".into(), "保费".into()],
            rows: vec![
                vec!["A001".into(), "800".into()],
                vec!["A004".into(), "100".into()],
            ],
            ..Default::default()
        }
    }

    #[test]
    fn mvp_niche_pipeline() {
        let niche = sample_niche();
        let hist = sample_hist();

        let filtered = apply_filter(
            &niche,
            &[
                FilterCondition {
                    column: "二级机构".into(),
                    op: "not_contains".into(),
                    value: "江苏苏州支公司".into(),
                },
                FilterCondition {
                    column: "渠道".into(),
                    op: "not_contains".into(),
                    value: "DIY".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(filtered.rows.len(), 2);

        let pivot = apply_pivot(
            &filtered,
            &["业务员代码".into(), "业务员名称".into()],
            &[PivotValue {
                field: "保费变化量不含税".into(),
                aggregation: "sum".into(),
                alias: String::new(),
            }],
            "",
            "sum",
        )
        .unwrap();
        assert_eq!(pivot.rows.len(), 1);
        assert_eq!(pivot.rows[0][0], "A001");
        assert_eq!(pivot.rows[0][2], "1500");

        let mut tables = HashMap::new();
        tables.insert("tmp:p".into(), &pivot);
        tables.insert("src:2025同月保费".into(), &hist);
        let added = apply_calculate(
            &tables,
            "tmp:p",
            "新增保费",
            "=[tmp:p!保费变化量不含税_求和]-[src:2025同月保费!保费]",
            &[crate::models::CalcJoin {
                table_id: "src:2025同月保费".into(),
                base_key: "业务员代码".into(),
                foreign_key: "业务员代码".into(),
            }],
        )
        .unwrap();
        assert_eq!(added.rows[0].last().unwrap(), "700");

        let side = apply_side_by_side(&[&hist, &pivot, &added]).unwrap();
        assert!(side.headers.iter().any(|h| h.is_empty()));
    }

    #[test]
    fn missing_column_errors() {
        let t = sample_niche();
        let err = apply_filter(
            &t,
            &[FilterCondition {
                column: "不存在的列".into(),
                op: "eq".into(),
                value: "x".into(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("重新映射"));
    }

    #[test]
    fn runtime_executes_steps() {
        let mut runtime = Runtime {
            sources: HashMap::from([
                ("src:利基清单".into(), sample_niche()),
                ("src:2025同月保费".into(), sample_hist()),
            ]),
            source_meta: vec![],
            temps: HashMap::new(),
            header_rows: HashMap::new(),
            folder_merges: HashMap::new(),
        };

        let pipeline = Pipeline {
            id: "demo".into(),
            name: "demo".into(),
            source_dir: "".into(),
            output_dir: "".into(),
            header_rows: HashMap::new(),
            output_sheets: vec![],
            folder_merges: HashMap::new(),
            steps: vec![
                Step {
                    id: "1".into(),
                    name: "筛选".into(),
                    output_table_id: "tmp:f".into(),
                    operation: Operation::Filter {
                        input_table_id: "src:利基清单".into(),
                        conditions: vec![
                            FilterCondition {
                                column: "二级机构".into(),
                                op: "not_contains".into(),
                                value: "江苏苏州支公司".into(),
                            },
                            FilterCondition {
                                column: "渠道".into(),
                                op: "not_contains".into(),
                                value: "DIY".into(),
                            },
                        ],
                    },
                    result: Some(ResultSpec {
                        enabled: true,
                        file_key: "main".into(),
                        sheet_name: "筛选".into(),
                    }),
                },
                Step {
                    id: "2".into(),
                    name: "透视".into(),
                    output_table_id: "tmp:p".into(),
                    operation: Operation::Pivot {
                        input_table_id: "tmp:f".into(),
                        row_fields: vec!["业务员代码".into(), "业务员名称".into()],
                        value_fields: vec![PivotValue {
                            field: "保费变化量不含税".into(),
                            aggregation: "sum".into(),
                            alias: String::new(),
                        }],
                        value_field: String::new(),
                        aggregation: "sum".into(),
                    },
                    result: None,
                },
            ],
        };

        runtime.run_until(&pipeline, None).unwrap();
        assert_eq!(runtime.temps.get("tmp:f").unwrap().rows.len(), 2);
        assert_eq!(runtime.temps.get("tmp:p").unwrap().rows.len(), 1);
    }

    #[test]
    fn parse_dates_from_filenames() {
        assert_eq!(
            parse_source_date("出单_20260818", None),
            "2026-08-18"
        );
        assert_eq!(
            parse_source_date("日报-2026-08-19", None),
            "2026-08-19"
        );
        assert_eq!(
            parse_source_date("2026_08_01_出单", None),
            "2026-08-01"
        );
    }

    #[test]
    fn merge_overwrites_by_key_keeps_latest_date() {
        let old = DataTable {
            headers: vec!["代码".into(), "保费".into()],
            rows: vec![
                vec!["A001".into(), "100".into()],
                vec!["A002".into(), "200".into()],
            ],
            ..Default::default()
        };
        let new = DataTable {
            headers: vec!["代码".into(), "保费".into(), "机构".into()],
            rows: vec![
                vec!["A001".into(), "150".into(), "南京".into()],
                vec!["A003".into(), "90".into(), "苏州".into()],
            ],
            ..Default::default()
        };
        let out = merge_dated_tables(
            &[("2026-08-17".into(), old), ("2026-08-18".into(), new)],
            "代码",
        )
        .unwrap();
        assert_eq!(out.headers, vec!["代码", "保费", "机构", "来源日期"]);
        assert_eq!(out.rows.len(), 3);
        assert_eq!(
            out.rows[0],
            vec!["A001", "150", "南京", "2026-08-18"]
        );
        assert_eq!(out.rows[1], vec!["A002", "200", "", "2026-08-17"]);
        assert_eq!(out.rows[2], vec!["A003", "90", "苏州", "2026-08-18"]);
    }

    #[test]
    fn long_ids_are_not_scientific_and_match_as_text() {
        let formatted = format_plain_number(1.0356050720250143e18);
        assert!(!formatted.contains('E') && !formatted.contains('e'));
        let id = "1035605072025014251";
        assert_eq!(match_key(id), id);
        assert_eq!(safe_numeric_key(id), None);
        assert_eq!(match_key("1.0"), "1");
        assert_eq!(match_key("001"), "1");
    }
}
