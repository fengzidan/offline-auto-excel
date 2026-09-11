use crate::models::DataTable;
use calamine::{open_workbook_auto, Data, Dimensions, Reader, Sheets};
use chrono::{Local, NaiveDate};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek};
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
    if let Some(row) = header_overrides.get(file_path).copied() {
        return Some(row);
    }
    if let Some(fp) = folder_path {
        if let Some(row) = header_overrides.get(fp).copied() {
            return Some(row);
        }
    }
    let path = Path::new(file_path);
    if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
        if let Some(row) = header_overrides.get(name).copied() {
            return Some(row);
        }
    }
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        if let Some(row) = header_overrides.get(stem).copied() {
            return Some(row);
        }
        let src_id = format!("src:{stem}");
        if let Some(row) = header_overrides.get(&src_id).copied() {
            return Some(row);
        }
    }
    None
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
    let (range, merges) = open_first_sheet_range(path)?;
    let (headers, chosen, data_start) =
        resolve_headers_from_range(&range, &merges, header_row, path)?;
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
    let (range, merges) = open_first_sheet_range(path)?;
    let (headers, chosen, data_start) =
        resolve_headers_from_range(&range, &merges, header_row, path)?;
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
    let (range, merges) = open_first_sheet_range(path)?;
    let (headers, chosen, data_start) =
        resolve_headers_from_range(&range, &merges, header_row, path)?;
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
    let (range, _) = open_first_sheet_range(path)?;
    let total = range.height();
    let mut rows = Vec::new();
    for row in range.rows().take(limit.max(1)) {
        rows.push(row.iter().map(cell_to_string).collect());
    }
    Ok((rows, total))
}

fn open_first_sheet_range(
    path: &Path,
) -> Result<(calamine::Range<Data>, Vec<Dimensions>), String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| format!("打开失败 {}: {e}", path.display()))?;
    let sheet_names = workbook.sheet_names().to_vec();
    let sheet_name = sheet_names
        .first()
        .ok_or_else(|| format!("文件无 sheet: {}", path.display()))?
        .clone();
    let merges = sheet_merge_cells(&mut workbook, &sheet_name);
    let mut range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("读取 sheet 失败 {}: {e}", path.display()))?;
    fill_merged_cells(&mut range, &merges);
    Ok((range, merges))
}

