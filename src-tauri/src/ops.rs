use crate::models::{CalcJoin, DataTable, PivotValue};
use std::collections::HashMap;

pub fn parse_number(s: &str) -> f64 {
    let cleaned = s.replace(',', "").replace('，', "").trim().to_string();
    cleaned.parse::<f64>().unwrap_or(0.0)
}

fn format_number(v: f64) -> String {
    crate::excel_io::format_plain_number(v)
}

fn resolve_value_fields(
    value_fields: &[PivotValue],
    legacy_field: &str,
    legacy_agg: &str,
) -> Result<Vec<PivotValue>, String> {
    if !value_fields.is_empty() {
        return Ok(value_fields.to_vec());
    }
    if legacy_field.trim().is_empty() {
        return Err("请至少选择一个值字段".into());
    }
    Ok(vec![PivotValue {
        field: legacy_field.to_string(),
        aggregation: legacy_agg.to_string(),
        alias: String::new(),
    }])
}

fn agg_header(v: &PivotValue) -> String {
    if !v.alias.trim().is_empty() {
        return v.alias.clone();
    }
    let suffix = match v.aggregation.as_str() {
        "count" => "计数",
        "avg" => "平均",
        _ => "求和",
    };
    format!("{}_{}", v.field, suffix)
}

pub fn apply_pivot(
    table: &DataTable,
    row_fields: &[String],
    value_fields: &[PivotValue],
    legacy_field: &str,
    legacy_agg: &str,
) -> Result<DataTable, String> {
    if row_fields.is_empty() {
        return Err("透视表至少需要一个行字段".into());
    }
    let values = resolve_value_fields(value_fields, legacy_field, legacy_agg)?;
    let row_idxs: Vec<usize> = row_fields
        .iter()
        .map(|f| table.col_index(f))
        .collect::<Result<_, _>>()?;
    let value_idxs: Vec<(usize, &PivotValue)> = values
        .iter()
        .map(|v| Ok((table.col_index(&v.field)?, v)))
        .collect::<Result<_, String>>()?;

    // key -> (sums, counts) per value field
    let mut map: HashMap<Vec<String>, Vec<(f64, usize)>> = HashMap::new();

    for row in &table.rows {
        let key: Vec<String> = row_idxs
            .iter()
            .map(|i| row.get(*i).cloned().unwrap_or_default())
            .collect();
        let entry = map
            .entry(key)
            .or_insert_with(|| vec![(0.0, 0); value_idxs.len()]);
        for (vi, (idx, _)) in value_idxs.iter().enumerate() {
            let val = parse_number(row.get(*idx).map(|s| s.as_str()).unwrap_or(""));
            entry[vi].0 += val;
            entry[vi].1 += 1;
        }
    }

    let mut keys: Vec<_> = map.keys().cloned().collect();
    keys.sort();

    let mut headers = row_fields.to_vec();
    for v in &values {
        headers.push(agg_header(v));
    }

    let mut rows = Vec::new();
    for key in keys {
        let mut out = key.clone();
        let stats = map.get(&key).cloned().unwrap_or_default();
        for (i, (_, meta)) in value_idxs.iter().enumerate() {
            let (sum, count) = stats.get(i).copied().unwrap_or((0.0, 0));
            let v = match meta.aggregation.as_str() {
                "count" => count as f64,
                "avg" => {
                    if count == 0 {
                        0.0
                    } else {
                        sum / count as f64
                    }
                }
                _ => sum,
            };
            out.push(format_number(v));
        }
        rows.push(out);
    }

    Ok(DataTable { headers, rows, ..Default::default() })
}

pub fn apply_lookup_subtract(
    left: &DataTable,
    right: &DataTable,
    left_key: &str,
    right_key: &str,
    left_value_field: &str,
    right_value_field: &str,
    output_field: &str,
) -> Result<DataTable, String> {
    let formula = format!(
        "=[BASE!{left_value_field}]-[RIGHT!{right_value_field}]"
    );
    // Adapt via calculate with synthetic ids
    let joins = [CalcJoin {
        table_id: "RIGHT".into(),
        base_key: left_key.into(),
        foreign_key: right_key.into(),
    }];
    let mut tables = HashMap::new();
    tables.insert("BASE".into(), left);
    tables.insert("RIGHT".into(), right);
    apply_calculate(&tables, "BASE", output_field, &formula, &joins)
}

