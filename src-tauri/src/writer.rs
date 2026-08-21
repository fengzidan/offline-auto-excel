use crate::models::DataTable;
use rust_xlsxwriter::{Color, Format, Formula, Workbook, Worksheet};
use std::collections::BTreeMap;
use std::path::Path;

pub fn write_workbook(
    path: &Path,
    sheets: &[(String, &DataTable)],
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    // Write in the given order (output_sheets configures final order)
    for (name, table) in sheets {
        let sheet_name = sanitize_sheet_name(name);
        let worksheet = workbook
            .add_worksheet()
            .set_name(&sheet_name)
            .map_err(|e| e.to_string())?;
        write_table(worksheet, table)?;
    }
    workbook.save(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn header_format() -> Format {
    header_format_rgb(0xED7D31, true)
}

fn header_format_rgb(rgb: u32, white_text: bool) -> Format {
    let mut fmt = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(rgb));
    if white_text {
        fmt = fmt.set_font_color(Color::White);
    }
    fmt
}

/// Distinct header colors for multi-table results (vlookup A/B, etc.).
/// Order is shuffled each write so different tables get random colors.
fn header_color_palette() -> Vec<(u32, bool)> {
    let mut palette = vec![
        (0xED7D31, true),  // orange
        (0x5B9BD5, true),  // blue
        (0x70AD47, true),  // green
        (0x7030A0, true),  // purple
        (0xC45911, true),  // brown
        (0x00B0F0, true),  // cyan
        (0xFFC000, false), // gold (dark text)
        (0xA9D08E, false), // light green
        (0xF4B183, false), // light orange
        (0x9DC3E6, false), // light blue
    ];
    // Fisher–Yates with time-based seed
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        | 1;
    for i in (1..palette.len()).rev() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1);
        let j = (state >> 33) as usize % (i + 1);
        palette.swap(i, j);
    }
    palette
}

fn header_formats_for_columns(groups: &[u32], col_count: usize) -> Vec<Format> {
    if groups.is_empty() || groups.iter().all(|&g| g == groups[0]) {
        let fmt = header_format();
        return (0..col_count).map(|_| fmt.clone()).collect();
    }
    let palette = header_color_palette();
    let mut unique: Vec<u32> = Vec::new();
    for &g in groups {
        if !unique.contains(&g) {
            unique.push(g);
        }
    }
    let mut by_group: std::collections::HashMap<u32, Format> =
        std::collections::HashMap::new();
    for (i, g) in unique.iter().enumerate() {
        let (rgb, white) = palette[i % palette.len()];
        by_group.insert(*g, header_format_rgb(rgb, white));
    }
    let default = header_format();
    (0..col_count)
        .map(|i| {
            let g = groups.get(i).copied().unwrap_or(0);
            by_group.get(&g).cloned().unwrap_or_else(|| default.clone())
        })
        .collect()
}

fn text_format() -> Format {
    Format::new().set_num_format("@")
}

fn number_format() -> Format {
    Format::new().set_num_format("0.##########")
}

/// Large IDs, leading zeros, scientific text → keep as original string.
fn should_write_as_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains('E') || t.contains('e') {
        return None;
    }
    let cleaned = t.replace(',', "").replace('，', "");
    let body = cleaned.trim_start_matches('-');
    if body.starts_with('0') && body.len() > 1 && !body.starts_with("0.") {
        return None;
    }
    let int_digits = body.split('.').next().unwrap_or("").len();
    if int_digits > 11 {
        return None;
    }
    let n: f64 = cleaned.parse().ok()?;
    if !n.is_finite() || n.abs() >= 1e12 {
        return None;
    }
    Some(n)
}