/// xlsx / xls 可读合并区域；xlsb / ods 暂不支持则返回空。
fn sheet_merge_cells<RS: Read + Seek>(
    workbook: &mut Sheets<RS>,
    sheet_name: &str,
) -> Vec<Dimensions> {
    match workbook {
        Sheets::Xlsx(wb) => wb.merge_cells_by_sheet_name(sheet_name).unwrap_or_default(),
        Sheets::Xls(wb) => wb.merge_cells_by_sheet_name(sheet_name).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// 将合并单元格左上角的值填到整块区域的空白格（Excel 只存左上角）。
fn fill_merged_cells(range: &mut calamine::Range<Data>, merges: &[Dimensions]) {
    if range.is_empty() || merges.is_empty() {
        return;
    }
    let Some(origin) = range.start() else {
        return;
    };
    let (height, width) = range.get_size();
    for m in merges {
        if m.start == m.end {
            continue;
        }
        let Some(anchor) = range.get_value(m.start).cloned() else {
            continue;
        };
        if matches!(anchor, Data::Empty) || cell_to_string(&anchor).trim().is_empty() {
            continue;
        }
        for r in m.start.0..=m.end.0 {
            for c in m.start.1..=m.end.1 {
                if (r, c) == m.start {
                    continue;
                }
                if r < origin.0 || c < origin.1 {
                    continue;
                }
                let rel = ((r - origin.0) as usize, (c - origin.1) as usize);
                if rel.0 >= height || rel.1 >= width {
                    continue;
                }
                let blank = range
                    .get(rel)
                    .map(|d| matches!(d, Data::Empty) || cell_to_string(d).trim().is_empty())
                    .unwrap_or(true);
                if blank {
                    range[rel] = anchor.clone();
                }
            }
        }
    }
}

fn resolve_headers_from_range(
    range: &calamine::Range<Data>,
    _merges: &[Dimensions],
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
    let raw: Vec<String> = header_cells.into_iter().take(last_non_empty).collect();
    // 单行横向合并表头填值后同名相连 → 拆成 表头_1、表头_2…
    let headers = split_consecutive_merged_headers(&raw);
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

/// 同一表头行内，横向合并导致的连续同名列拆成 `名称_1`、`名称_2`…
fn split_consecutive_merged_headers(headers: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(headers.len());
    let mut i = 0;
    while i < headers.len() {
        let raw = headers[i].trim();
        let mut j = i + 1;
        while j < headers.len() && headers[j].trim() == raw {
            j += 1;
        }
        let count = j - i;
        let base = if raw.is_empty() {
            "列".to_string()
        } else {
            raw.to_string()
        };
        if count == 1 {
            out.push(if raw.is_empty() {
                format!("列{}", i + 1)
            } else {
                base
            });
        } else {
            for n in 1..=count {
                out.push(format!("{base}_{n}"));
            }
        }
        i = j;
    }
    // 非连续重名（两列都叫「岗位」）仍要能区分
    uniquify_headers(out)
}

fn uniquify_headers(headers: Vec<String>) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::with_capacity(headers.len());
    for h in headers {
        let base = if h.trim().is_empty() {
            "列".to_string()
        } else {
            h
        };
        let n = seen.entry(base.clone()).or_insert(0);
        *n += 1;
        if *n == 1 {
            out.push(base);
        } else {
            out.push(format!("{base}_{n}"));
        }
    }
    out
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
/// Only Excel files in the directory are recognized as sources (subfolders are ignored).
pub fn scan_directory(
    dir: &Path,
    header_overrides: &HashMap<String, usize>,
) -> Result<Vec<crate::models::SourceTable>, String> {
    if !dir.is_dir() {
        return Err(format!("不是有效目录: {}", dir.display()));
    }

    let mut files = Vec::new();
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
        if path.is_file() && is_excel(&path) {
            files.push(path);
        }
    }
    files.sort();

    let mut tables = Vec::new();
    for path in files {
        tables.push(scan_file_table(&path, header_overrides)?);
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
    let override_row = header_override_for(header_overrides, &path_str, None);

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
            matched_name: String::new(),
            match_keyword: String::new(),
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
            matched_name: String::new(),
            match_keyword: String::new(),
        }),
    }
}

/// 子文件夹累计表发现已停用（开始节点只识别 Excel 文件）；保留供预览/合并路径复用参考。
#[allow(dead_code)]
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
        matched_name: String::new(),
        match_keyword: String::new(),
    }))
}