pub fn formula_table_ids(formula: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = formula;
    while let Some(start) = rest.find('[') {
        let after = &rest[start + 1..];
        let Some(end) = after.find(']') else { break };
        let inside = &after[..end];
        if let Some((tid, _)) = inside.split_once('!') {
            let tid = tid.trim();
            if !tid.is_empty() && !ids.iter().any(|x| x == tid) {
                ids.push(tid.to_string());
            }
        }
        rest = &after[end + 1..];
    }
    ids
}

/// Prefer common business keys, then any shared header name.
pub fn guess_join_keys(base_headers: &[String], foreign_headers: &[String]) -> Option<(String, String)> {
    const PREFERRED: &[&str] = &[
        "业务员代码",
        "业务员编码",
        "人员代码",
        "工号",
        "代码",
        "编号",
        "ID",
        "id",
        "Id",
    ];
    for key in PREFERRED {
        if base_headers.iter().any(|h| h == key) && foreign_headers.iter().any(|h| h == key) {
            return Some(((*key).to_string(), (*key).to_string()));
        }
    }
    for h in base_headers {
        if h.trim().is_empty() {
            continue;
        }
        if foreign_headers.iter().any(|f| f == h) {
            return Some((h.clone(), h.clone()));
        }
    }
    None
}

/// Formula refs: `[tableId!column]` or `[column]` (base table).
/// Supports + - * / ( ) and numbers. Leading `=` optional.
pub fn apply_calculate(
    tables: &HashMap<String, &DataTable>,
    base_table_id: &str,
    output_field: &str,
    formula: &str,
    joins: &[CalcJoin],
) -> Result<DataTable, String> {
    let base = tables
        .get(base_table_id)
        .copied()
        .ok_or_else(|| format!("找不到基准表「{base_table_id}」"))?;

    // Prebuild lookup maps: table_id -> (key -> row values by header)
    let mut lookup: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    for join in joins {
        let foreign = tables
            .get(&join.table_id)
            .copied()
            .ok_or_else(|| format!("关联表不存在: {}", join.table_id))?;
        let fk = foreign.col_index(&join.foreign_key)?;
        let mut map = HashMap::new();
        for row in &foreign.rows {
            let key = row.get(fk).cloned().unwrap_or_default();
            // If duplicate keys, keep first; values for numeric sum of same key handled by summing in formula via SUMIF-like later if needed
            map.entry(key).or_insert_with(|| row.clone());
        }
        // Also accumulate numeric sums for value columns when duplicate keys
        let mut sum_map: HashMap<String, HashMap<usize, f64>> = HashMap::new();
        for row in &foreign.rows {
            let key = row.get(fk).cloned().unwrap_or_default();
            let entry = sum_map.entry(key).or_default();
            for (i, cell) in row.iter().enumerate() {
                *entry.entry(i).or_insert(0.0) += parse_number(cell);
            }
        }
        // Store summed numeric representation in a parallel structure - for simplicity,
        // when duplicates exist, replace numeric cells with sums in map values
        for (key, sums) in sum_map {
            if let Some(row) = map.get_mut(&key) {
                for (i, sum) in sums {
                    if i < row.len() {
                        // Only replace if original looked numeric or sum differs
                        row[i] = format_number(sum);
                    }
                }
            }
        }
        lookup.insert(join.table_id.clone(), map);
    }

    let mut headers = base.headers.clone();
    headers.push(output_field.to_string());

    let expr = formula.trim().trim_start_matches('=').trim();
    if expr.is_empty() {
        return Err("计算公式不能为空".into());
    }

    let mut rows = Vec::new();
    for base_row in &base.rows {
        let mut ctx = HashMap::new();
        // Base columns as tableId!col and bare col
        for (i, h) in base.headers.iter().enumerate() {
            let val = parse_number(base_row.get(i).map(|s| s.as_str()).unwrap_or(""));
            ctx.insert(format!("{base_table_id}!{h}"), val);
            ctx.insert(h.clone(), val);
        }
        for join in joins {
            let bk = base.col_index(&join.base_key)?;
            let key = base_row.get(bk).cloned().unwrap_or_default();
            if let Some(foreign) = tables.get(&join.table_id) {
                if let Some(frow) = lookup
                    .get(&join.table_id)
                    .and_then(|m| m.get(&key))
                {
                    for (i, h) in foreign.headers.iter().enumerate() {
                        let val = parse_number(frow.get(i).map(|s| s.as_str()).unwrap_or(""));
                        ctx.insert(format!("{}!{h}", join.table_id), val);
                    }
                } else {
                    for h in &foreign.headers {
                        ctx.entry(format!("{}!{h}", join.table_id)).or_insert(0.0);
                    }
                }
            }
        }

        let result = eval_formula(expr, &ctx)
            .map_err(|e| format!("公式计算失败（行键相关）: {e}"))?;
        let mut out = base_row.clone();
        out.push(format_number(result));
        rows.push(out);
    }

    Ok(DataTable { headers, rows, ..Default::default() })
}