fn write_table(worksheet: &mut Worksheet, table: &DataTable) -> Result<(), String> {
    let header_fmts =
        header_formats_for_columns(&table.header_groups, table.headers.len());
    let text_fmt = text_format();
    let num_fmt = number_format();

    for (c, h) in table.headers.iter().enumerate() {
        let fmt = header_fmts.get(c).cloned().unwrap_or_else(header_format);
        worksheet
            .write_with_format(0, c as u16, h.as_str(), &fmt)
            .map_err(|e| e.to_string())?;
    }
    for (r, row) in table.rows.iter().enumerate() {
        for (c, val) in row.iter().enumerate() {
            let row_i = (r + 1) as u32;
            let col_i = c as u16;
            if let Some(n) = should_write_as_number(val) {
                worksheet
                    .write_with_format(row_i, col_i, n, &num_fmt)
                    .map_err(|e| e.to_string())?;
            } else {
                worksheet
                    .write_with_format(row_i, col_i, val.as_str(), &text_fmt)
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    if !table.headers.is_empty() {
        let last_col = (table.headers.len() - 1) as u16;
        let last_row = table.rows.len() as u32;
        worksheet
            .autofilter(0, 0, last_row.max(1), last_col)
            .map_err(|e| e.to_string())?;
        worksheet
            .set_freeze_panes(1, 0)
            .map_err(|e| e.to_string())?;
    }
    worksheet.autofit();
    Ok(())
}

pub fn sanitize_sheet_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | '?' | '*' | '[' | ']' | ':' => '_',
            _ => c,
        })
        .collect();
    if s.is_empty() {
        s = "Sheet1".into();
    }
    if s.len() > 31 {
        s = s.chars().take(31).collect();
    }
    s
}

/// Group result sheets by file_key and write workbooks under output_dir.
pub fn write_results(
    output_dir: &Path,
    pipeline_name: &str,
    sheets_by_file: &BTreeMap<String, Vec<(String, DataTable)>>,
) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
    let mut outputs = Vec::new();
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");

    for (file_key, sheets) in sheets_by_file {
        let file_name = if file_key == "main" || file_key.is_empty() {
            format!("{pipeline_name}_{stamp}.xlsx")
        } else {
            format!("{pipeline_name}_{file_key}_{stamp}.xlsx")
        };
        let path = output_dir.join(&file_name);
        let refs: Vec<(String, &DataTable)> = sheets
            .iter()
            .map(|(n, t)| (n.clone(), t))
            .collect();
        write_workbook(&path, &refs)?;
        outputs.push(path.display().to_string());
    }
    Ok(outputs)
}