pub fn apply_filter(
    table: &DataTable,
    conditions: &[crate::models::FilterCondition],
    match_mode: &str,
) -> Result<DataTable, String> {
    let idxs: Vec<(usize, &crate::models::FilterCondition)> = conditions
        .iter()
        .filter(|c| !c.column.trim().is_empty())
        .map(|c| Ok((table.col_index(&c.column)?, c)))
        .collect::<Result<Vec<_>, String>>()?;

    let rows = if idxs.is_empty() {
        table.rows.clone()
    } else {
        // Legacy: match_mode=or and no per-condition join=or → all OR.
        // Otherwise: consecutive `and` form a group; groups are OR-ed.
        let any_join_or = idxs
            .iter()
            .skip(1)
            .any(|(_, c)| c.join.eq_ignore_ascii_case("or"));
        let legacy_all_or = match_mode.eq_ignore_ascii_case("or") && !any_join_or;

        table
            .rows
            .iter()
            .filter(|row| {
                let check = |idx: usize, cond: &crate::models::FilterCondition| {
                    let cell = row.get(idx).map(|s| s.as_str()).unwrap_or("");
                    match cond.op.as_str() {
                        "eq" => cell == cond.value,
                        "neq" => cell != cond.value,
                        "contains" => cell.contains(&cond.value),
                        "not_contains" => !cell.contains(&cond.value),
                        "empty" => cell.trim().is_empty(),
                        "not_empty" => !cell.trim().is_empty(),
                        _ => true,
                    }
                };

                if legacy_all_or {
                    return idxs.iter().any(|(idx, cond)| check(*idx, cond));
                }

                let mut group_ok = true;
                for (i, (idx, cond)) in idxs.iter().enumerate() {
                    if i > 0 && cond.join.eq_ignore_ascii_case("or") {
                        if group_ok {
                            return true;
                        }
                        group_ok = true;
                    }
                    if !check(*idx, cond) {
                        group_ok = false;
                    }
                }
                group_ok
            })
            .cloned()
            .collect()
    };

    Ok(DataTable {
        headers: table.headers.clone(),
        rows,
        header_groups: table.header_groups.clone(),
        plain_sheet: table.plain_sheet,
        header_bands: table.header_bands.clone(),
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
                                join: "and".into(),
            },
                FilterCondition {
                    column: "渠道".into(),
                    op: "not_contains".into(),
                    value: "DIY".into(),
                                join: "and".into(),
            },
            ],
            "and",
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
            &[crate::models::CalcColumn {
                output_field: "新增保费".into(),
                formula: "=[tmp:p!保费变化量不含税_求和]-[src:2025同月保费!保费]".into(),
            }],
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
                            join: "and".into(),
            }],
            "and",
        )
        .unwrap_err();
        assert!(err.contains("重新映射"));
    }

    #[test]
    fn filter_or_match_mode() {
        let t = sample_niche();
        let filtered = apply_filter(
            &t,
            &[
                FilterCondition {
                    column: "渠道".into(),
                    op: "contains".into(),
                    value: "DIY".into(),
                                join: "and".into(),
            },
                FilterCondition {
                    column: "二级机构".into(),
                    op: "contains".into(),
                    value: "江苏苏州支公司".into(),
                                join: "and".into(),
            },
            ],
            "or",
        )
        .unwrap();
        // OR: DIY rows OR 苏州 rows — more than AND would keep
        assert!(!filtered.rows.is_empty());
        let and_filtered = apply_filter(
            &t,
            &[
                FilterCondition {
                    column: "渠道".into(),
                    op: "contains".into(),
                    value: "DIY".into(),
                                join: "and".into(),
            },
                FilterCondition {
                    column: "二级机构".into(),
                    op: "contains".into(),
                    value: "江苏苏州支公司".into(),
                                join: "and".into(),
            },
            ],
            "and",
        )
        .unwrap();
        assert!(filtered.rows.len() >= and_filtered.rows.len());
    }

    #[test]
    fn filter_mixed_and_or_joins() {
        let t = sample_niche();
        // (渠道含DIY 且 机构含南京) 或 (机构含苏州)
        let filtered = apply_filter(
            &t,
            &[
                FilterCondition {
                    column: "渠道".into(),
                    op: "contains".into(),
                    value: "DIY".into(),
                    join: "and".into(),
                },
                FilterCondition {
                    column: "二级机构".into(),
                    op: "contains".into(),
                    value: "江苏南京支公司".into(),
                    join: "and".into(),
                },
                FilterCondition {
                    column: "二级机构".into(),
                    op: "contains".into(),
                    value: "江苏苏州支公司".into(),
                    join: "or".into(),
                },
            ],
            "and",
        )
        .unwrap();
        assert!(!filtered.rows.is_empty());
        for row in &filtered.rows {
            let org = row[0].as_str();
            let ch = row[1].as_str();
            let ok = (ch.contains("DIY") && org.contains("江苏南京支公司"))
                || org.contains("江苏苏州支公司");
            assert!(ok, "row={row:?}");
        }
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
            flow_positions: HashMap::new(),
            flow_edges: vec![],
            source_matchers: vec![],
            prompt_fields: vec![],
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
                                            join: "and".into(),
            },
                            FilterCondition {
                                column: "渠道".into(),
                                op: "not_contains".into(),
                                value: "DIY".into(),
                                            join: "and".into(),
            },
                        ],
                        match_mode: "and".into(),
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

    #[test]
    fn fill_merged_cells_vertical_and_horizontal() {
        use calamine::Range;
        // 机构列纵向合并两行；表头横向合并两列
        let mut range = Range::new((0, 0), (2, 2));
        range[(0, 0)] = Data::String("规模档次".into());
        // (0,1) empty — horizontally merged with (0,0) conceptually for header span
        range[(0, 2)] = Data::String("编制人数".into());
        range[(1, 0)] = Data::String("南京中支".into());
        range[(1, 1)] = Data::String("销售内勤".into());
        range[(1, 2)] = Data::Float(3.0);
        // (2,0) empty — vertically merged with (1,0)
        range[(2, 1)] = Data::String("理赔".into());
        range[(2, 2)] = Data::Float(2.0);

        fill_merged_cells(
            &mut range,
            &[
                Dimensions::new((0, 0), (0, 1)),
                Dimensions::new((1, 0), (2, 0)),
            ],
        );

        assert_eq!(
            range.get((0, 1)).map(cell_to_string).as_deref(),
            Some("规模档次")
        );
        assert_eq!(
            range.get((2, 0)).map(cell_to_string).as_deref(),
            Some("南京中支")
        );
        // 已有值不被覆盖
        assert_eq!(
            range.get((2, 1)).map(cell_to_string).as_deref(),
            Some("理赔")
        );
    }

    #[test]
    fn split_consecutive_merged_headers_numbers_each_col() {
        let raw = vec![
            "机构".into(),
            "规模档次".into(),
            "规模档次".into(),
            "规模档次".into(),
            "岗位".into(),
        ];
        assert_eq!(
            split_consecutive_merged_headers(&raw),
            vec!["机构", "规模档次_1", "规模档次_2", "规模档次_3", "岗位"]
        );
    }

    #[test]
    fn read_excel_splits_single_row_merged_headers() {
        use rust_xlsxwriter::{Format, Workbook};

        let dir = std::env::temp_dir().join("ae_merge_header_split");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("headers.xlsx");

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        let fmt = Format::new();
        worksheet.write_string(0, 0, "机构").unwrap();
        worksheet
            .merge_range(0, 1, 0, 3, "规模档次", &fmt)
            .unwrap();
        worksheet.write_string(0, 4, "岗位").unwrap();
        worksheet.write_string(1, 0, "南京").unwrap();
        worksheet.write_string(1, 1, "a").unwrap();
        worksheet.write_string(1, 2, "b").unwrap();
        worksheet.write_string(1, 3, "c").unwrap();
        worksheet.write_string(1, 4, "理赔").unwrap();
        workbook.save(&path).unwrap();

        let (table, _) = read_excel_first_sheet(&path, Some(1)).unwrap();
        assert_eq!(
            table.headers,
            vec!["机构", "规模档次_1", "规模档次_2", "规模档次_3", "岗位"]
        );
        assert_eq!(table.rows[0], vec!["南京", "a", "b", "c", "理赔"]);
    }

    #[test]
    fn read_excel_fills_merged_cells_from_xlsx() {
        use rust_xlsxwriter::{Format, Workbook};

        let dir = std::env::temp_dir().join("ae_merge_cell_fill");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("merged.xlsx");

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        let fmt = Format::new();
        // 表头
        worksheet.write_string(0, 0, "中心").unwrap();
        worksheet.write_string(0, 1, "岗位").unwrap();
        worksheet.write_string(0, 2, "人数").unwrap();
        // 纵向合并「南京中支」两行
        worksheet
            .merge_range(1, 0, 2, 0, "南京中支", &fmt)
            .unwrap();
        worksheet.write_string(1, 1, "销售内勤").unwrap();
        worksheet.write_number(1, 2, 3.0).unwrap();
        worksheet.write_string(2, 1, "理赔").unwrap();
        worksheet.write_number(2, 2, 2.0).unwrap();
        workbook.save(&path).unwrap();

        let (table, _) = read_excel_first_sheet(&path, Some(1)).unwrap();
        assert_eq!(table.headers, vec!["中心", "岗位", "人数"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0][0], "南京中支");
        assert_eq!(table.rows[1][0], "南京中支");
        assert_eq!(table.rows[1][1], "理赔");
    }
}