fn eval_formula(expr: &str, ctx: &HashMap<String, f64>) -> Result<f64, String> {
    let tokens = tokenize(expr)?;
    let mut pos = 0;
    let value = parse_expr(&tokens, &mut pos, ctx)?;
    if pos != tokens.len() {
        return Err(format!("公式解析未完成，停在: {:?}", tokens.get(pos)));
    }
    Ok(value)
}

#[derive(Debug, Clone)]
enum Tok {
    Num(f64),
    Ref(String),
    Op(char),
    LParen,
    RParen,
}

fn tokenize(expr: &str) -> Result<Vec<Tok>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = expr.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '[' {
            let end = chars[i..]
                .iter()
                .position(|x| *x == ']')
                .ok_or("缺少 ]")?;
            let raw: String = chars[i + 1..i + end].iter().collect();
            tokens.push(Tok::Ref(raw.trim().to_string()));
            i += end + 1;
            continue;
        }
        if c.is_ascii_digit() || c == '.' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let num: String = chars[start..i].iter().collect();
            tokens.push(Tok::Num(num.parse().map_err(|_| format!("无效数字: {num}"))?));
            continue;
        }
        match c {
            '+' | '-' | '*' | '/' => {
                tokens.push(Tok::Op(c));
                i += 1;
            }
            '(' => {
                tokens.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Tok::RParen);
                i += 1;
            }
            _ => return Err(format!("无法识别的字符: {c}")),
        }
    }
    Ok(tokens)
}

fn parse_expr(tokens: &[Tok], pos: &mut usize, ctx: &HashMap<String, f64>) -> Result<f64, String> {
    let mut left = parse_term(tokens, pos, ctx)?;
    while let Some(Tok::Op(op)) = tokens.get(*pos) {
        if *op != '+' && *op != '-' {
            break;
        }
        *pos += 1;
        let right = parse_term(tokens, pos, ctx)?;
        left = if *op == '+' { left + right } else { left - right };
    }
    Ok(left)
}

fn parse_term(tokens: &[Tok], pos: &mut usize, ctx: &HashMap<String, f64>) -> Result<f64, String> {
    let mut left = parse_factor(tokens, pos, ctx)?;
    while let Some(Tok::Op(op)) = tokens.get(*pos) {
        if *op != '*' && *op != '/' {
            break;
        }
        *pos += 1;
        let right = parse_factor(tokens, pos, ctx)?;
        left = if *op == '*' {
            left * right
        } else if right == 0.0 {
            0.0
        } else {
            left / right
        };
    }
    Ok(left)
}

fn parse_factor(tokens: &[Tok], pos: &mut usize, ctx: &HashMap<String, f64>) -> Result<f64, String> {
    match tokens.get(*pos) {
        Some(Tok::Op('-')) => {
            *pos += 1;
            Ok(-parse_factor(tokens, pos, ctx)?)
        }
        Some(Tok::Op('+')) => {
            *pos += 1;
            parse_factor(tokens, pos, ctx)
        }
        Some(Tok::Num(n)) => {
            *pos += 1;
            Ok(*n)
        }
        Some(Tok::Ref(name)) => {
            *pos += 1;
            ctx.get(name)
                .copied()
                .ok_or_else(|| format!("未知引用: [{name}]，请检查表/列或关联键"))
        }
        Some(Tok::LParen) => {
            *pos += 1;
            let v = parse_expr(tokens, pos, ctx)?;
            match tokens.get(*pos) {
                Some(Tok::RParen) => {
                    *pos += 1;
                    Ok(v)
                }
                _ => Err("缺少 )".into()),
            }
        }
        other => Err(format!("意外的标记: {other:?}")),
    }
}