/// Write a formula template: each source as a data sheet + result sheets with dynamic array formulas.
pub fn write_formula_template(
    path: &Path,
    sources: &[(String, &DataTable)],
    filter_sheet: Option<FilterTemplate>,
    pivot_sheet: Option<PivotTemplate>,
    calculate_sheet: Option<CalculateTemplate>,
    sort_sheets: &[SortTemplate],
    new_premium_sheet: Option<NewPremiumTemplate>,
) -> Result<(), String> {
    let mut workbook = Workbook::new();

    // Collect then reverse so tabs match result export (倒序)
    enum PendingSheet<'a> {
        Data(&'a str, &'a DataTable),
        Filter(FilterTemplate),
        Pivot(PivotTemplate),
        Calculate(CalculateTemplate),
        Sort(SortTemplate),
        NewPremium(NewPremiumTemplate),
    }

    let mut pending: Vec<PendingSheet<'_>> = Vec::new();
    for (name, table) in sources {
        pending.push(PendingSheet::Data(name, table));
    }
    if let Some(ft) = filter_sheet {
        pending.push(PendingSheet::Filter(ft));
    }
    if let Some(pt) = pivot_sheet {
        pending.push(PendingSheet::Pivot(pt));
    }
    // Calculate before sort so dependency order is clear in the builder list
    if let Some(ct) = calculate_sheet {
        pending.push(PendingSheet::Calculate(ct));
    }
    for st in sort_sheets {
        pending.push(PendingSheet::Sort(st.clone()));
    }
    if let Some(np) = new_premium_sheet {
        pending.push(PendingSheet::NewPremium(np));
    }

    for sheet in pending.into_iter().rev() {
        match sheet {
            PendingSheet::Data(name, table) => {
                let sheet_name = sanitize_sheet_name(&format!("数据_{name}"));
                let worksheet = workbook
                    .add_worksheet()
                    .set_name(&sheet_name)
                    .map_err(|e| e.to_string())?;
                write_table(worksheet, table)?;
            }
            PendingSheet::Filter(ft) => {
                let ws = workbook
                    .add_worksheet()
                    .set_name(sanitize_sheet_name(&ft.sheet_name))
                    .map_err(|e| e.to_string())?;
                write_filter_formulas(ws, &ft)?;
            }
            PendingSheet::Pivot(pt) => {
                let ws = workbook
                    .add_worksheet()
                    .set_name(sanitize_sheet_name(&pt.sheet_name))
                    .map_err(|e| e.to_string())?;
                write_pivot_formulas(ws, &pt)?;
            }
            PendingSheet::Calculate(ct) => {
                let ws = workbook
                    .add_worksheet()
                    .set_name(sanitize_sheet_name(&ct.sheet_name))
                    .map_err(|e| e.to_string())?;
                write_calculate_formulas(ws, &ct)?;
            }
            PendingSheet::Sort(st) => {
                let ws = workbook
                    .add_worksheet()
                    .set_name(sanitize_sheet_name(&st.sheet_name))
                    .map_err(|e| e.to_string())?;
                write_sort_formulas(ws, &st)?;
            }
            PendingSheet::NewPremium(np) => {
                let ws = workbook
                    .add_worksheet()
                    .set_name(sanitize_sheet_name(&np.sheet_name))
                    .map_err(|e| e.to_string())?;
                write_new_premium_formulas(ws, &np)?;
            }
        }
    }

    workbook.save(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub struct FilterTemplate {
    pub sheet_name: String,
    pub data_sheet: String,
    pub headers: Vec<String>,
    pub conditions: Vec<(String, String, String)>, // col, op, value
    pub data_rows: usize,
}

pub struct PivotTemplate {
    pub sheet_name: String,
    pub filtered_sheet: String,
    pub row_fields: Vec<String>,
    pub value_field: String,
    pub filtered_headers: Vec<String>,
}

#[derive(Clone)]
pub struct SortTemplate {
    pub sheet_name: String,
    /// Excel sheet name of the table being sorted (already final name).
    pub source_sheet: String,
    pub headers: Vec<String>,
    /// (column name, descending)
    pub keys: Vec<(String, bool)>,
}

pub struct CalcJoinTemplate {
    pub table_id: String,
    pub sheet_name: String,
    pub base_key: String,
    pub foreign_key: String,
    pub headers: Vec<String>,
}

pub struct CalculateTemplate {
    pub sheet_name: String,
    pub base_sheet: String,
    pub base_table_id: String,
    pub base_headers: Vec<String>,
    pub output_field: String,
    pub formula: String,
    pub joins: Vec<CalcJoinTemplate>,
}

pub struct NewPremiumTemplate {
    pub sheet_name: String,
    pub pivot_sheet: String,
    pub right_data_sheet: String,
    pub left_key: String,
    pub right_key: String,
    pub left_value_field: String,
    pub right_value_field: String,
    pub output_field: String,
    pub pivot_headers: Vec<String>,
    pub right_headers: Vec<String>,
}

fn col_letter(idx: usize) -> String {
    let mut n = idx;
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    s
}

fn write_filter_formulas(ws: &mut Worksheet, ft: &FilterTemplate) -> Result<(), String> {
    let header_fmt = header_format();
    for (c, h) in ft.headers.iter().enumerate() {
        ws.write_with_format(0, c as u16, h.as_str(), &header_fmt)
            .map_err(|e| e.to_string())?;
    }

    // Build FILTER formula for modern Excel
    let data_sheet = sanitize_sheet_name(&format!("数据_{}", ft.data_sheet));
    let end_row = (ft.data_rows + 1).max(2);
    let end_col = col_letter(ft.headers.len().saturating_sub(1));

    let mut cond_parts = Vec::new();
    for (col, op, value) in &ft.conditions {
        let Some(idx) = ft.headers.iter().position(|h| h == col) else {
            continue;
        };
        let cl = col_letter(idx);
        let range = format!("'{data_sheet}'!{cl}2:{cl}{end_row}");
        let part = match op.as_str() {
            "contains" => format!("ISNUMBER(SEARCH(\"{value}\",{range}))"),
            "not_contains" => format!("NOT(ISNUMBER(SEARCH(\"{value}\",IF({range}=\"\",\"\",{range}))))"),
            "eq" => format!("{range}=\"{value}\""),
            "neq" => format!("{range}<>\"{value}\""),
            _ => continue,
        };
        cond_parts.push(part);
    }

    if cond_parts.is_empty() {
        let formula = format!("=FILTER('{data_sheet}'!A2:{end_col}{end_row},TRUE,\"\")");
        ws.write_formula(1, 0, Formula::new(formula))
            .map_err(|e| e.to_string())?;
    } else {
        let include = cond_parts.join("*");
        let formula = format!(
            "=FILTER('{data_sheet}'!A2:{end_col}{end_row},({include}),\"\")"
        );
        ws.write_formula(1, 0, Formula::new(formula))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_pivot_formulas(ws: &mut Worksheet, pt: &PivotTemplate) -> Result<(), String> {
    let filtered = sanitize_sheet_name(&pt.filtered_sheet);
    let header_fmt = header_format();
    for (c, h) in pt.row_fields.iter().enumerate() {
        ws.write_with_format(0, c as u16, h.as_str(), &header_fmt)
            .map_err(|e| e.to_string())?;
    }
    let value_header = format!("{}_求和", pt.value_field);
    ws.write_with_format(0, pt.row_fields.len() as u16, value_header.as_str(), &header_fmt)
        .map_err(|e| e.to_string())?;

    // UNIQUE on first row field as starting point; for multiple row fields use HSTACK if needed
    if pt.row_fields.is_empty() {
        return Ok(());
    }

    let key_idxs: Vec<usize> = pt
        .row_fields
        .iter()
        .filter_map(|f| pt.filtered_headers.iter().position(|h| h == f))
        .collect();
    let value_idx = pt
        .filtered_headers
        .iter()
        .position(|h| h == &pt.value_field);

    if key_idxs.is_empty() {
        return Err("透视行字段在筛选结果表头中未找到".into());
    }

    // Data starts at row 2 on the filtered sheet (row 1 is header) — do not include
    // the header in UNIQUE/SUMIF or it spills as a second header row.
    const DATA_END: &str = "100000";

    // Spill UNIQUE of key columns
    if key_idxs.len() == 1 {
        let cl = col_letter(key_idxs[0]);
        let formula = format!(
            "=UNIQUE(FILTER('{filtered}'!{cl}2:{cl}{DATA_END},'{filtered}'!{cl}2:{cl}{DATA_END}<>\"\"))"
        );
        ws.write_formula(1, 0, Formula::new(formula))
            .map_err(|e| e.to_string())?;
    } else {
        // Use CHOOSECOLS + UNIQUE on filtered body — simplified: UNIQUE of first col, XLOOKUP others
        let cl = col_letter(key_idxs[0]);
        let formula = format!(
            "=UNIQUE(FILTER('{filtered}'!{cl}2:{cl}{DATA_END},'{filtered}'!{cl}2:{cl}{DATA_END}<>\"\"))"
        );
        ws.write_formula(1, 0, Formula::new(formula))
            .map_err(|e| e.to_string())?;
        for (i, &idx) in key_idxs.iter().enumerate().skip(1) {
            let rcl = col_letter(idx);
            let kcl = col_letter(key_idxs[0]);
            // For each unique key in A, lookup first matching other field
            let formula = format!(
                "=MAP(A2#,LAMBDA(k,XLOOKUP(k,'{filtered}'!{kcl}2:{kcl}{DATA_END},'{filtered}'!{rcl}2:{rcl}{DATA_END},\"\")))"
            );
            ws.write_formula(1, i as u16, Formula::new(formula))
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(vi) = value_idx {
        let vcl = col_letter(vi);
        let kcl = col_letter(key_idxs[0]);
        let col = pt.row_fields.len() as u16;
        let formula = format!(
            "=MAP(A2#,LAMBDA(k,SUMIF('{filtered}'!{kcl}2:{kcl}{DATA_END},k,'{filtered}'!{vcl}2:{vcl}{DATA_END})))"
        );
        ws.write_formula(1, col, Formula::new(formula))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn write_sort_formulas(ws: &mut Worksheet, st: &SortTemplate) -> Result<(), String> {
    let src = sanitize_sheet_name(&st.source_sheet);
    let header_fmt = header_format();
    for (c, h) in st.headers.iter().enumerate() {
        ws.write_with_format(0, c as u16, h.as_str(), &header_fmt)
            .map_err(|e| e.to_string())?;
    }
    if st.headers.is_empty() {
        return Ok(());
    }
    if st.keys.is_empty() {
        return Err("排序步骤缺少排序字段".into());
    }

    const DATA_END: &str = "100000";
    let end_col = col_letter(st.headers.len() - 1);
    let data_expr = format!(
        "FILTER('{src}'!A2:{end_col}{DATA_END},'{src}'!A2:A{DATA_END}<>\"\")"
    );

    let mut sort_args = Vec::new();
    for (col, desc) in &st.keys {
        let Some(idx) = st.headers.iter().position(|h| h == col) else {
            return Err(format!("排序字段「{col}」不在表头中"));
        };
        let order = if *desc { -1 } else { 1 };
        // SORTBY(array, by_col, order, ...) — by_col via INDEX on the filtered body
        sort_args.push(format!("INDEX(data,,{}),{}", idx + 1, order));
    }
    if sort_args.is_empty() {
        return Err("排序步骤没有有效的排序字段".into());
    }

    let formula = format!("=LET(data,{data_expr},SORTBY(data,{}))", sort_args.join(","));
    ws.write_formula(1, 0, Formula::new(formula))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn write_calculate_formulas(ws: &mut Worksheet, ct: &CalculateTemplate) -> Result<(), String> {
    let base_sheet = sanitize_sheet_name(&ct.base_sheet);
    let header_fmt = header_format();
    let mut headers = ct.base_headers.clone();
    headers.push(ct.output_field.clone());
    for (c, h) in headers.iter().enumerate() {
        ws.write_with_format(0, c as u16, h.as_str(), &header_fmt)
            .map_err(|e| e.to_string())?;
    }
    if ct.base_headers.is_empty() {
        return Ok(());
    }

    const DATA_END: &str = "100000";
    let end_col = col_letter(ct.base_headers.len() - 1);
    let row_expr = formula_refs_to_excel(
        &ct.formula,
        &ct.base_table_id,
        &ct.base_headers,
        &ct.joins,
    )?;

    let formula = format!(
        "=LET(base,FILTER('{base_sheet}'!A2:{end_col}{DATA_END},'{base_sheet}'!A2:A{DATA_END}<>\"\"),HSTACK(base,MAP(SEQUENCE(ROWS(base)),LAMBDA(i,{row_expr}))))"
    );
    ws.write_formula(1, 0, Formula::new(formula))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert `[tableId!col]` / `[col]` formula refs into Excel expressions for row `i` of `base`.
fn formula_refs_to_excel(
    formula: &str,
    base_table_id: &str,
    base_headers: &[String],
    joins: &[CalcJoinTemplate],
) -> Result<String, String> {
    let expr = formula.trim().trim_start_matches('=').trim();
    if expr.is_empty() {
        return Err("计算公式不能为空".into());
    }
    let mut out = String::new();
    let mut rest = expr;
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after
            .find(']')
            .ok_or_else(|| format!("公式括号未闭合: {formula}"))?;
        let inside = after[..end].trim();
        let piece = if let Some((tid, col)) = inside.split_once('!') {
            let tid = tid.trim();
            let col = col.trim();
            if tid == base_table_id {
                let idx = base_headers
                    .iter()
                    .position(|h| h == col)
                    .ok_or_else(|| format!("基准表缺少列「{col}」"))?
                    + 1;
                format!("INDEX(base,i,{idx})")
            } else {
                let join = joins
                    .iter()
                    .find(|j| j.table_id == tid)
                    .ok_or_else(|| format!("公式引用了未关联的表「{tid}」"))?;
                let sheet = sanitize_sheet_name(&join.sheet_name);
                let bk = base_headers
                    .iter()
                    .position(|h| h == &join.base_key)
                    .ok_or_else(|| format!("关联键「{}」不在基准表", join.base_key))?
                    + 1;
                let fk = join
                    .headers
                    .iter()
                    .position(|h| h == &join.foreign_key)
                    .ok_or_else(|| format!("关联键「{}」不在表「{tid}」", join.foreign_key))?;
                let vk = join
                    .headers
                    .iter()
                    .position(|h| h == col)
                    .ok_or_else(|| format!("表「{tid}」缺少列「{col}」"))?;
                let fcl = col_letter(fk);
                let vcl = col_letter(vk);
                format!(
                    "IFERROR(SUMIF('{sheet}'!{fcl}2:{fcl}100000,INDEX(base,i,{bk}),'{sheet}'!{vcl}2:{vcl}100000),0)"
                )
            }
        } else {
            let col = inside;
            let idx = base_headers
                .iter()
                .position(|h| h == col)
                .ok_or_else(|| format!("基准表缺少列「{col}」"))?
                + 1;
            format!("INDEX(base,i,{idx})")
        };
        out.push_str(&piece);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn write_new_premium_formulas(ws: &mut Worksheet, np: &NewPremiumTemplate) -> Result<(), String> {
    let pivot = sanitize_sheet_name(&np.pivot_sheet);
    let right = sanitize_sheet_name(&format!("数据_{}", np.right_data_sheet));

    let header_fmt = header_format();
    for (c, h) in np.pivot_headers.iter().enumerate() {
        ws.write_with_format(0, c as u16, h.as_str(), &header_fmt)
            .map_err(|e| e.to_string())?;
    }
    ws.write_with_format(
        0,
        np.pivot_headers.len() as u16,
        np.output_field.as_str(),
        &header_fmt,
    )
    .map_err(|e| e.to_string())?;

    let end_col = col_letter(np.pivot_headers.len().saturating_sub(1));
    let spill = format!("=FILTER('{pivot}'!A2:{end_col}100000,'{pivot}'!A2:A100000<>\"\")");
    ws.write_formula(1, 0, Formula::new(spill))
        .map_err(|e| e.to_string())?;

    let left_key_idx = np
        .pivot_headers
        .iter()
        .position(|h| h == &np.left_key)
        .unwrap_or(0);
    let left_val_idx = np
        .pivot_headers
        .iter()
        .position(|h| h == &np.left_value_field)
        .unwrap_or(np.pivot_headers.len().saturating_sub(1));
    let right_key_idx = np
        .right_headers
        .iter()
        .position(|h| h == &np.right_key)
        .unwrap_or(0);
    let right_val_idx = np
        .right_headers
        .iter()
        .position(|h| h == &np.right_value_field)
        .unwrap_or(1);

    let out_col = np.pivot_headers.len() as u16;
    let lk = col_letter(left_key_idx);
    let lv = col_letter(left_val_idx);
    let rk = col_letter(right_key_idx);
    let rv = col_letter(right_val_idx);

    let formula = format!(
        "=MAP(FILTER('{pivot}'!{lk}2:{lk}100000,'{pivot}'!{lk}2:{lk}100000<>\"\"),LAMBDA(k,IFERROR(XLOOKUP(k,'{pivot}'!{lk}:{lk},'{pivot}'!{lv}:{lv},0),0)-SUMIF('{right}'!{rk}:{rk},k,'{right}'!{rv}:{rv})))"
    );
    ws.write_formula(1, out_col, Formula::new(formula))
        .map_err(|e| e.to_string())?;
    Ok(())
}