pub fn apply_side_by_side(tables: &[&DataTable]) -> Result<DataTable, String> {
    if tables.is_empty() {
        return Err("并排输出至少需要一张表".into());
    }

    let mut headers = Vec::new();
    for (i, t) in tables.iter().enumerate() {
        if i > 0 {
            headers.push(String::new());
        }
        headers.extend(t.headers.clone());
    }

    let max_rows = tables.iter().map(|t| t.rows.len()).max().unwrap_or(0);
    let mut rows = Vec::new();
    for r in 0..max_rows {
        let mut row = Vec::new();
        for (i, t) in tables.iter().enumerate() {
            if i > 0 {
                row.push(String::new());
            }
            if let Some(src) = t.rows.get(r) {
                row.extend(src.clone());
            } else {
                row.extend(std::iter::repeat(String::new()).take(t.headers.len()));
            }
        }
        rows.push(row);
    }

    Ok(DataTable { headers, rows, ..Default::default() })
}

/// Build a side-by-side table from ordered column picks.
/// `column` empty => spacer column. Row-aligned by index across tables.
pub fn apply_side_by_side_columns(
    tables: &HashMap<String, &DataTable>,
    columns: &[crate::models::SideColumn],
) -> Result<DataTable, String> {
    if columns.is_empty() {
        return Err("请至少选择一列（或插入空列）".into());
    }

    let mut resolved: Vec<Option<(&DataTable, usize, String)>> = Vec::new();
    let mut max_rows = 0usize;
    for c in columns {
        if c.column.trim().is_empty() {
            resolved.push(None);
            continue;
        }
        if c.table_id.trim().is_empty() {
            return Err("列未指定来源表".into());
        }
        let table = tables
            .get(&c.table_id)
            .copied()
            .ok_or_else(|| format!("找不到表「{}」", c.table_id))?;
        let idx = table.col_index(&c.column)?;
        max_rows = max_rows.max(table.rows.len());
        resolved.push(Some((table, idx, c.column.clone())));
    }

    let headers: Vec<String> = resolved
        .iter()
        .map(|item| match item {
            None => String::new(),
            Some((_, _, name)) => name.clone(),
        })
        .collect();

    let mut rows = Vec::new();
    for r in 0..max_rows {
        let mut row = Vec::new();
        for item in &resolved {
            match item {
                None => row.push(String::new()),
                Some((table, idx, _)) => {
                    row.push(
                        table
                            .rows
                            .get(r)
                            .and_then(|row| row.get(*idx))
                            .cloned()
                            .unwrap_or_default(),
                    );
                }
            }
        }
        rows.push(row);
    }

    Ok(DataTable { headers, rows, ..Default::default() })
}

/// VLOOKUP-style left join: keep rows of `left`, look up `left_key` in `right_key`,
/// then keep selected left columns and append selected right columns.
/// Empty column lists mean “all columns”. Keys match by trimmed text, then by number
/// (so `1` equals `1.0` / `001` when both parse as numbers). Duplicate keys in B: first row.
pub fn apply_vlookup(
    left: &DataTable,
    right: &DataTable,
    left_key: &str,
    right_key: &str,
    left_columns: &[String],
    right_columns: &[String],
) -> Result<DataTable, String> {
    if left_key.trim().is_empty() || right_key.trim().is_empty() {
        return Err("请选择表A与表B的匹配列".into());
    }
    let lk = left.col_index(left_key)?;
    let rk = right.col_index(right_key)?;

    let left_cols: Vec<(usize, String)> = if left_columns.is_empty() {
        left.headers
            .iter()
            .enumerate()
            .map(|(i, h)| (i, h.clone()))
            .collect()
    } else {
        left_columns
            .iter()
            .map(|h| Ok((left.col_index(h)?, h.clone())))
            .collect::<Result<_, String>>()?
    };
    let right_cols: Vec<(usize, String)> = if right_columns.is_empty() {
        right
            .headers
            .iter()
            .enumerate()
            .map(|(i, h)| (i, h.clone()))
            .collect()
    } else {
        right_columns
            .iter()
            .map(|h| Ok((right.col_index(h)?, h.clone())))
            .collect::<Result<_, String>>()?
    };

    if left_cols.is_empty() {
        return Err("请至少选择表A的一列".into());
    }

    let mut headers: Vec<String> = left_cols.iter().map(|(_, h)| h.clone()).collect();
    let mut header_groups: Vec<u32> = vec![0; left_cols.len()];
    for (_, h) in &right_cols {
        headers.push(unique_header(&headers, h));
        header_groups.push(1);
    }

    let mut by_text: HashMap<String, &Vec<String>> = HashMap::new();
    let mut by_num: HashMap<String, &Vec<String>> = HashMap::new();
    for row in &right.rows {
        let raw = row.get(rk).map(|s| s.as_str()).unwrap_or("");
        let text = raw.trim().to_string();
        if !text.is_empty() {
            by_text.entry(text.clone()).or_insert(row);
        }
        if let Some(n) = canonical_number_key(raw) {
            by_num.entry(n).or_insert(row);
        }
    }

    let mut rows = Vec::with_capacity(left.rows.len());
    for arow in &left.rows {
        let mut out = Vec::with_capacity(headers.len());
        for (idx, _) in &left_cols {
            out.push(arow.get(*idx).cloned().unwrap_or_default());
        }
        let raw = arow.get(lk).map(|s| s.as_str()).unwrap_or("");
        let matched = by_text
            .get(raw.trim())
            .copied()
            .or_else(|| canonical_number_key(raw).and_then(|n| by_num.get(&n).copied()));
        for (idx, _) in &right_cols {
            out.push(
                matched
                    .and_then(|brow| brow.get(*idx).cloned())
                    .unwrap_or_default(),
            );
        }
        rows.push(out);
    }

    Ok(DataTable {
        headers,
        rows,
        header_groups,
    })
}

fn unique_header(existing: &[String], name: &str) -> String {
    if !existing.iter().any(|h| h == name) {
        return name.to_string();
    }
    let candidate = format!("{name}_B");
    if !existing.iter().any(|h| h == &candidate) {
        return candidate;
    }
    let mut n = 2usize;
    loop {
        let c = format!("{name}_B{n}");
        if !existing.iter().any(|h| h == &c) {
            return c;
        }
        n += 1;
    }
}

fn canonical_number_key(s: &str) -> Option<String> {
    crate::excel_io::safe_numeric_key(s)
}

pub fn apply_sort(
    table: &DataTable,
    keys: &[crate::models::SortKey],
) -> Result<DataTable, String> {
    if keys.is_empty() {
        return Err("请至少选择一个排序字段".into());
    }
    let key_specs: Vec<(usize, bool)> = keys
        .iter()
        .map(|k| {
            let idx = table.col_index(&k.column)?;
            let desc = k.direction.eq_ignore_ascii_case("desc");
            Ok((idx, desc))
        })
        .collect::<Result<_, String>>()?;

    let mut rows = table.rows.clone();
    rows.sort_by(|a, b| {
        for &(idx, desc) in &key_specs {
            let av = a.get(idx).map(|s| s.as_str()).unwrap_or("");
            let bv = b.get(idx).map(|s| s.as_str()).unwrap_or("");
            let ord = compare_cell(av, bv);
            if ord != std::cmp::Ordering::Equal {
                return if desc { ord.reverse() } else { ord };
            }
        }
        std::cmp::Ordering::Equal
    });

    Ok(DataTable {
        headers: table.headers.clone(),
        rows,
        header_groups: table.header_groups.clone(),
    })
}

/// Remove duplicate rows by selected columns (or all columns if empty). Keeps first occurrence.
pub fn apply_dedupe(table: &DataTable, columns: &[String]) -> Result<DataTable, String> {
    let idxs: Vec<usize> = if columns.is_empty() {
        (0..table.headers.len()).collect()
    } else {
        columns
            .iter()
            .map(|c| {
                if c.trim().is_empty() {
                    return Err("去重列不能为空".into());
                }
                table.col_index(c)
            })
            .collect::<Result<_, String>>()?
    };
    if idxs.is_empty() {
        return Err("表没有列，无法去重".into());
    }

    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for row in &table.rows {
        let key: Vec<String> = idxs
            .iter()
            .map(|&i| {
                let raw = row.get(i).map(|s| s.as_str()).unwrap_or("");
                crate::excel_io::match_key(raw)
            })
            .collect();
        if seen.insert(key) {
            rows.push(row.clone());
        }
    }

    Ok(DataTable {
        headers: table.headers.clone(),
        rows,
        header_groups: table.header_groups.clone(),
    })
}

fn compare_cell(a: &str, b: &str) -> std::cmp::Ordering {
    let an = parse_number_opt(a);
    let bn = parse_number_opt(b);
    match (an, bn) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        _ => a.cmp(b),
    }
}

fn parse_number_opt(s: &str) -> Option<f64> {
    let cleaned = s.replace(',', "").replace('，', "").trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

#[cfg(test)]
mod calc_tests {
    use super::*;

    #[test]
    fn formula_subtract() {
        let mut ctx = HashMap::new();
        ctx.insert("a".into(), 1500.0);
        ctx.insert("b".into(), 800.0);
        assert_eq!(eval_formula("[a]-[b]", &ctx).unwrap(), 700.0);
    }

    #[test]
    fn vlookup_appends_matched_columns() {
        let left = DataTable {
            headers: vec!["代码".into(), "姓名".into()],
            rows: vec![
                vec!["001".into(), "张三".into()],
                vec!["2".into(), "李四".into()],
                vec!["9".into(), "无匹配".into()],
            ],
            ..Default::default()
        };
        let right = DataTable {
            headers: vec!["工号".into(), "保费".into(), "机构".into()],
            rows: vec![
                vec!["1".into(), "100".into(), "南京".into()],
                vec!["2".into(), "200".into(), "苏州".into()],
            ],
            ..Default::default()
        };
        let out = apply_vlookup(&left, &right, "代码", "工号", &[], &[]).unwrap();
        assert_eq!(
            out.headers,
            vec!["代码", "姓名", "工号", "保费", "机构"]
        );
        assert_eq!(
            out.rows[0],
            vec!["001", "张三", "1", "100", "南京"]
        );
        assert_eq!(out.rows[1], vec!["2", "李四", "2", "200", "苏州"]);
        assert_eq!(out.rows[2], vec!["9", "无匹配", "", "", ""]);
    }

    #[test]
    fn vlookup_picks_columns_and_renames_clash() {
        let left = DataTable {
            headers: vec!["代码".into(), "名称".into()],
            rows: vec![vec!["A1".into(), "甲".into()]],
            ..Default::default()
        };
        let right = DataTable {
            headers: vec!["代码".into(), "名称".into(), "保费".into()],
            rows: vec![vec!["A1".into(), "乙".into(), "10".into()]],
            ..Default::default()
        };
        let out = apply_vlookup(
            &left,
            &right,
            "代码",
            "代码",
            &["代码".into(), "名称".into()],
            &["名称".into(), "保费".into()],
        )
        .unwrap();
        assert_eq!(out.headers, vec!["代码", "名称", "名称_B", "保费"]);
        assert_eq!(out.rows[0], vec!["A1", "甲", "乙", "10"]);
    }

    #[test]
    fn sort_numeric_desc() {
        let table = DataTable {
            headers: vec!["名".into(), "值".into()],
            rows: vec![
                vec!["a".into(), "10".into()],
                vec!["b".into(), "30".into()],
                vec!["c".into(), "20".into()],
            ],
            ..Default::default()
        };
        let sorted = apply_sort(
            &table,
            &[crate::models::SortKey {
                column: "值".into(),
                direction: "desc".into(),
            }],
        )
        .unwrap();
        assert_eq!(sorted.rows[0][1], "30");
        assert_eq!(sorted.rows[2][1], "10");
    }

    #[test]
    fn dedupe_keeps_first_by_columns() {
        let table = DataTable {
            headers: vec!["代码".into(), "姓名".into(), "保费".into()],
            rows: vec![
                vec!["A001".into(), "张三".into(), "100".into()],
                vec!["A001".into(), "张三改".into(), "200".into()],
                vec!["A002".into(), "李四".into(), "50".into()],
                vec!["1".into(), "王五".into(), "10".into()],
                vec!["1.0".into(), "王五重复".into(), "20".into()],
            ],
            ..Default::default()
        };
        let by_code = apply_dedupe(&table, &["代码".into()]).unwrap();
        assert_eq!(by_code.rows.len(), 3);
        assert_eq!(by_code.rows[0], vec!["A001", "张三", "100"]);
        assert_eq!(by_code.rows[1][0], "A002");
        assert_eq!(by_code.rows[2][1], "王五");

        let all = apply_dedupe(&table, &[]).unwrap();
        assert_eq!(all.rows.len(), 5);
    }
}
