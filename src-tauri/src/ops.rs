use crate::models::{CalcColumn, CalcJoin, DataTable, PivotValue};
use chrono::{Datelike, Local, Timelike};
use std::collections::HashMap;

pub fn parse_number(s: &str) -> f64 {
    let cleaned = s.replace(',', "").replace('，', "").trim().to_string();
    cleaned.parse::<f64>().unwrap_or(0.0)
}

/// 仅用于加减乘除（及乘方）时的中间/结果四舍五入到 2 位小数。
fn round_calc(n: f64) -> f64 {
    if !n.is_finite() {
        return 0.0;
    }
    (n * 100.0).round() / 100.0
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
    apply_calculate(
        &tables,
        "BASE",
        &[CalcColumn {
            output_field: output_field.into(),
            formula,
        }],
        &joins,
    )
}

/// Merge legacy single `output_field`/`formula` with `columns`.
pub fn resolve_calc_columns(
    output_field: &str,
    formula: &str,
    columns: &[CalcColumn],
) -> Vec<CalcColumn> {
    if !columns.is_empty() {
        return columns.to_vec();
    }
    let field = output_field.trim();
    let expr = formula.trim();
    if field.is_empty() && expr.is_empty() {
        return Vec::new();
    }
    vec![CalcColumn {
        output_field: if field.is_empty() {
            "计算结果".into()
        } else {
            field.to_string()
        },
        formula: formula.to_string(),
    }]
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

pub fn formulas_table_ids(formulas: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let mut ids = Vec::new();
    for f in formulas {
        for tid in formula_table_ids(f.as_ref()) {
            if !ids.iter().any(|x| x == &tid) {
                ids.push(tid);
            }
        }
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
/// Supports arithmetic, comparisons (`>=`…), strings, and Excel functions
/// (`IF`/`OR`/`SUMIF`/`TODAY`/…). Leading `=` optional.
/// Multiple `columns` are evaluated left-to-right; later formulas may reference
/// earlier output field names as numbers when the prior result is numeric.
pub fn apply_calculate(
    tables: &HashMap<String, &DataTable>,
    base_table_id: &str,
    columns: &[CalcColumn],
    joins: &[CalcJoin],
) -> Result<DataTable, String> {
    let base = tables
        .get(base_table_id)
        .copied()
        .ok_or_else(|| format!("找不到基准表「{base_table_id}」"))?;

    if columns.is_empty() {
        return Err("请至少添加一列计算".into());
    }
    for (i, col) in columns.iter().enumerate() {
        if col.output_field.trim().is_empty() {
            return Err(format!("第 {} 个计算列缺少输出列名", i + 1));
        }
        let expr = col.formula.trim().trim_start_matches('=').trim();
        if expr.is_empty() {
            return Err(format!(
                "计算列「{}」的公式不能为空",
                col.output_field.trim()
            ));
        }
    }
    {
        let mut seen = HashMap::new();
        for col in columns {
            let name = col.output_field.trim().to_string();
            if seen.insert(name.clone(), ()).is_some() {
                return Err(format!("计算列名重复：「{name}」"));
            }
            if base.headers.iter().any(|h| h == &name) {
                return Err(format!("计算列名「{name}」与基准表已有列冲突"));
            }
        }
    }

    // Prebuild lookup maps for joined tables (scalar cross-row refs)
    let mut lookup: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    for join in joins {
        if join.base_key.trim().is_empty() || join.foreign_key.trim().is_empty() {
            continue;
        }
        let foreign = tables
            .get(&join.table_id)
            .copied()
            .ok_or_else(|| format!("关联表不存在: {}", join.table_id))?;
        let fk = foreign.col_index(&join.foreign_key)?;
        let mut map = HashMap::new();
        for row in &foreign.rows {
            let key = row.get(fk).cloned().unwrap_or_default();
            map.entry(key).or_insert_with(|| row.clone());
        }
        let mut sum_map: HashMap<String, HashMap<usize, f64>> = HashMap::new();
        for row in &foreign.rows {
            let key = row.get(fk).cloned().unwrap_or_default();
            let entry = sum_map.entry(key).or_default();
            for (i, cell) in row.iter().enumerate() {
                *entry.entry(i).or_insert(0.0) += parse_number(cell);
            }
        }
        for (key, sums) in sum_map {
            if let Some(row) = map.get_mut(&key) {
                for (i, sum) in sums {
                    if i < row.len() {
                        row[i] = format_number(sum);
                    }
                }
            }
        }
        lookup.insert(join.table_id.clone(), map);
    }

    let mut headers = base.headers.clone();
    for col in columns {
        headers.push(col.output_field.trim().to_string());
    }

    let mut rows = Vec::new();
    for base_row in &base.rows {
        let mut nums = HashMap::new();
        let mut texts = HashMap::new();
        for (i, h) in base.headers.iter().enumerate() {
            let raw = base_row.get(i).cloned().unwrap_or_default();
            let val = parse_number(&raw);
            nums.insert(format!("{base_table_id}!{h}"), val);
            nums.insert(h.clone(), val);
            texts.insert(format!("{base_table_id}!{h}"), raw.clone());
            texts.insert(h.clone(), raw);
        }
        for join in joins {
            if join.base_key.trim().is_empty() || join.foreign_key.trim().is_empty() {
                continue;
            }
            let bk = base.col_index(&join.base_key)?;
            let key = base_row.get(bk).cloned().unwrap_or_default();
            if let Some(foreign) = tables.get(&join.table_id) {
                if let Some(frow) = lookup
                    .get(&join.table_id)
                    .and_then(|m| m.get(&key))
                {
                    for (i, h) in foreign.headers.iter().enumerate() {
                        let raw = frow.get(i).cloned().unwrap_or_default();
                        let val = parse_number(&raw);
                        let k = format!("{}!{h}", join.table_id);
                        nums.insert(k.clone(), val);
                        texts.insert(k, raw);
                    }
                } else {
                    for h in &foreign.headers {
                        let k = format!("{}!{h}", join.table_id);
                        nums.entry(k.clone()).or_insert(0.0);
                        texts.entry(k).or_insert_with(String::new);
                    }
                }
            }
        }

        let mut env = FormulaEnv {
            nums,
            texts,
            tables,
            base_id: base_table_id,
        };

        let mut out = base_row.clone();
        for col in columns {
            let field = col.output_field.trim();
            let expr = col.formula.trim().trim_start_matches('=').trim();
            let result = eval_formula(expr, &env).map_err(|e| {
                format!("公式计算失败（列「{field}」）: {e}")
            })?;
            out.push(result.to_cell());
            match &result {
                CalcValue::Num(n) => {
                    env.nums.insert(field.to_string(), *n);
                    env.nums.insert(format!("{base_table_id}!{field}"), *n);
                    let s = format_number(*n);
                    env.texts.insert(field.to_string(), s.clone());
                    env.texts.insert(format!("{base_table_id}!{field}"), s);
                }
                CalcValue::Str(s) => {
                    env.texts.insert(field.to_string(), s.clone());
                    env.texts
                        .insert(format!("{base_table_id}!{field}"), s.clone());
                    if let Ok(n) = parse_number_strict(s) {
                        env.nums.insert(field.to_string(), n);
                        env.nums.insert(format!("{base_table_id}!{field}"), n);
                    }
                }
                CalcValue::Bool(b) => {
                    let n = if *b { 1.0 } else { 0.0 };
                    env.nums.insert(field.to_string(), n);
                    env.nums.insert(format!("{base_table_id}!{field}"), n);
                    let s = if *b { "TRUE" } else { "FALSE" };
                    env.texts.insert(field.to_string(), s.into());
                    env.texts
                        .insert(format!("{base_table_id}!{field}"), s.into());
                }
            }
        }
        rows.push(out);
    }

    Ok(DataTable {
        headers,
        rows,
        ..Default::default()
    })
}

fn parse_number_strict(s: &str) -> Result<f64, ()> {
    let cleaned = s.replace(',', "").replace('，', "").trim().to_string();
    if cleaned.is_empty() {
        return Err(());
    }
    cleaned.parse().map_err(|_| ())
}

fn looks_numeric_cell(s: &str) -> bool {
    parse_number_strict(s).is_ok()
}

/// 空单元格、工号/单号等无小数点纯数字、超长数字串、前导零 → 保持文本。
/// 带小数点的金额等仍按数值，便于算术与拼接时两位小数。
fn prefer_formula_text(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return true;
    }
    if t.contains('E') || t.contains('e') {
        return true;
    }
    let body = t.trim_start_matches('-').replace(',', "").replace('，', "");
    if body.starts_with('0') && body.len() > 1 && !body.starts_with("0.") {
        return true;
    }
    let int_digits = body.split('.').next().unwrap_or("").len();
    if int_digits > 15 {
        return true;
    }
    // 无小数点的纯数字（工号、单号、代码等）一律文本，避免拼成 26070006.00
    if looks_numeric_cell(t) && !body.contains('.') {
        return true;
    }
    !looks_numeric_cell(t)
}

fn resolve_scalar_ref(env: &FormulaEnv<'_>, name: &str) -> Result<CalcValue, String> {
    if let Some(text) = env.texts.get(name) {
        if prefer_formula_text(text) {
            return Ok(CalcValue::Str(text.clone()));
        }
        // 短数字：给算术用数值，同时可走 texts 回退
        if let Some(n) = env.nums.get(name) {
            return Ok(CalcValue::Num(*n));
        }
        if let Ok(n) = parse_number_strict(text) {
            return Ok(CalcValue::Num(n));
        }
        return Ok(CalcValue::Str(text.clone()));
    }
    if let Some(n) = env.nums.get(name) {
        return Ok(CalcValue::Num(*n));
    }
    Err(format!("未知引用: [{name}]，请检查表/列或关联键"))
}

struct FormulaEnv<'a> {
    nums: HashMap<String, f64>,
    texts: HashMap<String, String>,
    tables: &'a HashMap<String, &'a DataTable>,
    base_id: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
enum CalcValue {
    Num(f64),
    Str(String),
    Bool(bool),
}

impl CalcValue {
    fn to_cell(&self) -> String {
        match self {
            CalcValue::Num(n) => format_number(*n),
            CalcValue::Str(s) => s.clone(),
            CalcValue::Bool(b) => {
                if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
        }
    }

    fn as_number(&self) -> Result<f64, String> {
        match self {
            CalcValue::Num(n) => Ok(*n),
            CalcValue::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
            CalcValue::Str(s) => {
                let t = s.trim();
                if t.is_empty() {
                    return Ok(0.0);
                }
                t.replace(',', "")
                    .replace('，', "")
                    .parse::<f64>()
                    .map_err(|_| format!("无法将「{s}」转为数字"))
            }
        }
    }

    fn is_truthy(&self) -> bool {
        match self {
            CalcValue::Bool(b) => *b,
            CalcValue::Num(n) => *n != 0.0,
            CalcValue::Str(s) => !s.is_empty(),
        }
    }

    fn as_criteria_text(&self) -> String {
        match self {
            CalcValue::Str(s) => s.clone(),
            CalcValue::Num(n) => format_number(*n),
            CalcValue::Bool(b) => {
                if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
        }
    }

    fn as_text(&self) -> String {
        self.as_criteria_text()
    }

    /// `&` / CONCAT：数值按两位小数拼进文本（四舍五入）。
    fn as_concat_text(&self) -> String {
        match self {
            CalcValue::Num(n) => format!("{:.2}", round_calc(*n)),
            other => other.as_text(),
        }
    }
}

fn eval_formula(expr: &str, env: &FormulaEnv<'_>) -> Result<CalcValue, String> {
    let tokens = tokenize(expr)?;
    let mut pos = 0;
    let value = parse_comparison(&tokens, &mut pos, env)?;
    if pos != tokens.len() {
        return Err(format!("公式解析未完成，停在: {:?}", tokens.get(pos)));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq)]
enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone)]
enum Tok {
    Num(f64),
    Str(String),
    Ref(String),
    Ident(String),
    Op(char),
    Cmp(CmpOp),
    Comma,
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
        if c == '"' {
            i += 1;
            let mut s = String::new();
            while i < chars.len() {
                if chars[i] == '"' {
                    if i + 1 < chars.len() && chars[i + 1] == '"' {
                        s.push('"');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                s.push(chars[i]);
                i += 1;
            }
            tokens.push(Tok::Str(s));
            continue;
        }
        if c == '\'' {
            // Excel-style sheet quote is not supported in-app; use [table!col].
            return Err(
                "计算步骤请使用 [表ID!列名] 引用，不支持 Excel 工作表写法如 '寿险-7.29'!J:J"
                    .into(),
            );
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
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let name: String = chars[start..i].iter().collect();
            tokens.push(Tok::Ident(name));
            continue;
        }
        if c.is_ascii_digit() || c == '.' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let num: String = chars[start..i].iter().collect();
            tokens.push(Tok::Num(
                num.parse().map_err(|_| format!("无效数字: {num}"))?,
            ));
            continue;
        }
        if c == '<' {
            if i + 1 < chars.len() && chars[i + 1] == '=' {
                tokens.push(Tok::Cmp(CmpOp::Le));
                i += 2;
            } else if i + 1 < chars.len() && chars[i + 1] == '>' {
                tokens.push(Tok::Cmp(CmpOp::Ne));
                i += 2;
            } else {
                tokens.push(Tok::Cmp(CmpOp::Lt));
                i += 1;
            }
            continue;
        }
        if c == '>' {
            if i + 1 < chars.len() && chars[i + 1] == '=' {
                tokens.push(Tok::Cmp(CmpOp::Ge));
                i += 2;
            } else {
                tokens.push(Tok::Cmp(CmpOp::Gt));
                i += 1;
            }
            continue;
        }
        if c == '=' {
            tokens.push(Tok::Cmp(CmpOp::Eq));
            i += 1;
            continue;
        }
        match c {
            '+' | '-' | '*' | '/' | '^' | '&' => {
                tokens.push(Tok::Op(c));
                i += 1;
            }
            ',' => {
                tokens.push(Tok::Comma);
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

fn parse_comparison(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let left = parse_concat(tokens, pos, env)?;
    let Some(Tok::Cmp(op)) = tokens.get(*pos).cloned() else {
        return Ok(left);
    };
    *pos += 1;
    let right = parse_concat(tokens, pos, env)?;
    Ok(CalcValue::Bool(compare_values(&left, &right, &op)?))
}

fn parse_concat(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let mut left = parse_expr(tokens, pos, env)?;
    while let Some(Tok::Op('&')) = tokens.get(*pos) {
        *pos += 1;
        let right = parse_expr(tokens, pos, env)?;
        left = CalcValue::Str(format!("{}{}", left.as_concat_text(), right.as_concat_text()));
    }
    Ok(left)
}

fn compare_values(left: &CalcValue, right: &CalcValue, op: &CmpOp) -> Result<bool, String> {
    let ln = left.as_number();
    let rn = right.as_number();
    if let (Ok(a), Ok(b)) = (&ln, &rn) {
        return Ok(match op {
            CmpOp::Eq => (*a - *b).abs() < 1e-12,
            CmpOp::Ne => (*a - *b).abs() >= 1e-12,
            CmpOp::Lt => *a < *b,
            CmpOp::Le => *a <= *b,
            CmpOp::Gt => *a > *b,
            CmpOp::Ge => *a >= *b,
        });
    }
    let ls = left.as_criteria_text();
    let rs = right.as_criteria_text();
    Ok(match op {
        CmpOp::Eq => ls == rs,
        CmpOp::Ne => ls != rs,
        CmpOp::Lt => ls < rs,
        CmpOp::Le => ls <= rs,
        CmpOp::Gt => ls > rs,
        CmpOp::Ge => ls >= rs,
    })
}

fn parse_expr(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let mut left = parse_term(tokens, pos, env)?;
    while let Some(Tok::Op(op)) = tokens.get(*pos) {
        if *op != '+' && *op != '-' {
            break;
        }
        *pos += 1;
        let right = parse_term(tokens, pos, env)?;
        let a = round_calc(left.as_number()?);
        let b = round_calc(right.as_number()?);
        left = CalcValue::Num(round_calc(if *op == '+' { a + b } else { a - b }));
    }
    Ok(left)
}

fn parse_term(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let mut left = parse_power(tokens, pos, env)?;
    while let Some(Tok::Op(op)) = tokens.get(*pos) {
        if *op != '*' && *op != '/' {
            break;
        }
        *pos += 1;
        let right = parse_power(tokens, pos, env)?;
        let a = round_calc(left.as_number()?);
        let b = round_calc(right.as_number()?);
        left = CalcValue::Num(round_calc(if *op == '*' {
            a * b
        } else if b == 0.0 {
            0.0
        } else {
            a / b
        }));
    }
    Ok(left)
}

fn parse_power(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let left = parse_factor(tokens, pos, env)?;
    if let Some(Tok::Op('^')) = tokens.get(*pos) {
        *pos += 1;
        let right = parse_power(tokens, pos, env)?;
        Ok(CalcValue::Num(round_calc(
            round_calc(left.as_number()?).powf(round_calc(right.as_number()?)),
        )))
    } else {
        Ok(left)
    }
}

fn is_range_agg_fn(name: &str) -> bool {
    matches!(
        name.to_ascii_uppercase().as_str(),
        "SUMIF" | "COUNTIF" | "SUMIFS" | "COUNTIFS"
    )
}

fn parse_factor(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    match tokens.get(*pos).cloned() {
        Some(Tok::Op('-')) => {
            *pos += 1;
            Ok(CalcValue::Num(-parse_factor(tokens, pos, env)?.as_number()?))
        }
        Some(Tok::Op('+')) => {
            *pos += 1;
            parse_factor(tokens, pos, env)
        }
        Some(Tok::Num(n)) => {
            *pos += 1;
            Ok(CalcValue::Num(n))
        }
        Some(Tok::Str(s)) => {
            *pos += 1;
            Ok(CalcValue::Str(s))
        }
        Some(Tok::Ref(name)) => {
            *pos += 1;
            resolve_scalar_ref(env, &name)
        }
        Some(Tok::Ident(name)) => {
            *pos += 1;
            match tokens.get(*pos) {
                Some(Tok::LParen) => {
                    *pos += 1;
                    if is_range_agg_fn(&name) {
                        eval_range_agg_fn(&name, tokens, pos, env)
                    } else if name.eq_ignore_ascii_case("IFERROR") {
                        eval_iferror(tokens, pos, env)
                    } else if name.eq_ignore_ascii_case("IF") {
                        eval_if(tokens, pos, env)
                    } else {
                        let args = parse_arg_list(tokens, pos, env)?;
                        eval_excel_fn(&name, &args)
                    }
                }
                _ => Err(format!("未知标识符「{name}」（函数需写为 {name}(...)）")),
            }
        }
        Some(Tok::LParen) => {
            *pos += 1;
            let v = parse_comparison(tokens, pos, env)?;
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

fn parse_arg_list(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<Vec<CalcValue>, String> {
    let mut args = Vec::new();
    if matches!(tokens.get(*pos), Some(Tok::RParen)) {
        *pos += 1;
        return Ok(args);
    }
    loop {
        args.push(parse_comparison(tokens, pos, env)?);
        match tokens.get(*pos) {
            Some(Tok::Comma) => {
                *pos += 1;
            }
            Some(Tok::RParen) => {
                *pos += 1;
                break;
            }
            _ => return Err("函数参数列表缺少 , 或 )".into()),
        }
    }
    Ok(args)
}

/// 跳过一个函数实参（不求值），停在逗号或同层 `)` 之前。
fn skip_arg(tokens: &[Tok], pos: &mut usize) -> Result<(), String> {
    let start = *pos;
    let mut depth = 0i32;
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Tok::LParen => {
                depth += 1;
                *pos += 1;
            }
            Tok::RParen => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                *pos += 1;
            }
            Tok::Comma if depth == 0 => break,
            _ => *pos += 1,
        }
    }
    if *pos == start {
        return Err("函数参数为空".into());
    }
    Ok(())
}

fn eval_iferror(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let mut try_pos = *pos;
    match parse_comparison(tokens, &mut try_pos, env) {
        Ok(v) => {
            *pos = try_pos;
            match tokens.get(*pos) {
                Some(Tok::Comma) => *pos += 1,
                _ => return Err("IFERROR 需要 2 个参数".into()),
            }
            skip_arg(tokens, pos)?;
            match tokens.get(*pos) {
                Some(Tok::RParen) => {
                    *pos += 1;
                    Ok(v)
                }
                _ => Err("IFERROR 缺少 )".into()),
            }
        }
        Err(_) => {
            skip_arg(tokens, pos)?;
            match tokens.get(*pos) {
                Some(Tok::Comma) => *pos += 1,
                _ => return Err("IFERROR 需要 2 个参数".into()),
            }
            let alt = parse_comparison(tokens, pos, env)?;
            match tokens.get(*pos) {
                Some(Tok::RParen) => {
                    *pos += 1;
                    Ok(alt)
                }
                _ => Err("IFERROR 缺少 )".into()),
            }
        }
    }
}

/// Excel 风格：只求值条件为真的分支（避免未走分支里的 FIND 报错）。
fn eval_if(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let cond = parse_comparison(tokens, pos, env)?;
    match tokens.get(*pos) {
        Some(Tok::Comma) => *pos += 1,
        _ => return Err("IF 需要 3 个参数".into()),
    }
    if cond.is_truthy() {
        let v = parse_comparison(tokens, pos, env)?;
        match tokens.get(*pos) {
            Some(Tok::Comma) => *pos += 1,
            _ => return Err("IF 需要 3 个参数".into()),
        }
        skip_arg(tokens, pos)?;
        match tokens.get(*pos) {
            Some(Tok::RParen) => {
                *pos += 1;
                Ok(v)
            }
            _ => Err("IF 缺少 )".into()),
        }
    } else {
        skip_arg(tokens, pos)?;
        match tokens.get(*pos) {
            Some(Tok::Comma) => *pos += 1,
            _ => return Err("IF 需要 3 个参数".into()),
        }
        let v = parse_comparison(tokens, pos, env)?;
        match tokens.get(*pos) {
            Some(Tok::RParen) => {
                *pos += 1;
                Ok(v)
            }
            _ => Err("IF 缺少 )".into()),
        }
    }
}

#[derive(Clone)]
struct ColCells {
    table_id: String,
    col: String,
    texts: Vec<String>,
    nums: Vec<f64>,
}

fn parse_column_ref_arg(
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<ColCells, String> {
    match tokens.get(*pos).cloned() {
        Some(Tok::Ref(name)) => {
            *pos += 1;
            resolve_column(env, &name)
        }
        _ => Err("SUMIF/COUNTIF 的区域参数须为 [表ID!列名] 或 [列名]".into()),
    }
}

fn resolve_column(env: &FormulaEnv<'_>, name: &str) -> Result<ColCells, String> {
    let (tid, col) = if let Some((t, c)) = name.split_once('!') {
        (t.trim(), c.trim())
    } else {
        (env.base_id, name.trim())
    };
    if tid.is_empty() || col.is_empty() {
        return Err(format!("无效列引用: [{name}]"));
    }
    let table = env
        .tables
        .get(tid)
        .copied()
        .ok_or_else(|| format!("SUMIF 找不到表「{tid}」（请确认表已加载）"))?;
    let idx = table.col_index(col)?;
    let mut texts = Vec::with_capacity(table.rows.len());
    let mut nums = Vec::with_capacity(table.rows.len());
    for row in &table.rows {
        let raw = row.get(idx).cloned().unwrap_or_default();
        nums.push(parse_number(&raw));
        texts.push(raw);
    }
    Ok(ColCells {
        table_id: tid.to_string(),
        col: col.to_string(),
        texts,
        nums,
    })
}

fn expect_comma(tokens: &[Tok], pos: &mut usize) -> Result<(), String> {
    match tokens.get(*pos) {
        Some(Tok::Comma) => {
            *pos += 1;
            Ok(())
        }
        _ => Err("函数参数之间缺少 ,".into()),
    }
}

fn expect_rparen(tokens: &[Tok], pos: &mut usize) -> Result<(), String> {
    match tokens.get(*pos) {
        Some(Tok::RParen) => {
            *pos += 1;
            Ok(())
        }
        _ => Err("缺少 )".into()),
    }
}

fn ensure_same_table_ranges(
    a: &ColCells,
    b: &ColCells,
    fn_name: &str,
) -> Result<(), String> {
    if a.table_id != b.table_id {
        return Err(format!(
            "{fn_name} 的条件列与求和列必须来自同一张表（按行号对齐求和）。\
             当前条件列 [{tid_a}!{col_a}]，求和列 [{tid_b}!{col_b}]。\
             若基准表是销售人员、要按工号汇总寿险，请写成：\
             SUMIF([src:寿险-7.29!原工号],[销售人员代码],[src:寿险-7.29!金额列])",
            tid_a = a.table_id,
            col_a = a.col,
            tid_b = b.table_id,
            col_b = b.col,
        ));
    }
    if a.texts.len() != b.texts.len() {
        return Err(format!(
            "{fn_name} 条件列与求和列行数不一致（{} vs {}）",
            a.texts.len(),
            b.texts.len()
        ));
    }
    Ok(())
}

fn criteria_matches(cell_text: &str, cell_num: f64, criteria: &CalcValue) -> bool {
    let crit = criteria.as_criteria_text();
    let c = crit.trim();
    if c.is_empty() {
        return cell_text.trim().is_empty();
    }

    let (op, rest) = if let Some(r) = c.strip_prefix(">=") {
        (CmpOp::Ge, r.trim())
    } else if let Some(r) = c.strip_prefix("<=") {
        (CmpOp::Le, r.trim())
    } else if let Some(r) = c.strip_prefix("<>") {
        (CmpOp::Ne, r.trim())
    } else if let Some(r) = c.strip_prefix('>') {
        (CmpOp::Gt, r.trim())
    } else if let Some(r) = c.strip_prefix('<') {
        (CmpOp::Lt, r.trim())
    } else if let Some(r) = c.strip_prefix('=') {
        (CmpOp::Eq, r.trim())
    } else {
        (CmpOp::Eq, c)
    };

    // Equality: use match_key so 001 / 1 / 1.0 工号能对上
    if matches!(op, CmpOp::Eq | CmpOp::Ne) {
        let same =
            crate::excel_io::match_key(cell_text) == crate::excel_io::match_key(rest);
        return if op == CmpOp::Eq { same } else { !same };
    }

    let cell_v = if looks_numeric_cell(cell_text) {
        CalcValue::Num(cell_num)
    } else {
        CalcValue::Str(cell_text.trim().to_string())
    };
    let rest_v = if looks_numeric_cell(rest) {
        CalcValue::Num(parse_number(rest))
    } else {
        CalcValue::Str(rest.to_string())
    };
    compare_values(&cell_v, &rest_v, &op).unwrap_or(false)
}

fn eval_sumif(
    criteria_range: &ColCells,
    criteria: &CalcValue,
    sum_range: &ColCells,
) -> Result<f64, String> {
    ensure_same_table_ranges(criteria_range, sum_range, "SUMIF")?;
    let mut total = 0.0;
    for i in 0..criteria_range.texts.len() {
        if criteria_matches(&criteria_range.texts[i], criteria_range.nums[i], criteria) {
            total += sum_range.nums[i];
        }
    }
    Ok(total)
}

fn eval_countif(criteria_range: &ColCells, criteria: &CalcValue) -> f64 {
    let mut count = 0.0;
    for i in 0..criteria_range.texts.len() {
        if criteria_matches(&criteria_range.texts[i], criteria_range.nums[i], criteria) {
            count += 1.0;
        }
    }
    count
}

fn eval_range_agg_fn(
    name: &str,
    tokens: &[Tok],
    pos: &mut usize,
    env: &FormulaEnv<'_>,
) -> Result<CalcValue, String> {
    let upper = name.to_ascii_uppercase();
    match upper.as_str() {
        "SUMIF" => {
            let criteria_range = parse_column_ref_arg(tokens, pos, env)?;
            expect_comma(tokens, pos)?;
            let criteria = parse_comparison(tokens, pos, env)?;
            let sum_range = if matches!(tokens.get(*pos), Some(Tok::Comma)) {
                *pos += 1;
                parse_column_ref_arg(tokens, pos, env)?
            } else {
                criteria_range.clone()
            };
            expect_rparen(tokens, pos)?;
            Ok(CalcValue::Num(eval_sumif(
                &criteria_range,
                &criteria,
                &sum_range,
            )?))
        }
        "COUNTIF" => {
            let criteria_range = parse_column_ref_arg(tokens, pos, env)?;
            expect_comma(tokens, pos)?;
            let criteria = parse_comparison(tokens, pos, env)?;
            expect_rparen(tokens, pos)?;
            Ok(CalcValue::Num(eval_countif(&criteria_range, &criteria)))
        }
        "SUMIFS" => {
            // SUMIFS(sum_range, criteria_range1, criteria1, ...)
            let sum_range = parse_column_ref_arg(tokens, pos, env)?;
            let mut pairs = Vec::new();
            while matches!(tokens.get(*pos), Some(Tok::Comma)) {
                *pos += 1;
                if matches!(tokens.get(*pos), Some(Tok::RParen)) {
                    break;
                }
                let cr = parse_column_ref_arg(tokens, pos, env)?;
                expect_comma(tokens, pos)?;
                let crit = parse_comparison(tokens, pos, env)?;
                pairs.push((cr, crit));
            }
            expect_rparen(tokens, pos)?;
            if pairs.is_empty() {
                return Err("SUMIFS 至少需要一组条件".into());
            }
            for (cr, _) in &pairs {
                ensure_same_table_ranges(&sum_range, cr, "SUMIFS")?;
            }
            let n = sum_range.nums.len();
            let mut total = 0.0;
            for i in 0..n {
                let ok = pairs.iter().all(|(cr, crit)| {
                    i < cr.texts.len() && criteria_matches(&cr.texts[i], cr.nums[i], crit)
                });
                if ok {
                    total += sum_range.nums[i];
                }
            }
            Ok(CalcValue::Num(total))
        }
        "COUNTIFS" => {
            let mut pairs = Vec::new();
            if matches!(tokens.get(*pos), Some(Tok::RParen)) {
                return Err("COUNTIFS 至少需要一组条件".into());
            }
            loop {
                let cr = parse_column_ref_arg(tokens, pos, env)?;
                expect_comma(tokens, pos)?;
                let crit = parse_comparison(tokens, pos, env)?;
                pairs.push((cr, crit));
                match tokens.get(*pos) {
                    Some(Tok::Comma) => *pos += 1,
                    Some(Tok::RParen) => {
                        *pos += 1;
                        break;
                    }
                    _ => return Err("COUNTIFS 参数格式错误".into()),
                }
            }
            for p in pairs.windows(2) {
                ensure_same_table_ranges(&p[0].0, &p[1].0, "COUNTIFS")?;
            }
            let n = pairs[0].0.texts.len();
            let mut count = 0.0;
            for i in 0..n {
                let ok = pairs.iter().all(|(cr, crit)| {
                    i < cr.texts.len() && criteria_matches(&cr.texts[i], cr.nums[i], crit)
                });
                if ok {
                    count += 1.0;
                }
            }
            Ok(CalcValue::Num(count))
        }
        other => Err(format!("内部错误：未处理的区域函数 {other}")),
    }
}

/// Excel serial date: days since 1899-12-30 (compatible with modern Excel for dates ≥ 1900-03-01).
fn excel_epoch() -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(1899, 12, 30).expect("epoch")
}

fn to_excel_serial(d: chrono::NaiveDate) -> f64 {
    (d - excel_epoch()).num_days() as f64
}

fn from_excel_serial(serial: f64) -> Result<chrono::NaiveDate, String> {
    let days = serial.floor() as i64;
    excel_epoch()
        .checked_add_signed(chrono::Duration::days(days))
        .ok_or_else(|| format!("无效日期序列号: {serial}"))
}

fn expect_args(name: &str, args: &[CalcValue], n: usize) -> Result<(), String> {
    if args.len() != n {
        Err(format!(
            "{name} 需要 {n} 个参数，实际 {got}",
            got = args.len()
        ))
    } else {
        Ok(())
    }
}

fn nums(args: &[CalcValue]) -> Result<Vec<f64>, String> {
    args.iter().map(|a| a.as_number()).collect()
}

fn eval_excel_fn(name: &str, args: &[CalcValue]) -> Result<CalcValue, String> {
    let upper = name.to_ascii_uppercase();
    match upper.as_str() {
        "TODAY" => {
            expect_args("TODAY", args, 0)?;
            Ok(CalcValue::Num(to_excel_serial(Local::now().date_naive())))
        }
        "NOW" => {
            expect_args("NOW", args, 0)?;
            let now = Local::now();
            let date = to_excel_serial(now.date_naive());
            let tod = now.time();
            let frac = (tod.num_seconds_from_midnight() as f64
                + f64::from(tod.nanosecond()) / 1e9)
                / 86_400.0;
            Ok(CalcValue::Num(date + frac))
        }
        "DATE" => {
            expect_args("DATE", args, 3)?;
            let n = nums(args)?;
            let y = n[0].trunc() as i32;
            let m = n[1].trunc() as u32;
            let d = n[2].trunc() as u32;
            let date = chrono::NaiveDate::from_ymd_opt(y, m, d)
                .ok_or_else(|| format!("DATE({y},{m},{d}) 不是有效日期"))?;
            Ok(CalcValue::Num(to_excel_serial(date)))
        }
        "YEAR" => {
            expect_args("YEAR", args, 1)?;
            Ok(CalcValue::Num(f64::from(
                from_excel_serial(args[0].as_number()?)?.year(),
            )))
        }
        "MONTH" => {
            expect_args("MONTH", args, 1)?;
            Ok(CalcValue::Num(f64::from(
                from_excel_serial(args[0].as_number()?)?.month(),
            )))
        }
        "DAY" => {
            expect_args("DAY", args, 1)?;
            Ok(CalcValue::Num(f64::from(
                from_excel_serial(args[0].as_number()?)?.day(),
            )))
        }
        "ABS" => {
            expect_args("ABS", args, 1)?;
            Ok(CalcValue::Num(args[0].as_number()?.abs()))
        }
        "INT" => {
            expect_args("INT", args, 1)?;
            Ok(CalcValue::Num(args[0].as_number()?.floor()))
        }
        "ROUND" => {
            if !(1..=2).contains(&args.len()) {
                return Err(format!("ROUND 需要 1～2 个参数，实际 {}", args.len()));
            }
            let n = args[0].as_number()?;
            let digits = args
                .get(1)
                .map(|a| a.as_number())
                .transpose()?
                .unwrap_or(0.0)
                .trunc() as i32;
            let factor = 10f64.powi(digits);
            Ok(CalcValue::Num((n * factor).round() / factor))
        }
        "MOD" => {
            expect_args("MOD", args, 2)?;
            let n = nums(args)?;
            if n[1] == 0.0 {
                return Ok(CalcValue::Num(0.0));
            }
            Ok(CalcValue::Num(n[0] % n[1]))
        }
        "POWER" => {
            expect_args("POWER", args, 2)?;
            let n = nums(args)?;
            Ok(CalcValue::Num(n[0].powf(n[1])))
        }
        "SQRT" => {
            expect_args("SQRT", args, 1)?;
            let n = args[0].as_number()?;
            if n < 0.0 {
                return Err("SQRT 不能对负数开方".into());
            }
            Ok(CalcValue::Num(n.sqrt()))
        }
        "MIN" => {
            if args.is_empty() {
                return Err("MIN 至少需要 1 个参数".into());
            }
            let n = nums(args)?;
            Ok(CalcValue::Num(n.into_iter().fold(f64::INFINITY, f64::min)))
        }
        "MAX" => {
            if args.is_empty() {
                return Err("MAX 至少需要 1 个参数".into());
            }
            let n = nums(args)?;
            Ok(CalcValue::Num(
                n.into_iter().fold(f64::NEG_INFINITY, f64::max),
            ))
        }
        "IF" => {
            expect_args("IF", args, 3)?;
            Ok(if args[0].is_truthy() {
                args[1].clone()
            } else {
                args[2].clone()
            })
        }
        "OR" => {
            if args.is_empty() {
                return Err("OR 至少需要 1 个参数".into());
            }
            Ok(CalcValue::Bool(args.iter().any(|a| a.is_truthy())))
        }
        "AND" => {
            if args.is_empty() {
                return Err("AND 至少需要 1 个参数".into());
            }
            Ok(CalcValue::Bool(args.iter().all(|a| a.is_truthy())))
        }
        "NOT" => {
            expect_args("NOT", args, 1)?;
            Ok(CalcValue::Bool(!args[0].is_truthy()))
        }
        "LEN" => {
            expect_args("LEN", args, 1)?;
            Ok(CalcValue::Num(args[0].as_text().chars().count() as f64))
        }
        "LEFT" => {
            if !(1..=2).contains(&args.len()) {
                return Err(format!("LEFT 需要 1～2 个参数，实际 {}", args.len()));
            }
            let s = args[0].as_text();
            let n = args
                .get(1)
                .map(|a| a.as_number())
                .transpose()?
                .unwrap_or(1.0)
                .max(0.0)
                .trunc() as usize;
            Ok(CalcValue::Str(s.chars().take(n).collect()))
        }
        "LEADINGDIGITS" => {
            expect_args("LEADINGDIGITS", args, 1)?;
            let s = args[0].as_text();
            let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            Ok(CalcValue::Str(digits))
        }
        // 从 1-based 起始位置起，截取连续 ASCII 字母/数字（遇 `;`、`-`、中文等即停）。
        "ALNUMFROM" => {
            expect_args("ALNUMFROM", args, 2)?;
            let s = args[0].as_text();
            let start = args[1].as_number()?.trunc() as i64;
            if start < 1 {
                return Ok(CalcValue::Str(String::new()));
            }
            let token: String = s
                .chars()
                .skip((start as usize) - 1)
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            Ok(CalcValue::Str(token))
        }
        "RIGHT" => {
            if !(1..=2).contains(&args.len()) {
                return Err(format!("RIGHT 需要 1～2 个参数，实际 {}", args.len()));
            }
            let s = args[0].as_text();
            let n = args
                .get(1)
                .map(|a| a.as_number())
                .transpose()?
                .unwrap_or(1.0)
                .max(0.0)
                .trunc() as usize;
            let chars: Vec<char> = s.chars().collect();
            let start = chars.len().saturating_sub(n);
            Ok(CalcValue::Str(chars[start..].iter().collect()))
        }
        "MID" => {
            expect_args("MID", args, 3)?;
            let s = args[0].as_text();
            let start = args[1].as_number()?.trunc() as i64;
            let n = args[2].as_number()?.max(0.0).trunc() as usize;
            if start < 1 {
                return Ok(CalcValue::Str(String::new()));
            }
            Ok(CalcValue::Str(
                s.chars()
                    .skip((start as usize) - 1)
                    .take(n)
                    .collect(),
            ))
        }
        "FIND" => {
            if !(2..=3).contains(&args.len()) {
                return Err(format!("FIND 需要 2～3 个参数，实际 {}", args.len()));
            }
            let needle = args[0].as_text();
            let hay = args[1].as_text();
            let start = args
                .get(2)
                .map(|a| a.as_number())
                .transpose()?
                .unwrap_or(1.0)
                .trunc() as i64;
            excel_find(&needle, &hay, start, true)
        }
        "SEARCH" => {
            if !(2..=3).contains(&args.len()) {
                return Err(format!("SEARCH 需要 2～3 个参数，实际 {}", args.len()));
            }
            let needle = args[0].as_text();
            let hay = args[1].as_text();
            let start = args
                .get(2)
                .map(|a| a.as_number())
                .transpose()?
                .unwrap_or(1.0)
                .trunc() as i64;
            excel_find(&needle, &hay, start, false)
        }
        "SUBSTITUTE" => {
            if !(3..=4).contains(&args.len()) {
                return Err(format!("SUBSTITUTE 需要 3～4 个参数，实际 {}", args.len()));
            }
            let text = args[0].as_text();
            let old = args[1].as_text();
            let new = args[2].as_text();
            if old.is_empty() {
                return Ok(CalcValue::Str(text));
            }
            if let Some(instance) = args.get(3) {
                let nth = instance.as_number()?.trunc() as i64;
                Ok(CalcValue::Str(substitute_nth(&text, &old, &new, nth)))
            } else {
                Ok(CalcValue::Str(text.replace(&old, &new)))
            }
        }
        "TRIM" => {
            expect_args("TRIM", args, 1)?;
            let s = args[0].as_text();
            Ok(CalcValue::Str(
                s.split_whitespace().collect::<Vec<_>>().join(" "),
            ))
        }
        "UPPER" => {
            expect_args("UPPER", args, 1)?;
            Ok(CalcValue::Str(args[0].as_text().to_uppercase()))
        }
        "LOWER" => {
            expect_args("LOWER", args, 1)?;
            Ok(CalcValue::Str(args[0].as_text().to_lowercase()))
        }
        "CONCAT" | "CONCATENATE" => {
            if args.is_empty() {
                return Err(format!("{upper} 至少需要 1 个参数"));
            }
            Ok(CalcValue::Str(
                args.iter().map(|a| a.as_concat_text()).collect::<String>(),
            ))
        }
        "ISNUMBER" => {
            expect_args("ISNUMBER", args, 1)?;
            Ok(CalcValue::Bool(matches!(args[0], CalcValue::Num(_))))
        }
        "ISTEXT" => {
            expect_args("ISTEXT", args, 1)?;
            Ok(CalcValue::Bool(matches!(args[0], CalcValue::Str(_))))
        }
        "SUMIF" | "COUNTIF" | "SUMIFS" | "COUNTIFS" => Err(format!(
            "{upper} 须写成 {upper}([表!条件列], 条件, …)"
        )),
        other => Err(format!(
            "暂不支持函数 {other}（可用 LEFT/MID/RIGHT/LEADINGDIGITS/ALNUMFROM/FIND/SEARCH/LEN/IFERROR/SUBSTITUTE/TRIM、SUMIF/COUNTIF、IF/OR/AND、日期函数等）"
        )),
    }
}

fn excel_find(needle: &str, haystack: &str, start: i64, case_sensitive: bool) -> Result<CalcValue, String> {
    if start < 1 {
        return Err("FIND/SEARCH 起始位置须 ≥ 1".into());
    }
    let start_idx = (start as usize) - 1;
    let chars: Vec<char> = haystack.chars().collect();
    if start_idx > chars.len() {
        return Err(format!("FIND/SEARCH 未找到「{needle}」"));
    }
    let slice: String = chars[start_idx..].iter().collect();
    let char_off = if case_sensitive {
        slice.find(needle).map(|byte_i| slice[..byte_i].chars().count())
    } else {
        let needle_l: Vec<char> = needle.to_lowercase().chars().collect();
        let slice_l: Vec<char> = slice.to_lowercase().chars().collect();
        if needle_l.is_empty() {
            Some(0)
        } else {
            slice_l
                .windows(needle_l.len())
                .position(|w| w == needle_l.as_slice())
        }
    };
    match char_off {
        Some(off) => Ok(CalcValue::Num((start_idx + off + 1) as f64)),
        None => Err(format!("FIND/SEARCH 未找到「{needle}」")),
    }
}

fn substitute_nth(text: &str, old: &str, new: &str, nth: i64) -> String {
    if nth <= 0 {
        return text.to_string();
    }
    let mut out = String::new();
    let mut rest = text;
    let mut seen = 0i64;
    while let Some(i) = rest.find(old) {
        seen += 1;
        out.push_str(&rest[..i]);
        if seen == nth {
            out.push_str(new);
            out.push_str(&rest[i + old.len()..]);
            return out;
        }
        out.push_str(old);
        rest = &rest[i + old.len()..];
    }
    out.push_str(rest);
    out
}

/// Legacy whole-table horizontal paste (kept for tests / older callers).
#[allow(dead_code)]
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

/// Place tables on a sheet grid. `cells` is row-major; empty `table_id` = vacant.
/// Each block keeps the source table's header_groups (same colors as source preview/export).
pub fn apply_side_by_side_layout(
    tables: &HashMap<String, &DataTable>,
    cells: &[crate::models::SideBlock],
    grid_rows: usize,
    grid_cols: usize,
    gap_cols: usize,
    gap_rows: usize,
) -> Result<DataTable, String> {
    let rows_n = grid_rows.max(1);
    let cols_n = grid_cols.max(1);
    let size = rows_n * cols_n;
    let mut slot_cells: Vec<crate::models::SideBlock> = cells.to_vec();
    while slot_cells.len() < size {
        slot_cells.push(crate::models::SideBlock {
            table_id: String::new(),
            columns: Vec::new(),
        });
    }

    struct BlockView {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
        groups: Vec<u32>,
        gr: usize,
        gc: usize,
    }

    let mut views: Vec<BlockView> = Vec::new();
    for (i, b) in slot_cells.iter().take(size).enumerate() {
        if b.table_id.trim().is_empty() {
            continue;
        }
        let gr = i / cols_n;
        let gc = i % cols_n;
        let table = tables
            .get(&b.table_id)
            .copied()
            .ok_or_else(|| format!("找不到表「{}」", b.table_id))?;
        let (headers, rows, groups) = if b.columns.is_empty() {
            let groups = if table.header_groups.len() == table.headers.len()
                && !table.header_groups.is_empty()
            {
                table.header_groups.clone()
            } else {
                vec![0u32; table.headers.len()]
            };
            (table.headers.clone(), table.rows.clone(), groups)
        } else {
            let mut idxs = Vec::new();
            let mut headers = Vec::new();
            let mut groups = Vec::new();
            for name in &b.columns {
                let idx = table.col_index(name)?;
                idxs.push(idx);
                headers.push(name.clone());
                groups.push(
                    table
                        .header_groups
                        .get(idx)
                        .copied()
                        .unwrap_or(0),
                );
            }
            let rows: Vec<Vec<String>> = table
                .rows
                .iter()
                .map(|row| {
                    idxs
                        .iter()
                        .map(|&i| row.get(i).cloned().unwrap_or_default())
                        .collect()
                })
                .collect();
            (headers, rows, groups)
        };
        if headers.is_empty() {
            return Err(format!("表「{}」没有可拼版的列", b.table_id));
        }
        views.push(BlockView {
            headers,
            rows,
            groups,
            gr,
            gc,
        });
    }

    if views.is_empty() {
        return Err("请在拼版格子中选择至少一张表".into());
    }

    let mut col_w = vec![0usize; cols_n];
    let mut row_h = vec![0usize; rows_n];
    for v in &views {
        let w = v.headers.len();
        let h = 1 + v.rows.len();
        col_w[v.gc] = col_w[v.gc].max(w);
        row_h[v.gr] = row_h[v.gr].max(h);
    }

    let positions: Vec<(usize, usize)> = views
        .iter()
        .map(|v| {
            let x = col_w.iter().take(v.gc).sum::<usize>() + v.gc * gap_cols;
            let y = row_h.iter().take(v.gr).sum::<usize>() + v.gr * gap_rows;
            (x, y)
        })
        .collect();

    let mut canvas_w = 0usize;
    let mut canvas_h = 0usize;
    for (i, v) in views.iter().enumerate() {
        let (x, y) = positions[i];
        canvas_w = canvas_w.max(x + v.headers.len());
        canvas_h = canvas_h.max(y + 1 + v.rows.len());
    }
    if canvas_w == 0 || canvas_h == 0 {
        return Err("拼版画布为空".into());
    }

    let mut canvas: Vec<Vec<String>> =
        vec![vec![String::new(); canvas_w]; canvas_h];
    let mut header_bands: Vec<crate::models::HeaderBand> = Vec::new();
    let mut top_groups = vec![0u32; canvas_w];
    let mut top_set = false;

    for (i, view) in views.iter().enumerate() {
        let (x0, y0) = positions[i];
        let bw = view.headers.len();
        for (c, h) in view.headers.iter().enumerate() {
            canvas[y0][x0 + c] = h.clone();
            if y0 == 0 {
                top_groups[x0 + c] = view.groups.get(c).copied().unwrap_or(0);
                top_set = true;
            }
        }
        header_bands.push(crate::models::HeaderBand {
            row: y0,
            col: x0,
            groups: view.groups.clone(),
        });
        for (r, row) in view.rows.iter().enumerate() {
            for c in 0..bw {
                let val = row.get(c).cloned().unwrap_or_default();
                canvas[y0 + 1 + r][x0 + c] = val;
            }
        }
    }

    let headers = canvas[0].clone();
    let rows = canvas[1..].to_vec();
    let header_groups = if top_set { top_groups } else { Vec::new() };

    Ok(DataTable {
        headers,
        rows,
        header_groups,
        plain_sheet: true,
        header_bands,
    })
}

/// Legacy helper: place a flat list of blocks in a 1×N or grid using arrange string.
pub fn apply_side_by_side_blocks(
    tables: &HashMap<String, &DataTable>,
    blocks: &[crate::models::SideBlock],
    arrange: &str,
    gap_cols: usize,
    gap_rows: usize,
    grid_columns: usize,
) -> Result<DataTable, String> {
    let filled: Vec<_> = blocks
        .iter()
        .filter(|b| !b.table_id.trim().is_empty())
        .cloned()
        .collect();
    if filled.is_empty() {
        return Err("请至少添加一张要拼版的表".into());
    }
    let arrange = arrange.trim().to_ascii_lowercase();
    let (grid_rows, grid_cols, cells) = match arrange.as_str() {
        "vertical" => (filled.len().max(1), 1usize, filled),
        "grid" => {
            let cols = grid_columns.max(1);
            let rows = (filled.len() + cols - 1) / cols;
            (rows.max(1), cols, filled)
        }
        _ => (1usize, filled.len().max(1), filled),
    };
    apply_side_by_side_layout(tables, &cells, grid_rows, grid_cols, gap_cols, gap_rows)
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
/// Merge legacy single-right fields into `lookups`.
pub fn resolve_vlookup_lookups(
    left_key: &str,
    right_table_id: &str,
    right_key: &str,
    right_columns: &[String],
    lookups: &[crate::models::VlookupRight],
) -> Vec<crate::models::VlookupRight> {
    if !lookups.is_empty() {
        return lookups.to_vec();
    }
    if right_table_id.trim().is_empty() {
        return Vec::new();
    }
    vec![crate::models::VlookupRight {
        table_id: right_table_id.to_string(),
        left_key: left_key.to_string(),
        right_key: right_key.to_string(),
        columns: right_columns.to_vec(),
    }]
}

/// Table A × multiple right tables: for each right, match keys and append columns.
/// `rights` items: (table, left_key, right_key, columns_to_append).
pub fn apply_vlookup_multi(
    left: &DataTable,
    left_columns: &[String],
    rights: &[(&DataTable, &str, &str, &[String])],
) -> Result<DataTable, String> {
    if rights.is_empty() {
        return Err("请至少添加一张查找表".into());
    }

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
    if left_cols.is_empty() {
        return Err("请至少选择表A的一列".into());
    }

    struct RightPlan {
        left_key_idx: usize,
        cols: Vec<(usize, String)>,
        by_text: HashMap<String, usize>,
        by_num: HashMap<String, usize>,
        rows: Vec<Vec<String>>,
    }

    let mut plans = Vec::with_capacity(rights.len());
    let mut headers: Vec<String> = left_cols.iter().map(|(_, h)| h.clone()).collect();
    let mut header_groups: Vec<u32> = vec![0; left_cols.len()];

    for (ri, (right, left_key, right_key, right_columns)) in rights.iter().enumerate() {
        if left_key.trim().is_empty() || right_key.trim().is_empty() {
            return Err(format!(
                "查找表 {}：请选择表A与该表的匹配列",
                ri + 1
            ));
        }
        let lk = left.col_index(left_key)?;
        let rk = right.col_index(right_key)?;
        let cols: Vec<(usize, String)> = if right_columns.is_empty() {
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
        let group = (ri + 1) as u32;
        for (_, h) in &cols {
            headers.push(unique_header(&headers, h, group));
            header_groups.push(group);
        }

        let mut by_text: HashMap<String, usize> = HashMap::new();
        let mut by_num: HashMap<String, usize> = HashMap::new();
        for (row_i, row) in right.rows.iter().enumerate() {
            let raw = row.get(rk).map(|s| s.as_str()).unwrap_or("");
            let text = raw.trim().to_string();
            if !text.is_empty() {
                by_text.entry(text).or_insert(row_i);
            }
            if let Some(n) = canonical_number_key(raw) {
                by_num.entry(n).or_insert(row_i);
            }
        }
        plans.push(RightPlan {
            left_key_idx: lk,
            cols,
            by_text,
            by_num,
            rows: right.rows.clone(),
        });
    }

    let mut rows = Vec::with_capacity(left.rows.len());
    for arow in &left.rows {
        let mut out = Vec::with_capacity(headers.len());
        for (idx, _) in &left_cols {
            out.push(arow.get(*idx).cloned().unwrap_or_default());
        }
        for plan in &plans {
            let raw = arow
                .get(plan.left_key_idx)
                .map(|s| s.as_str())
                .unwrap_or("");
            let matched_i = plan
                .by_text
                .get(raw.trim())
                .copied()
                .or_else(|| {
                    canonical_number_key(raw).and_then(|n| plan.by_num.get(&n).copied())
                });
            let matched = matched_i.and_then(|i| plan.rows.get(i));
            for (idx, _) in &plan.cols {
                out.push(
                    matched
                        .and_then(|brow| brow.get(*idx).cloned())
                        .unwrap_or_default(),
                );
            }
        }
        rows.push(out);
    }

    Ok(DataTable {
        headers,
        rows,
        header_groups,
        plain_sheet: false,
        header_bands: vec![],
    })
}

/// Full outer join: keep every A row and every B row (unmatched side filled blank).
/// 1:N matches expand rows; unused B rows are appended.
pub fn apply_full_join(
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
    if left_cols.is_empty() {
        return Err("请至少选择表A的一列".into());
    }
    let lk = left.col_index(left_key)?;
    let rk = right.col_index(right_key)?;
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

    let mut headers: Vec<String> = left_cols.iter().map(|(_, h)| h.clone()).collect();
    let mut header_groups: Vec<u32> = vec![0; left_cols.len()];
    for (_, h) in &right_cols {
        headers.push(unique_header(&headers, h, 1));
        header_groups.push(1);
    }

    // Map key → all B row indices
    let mut by_text: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_num: HashMap<String, Vec<usize>> = HashMap::new();
    for (row_i, row) in right.rows.iter().enumerate() {
        let raw = row.get(rk).map(|s| s.as_str()).unwrap_or("");
        let text = raw.trim().to_string();
        if !text.is_empty() {
            by_text.entry(text).or_default().push(row_i);
        }
        if let Some(n) = canonical_number_key(raw) {
            by_num.entry(n).or_default().push(row_i);
        }
    }

    let mut used_b = vec![false; right.rows.len()];
    let mut rows = Vec::new();

    for arow in &left.rows {
        let raw = arow.get(lk).map(|s| s.as_str()).unwrap_or("");
        let mut matches: Vec<usize> = Vec::new();
        let text = raw.trim();
        if !text.is_empty() {
            if let Some(v) = by_text.get(text) {
                matches.extend(v.iter().copied());
            }
        }
        if let Some(n) = canonical_number_key(raw) {
            if let Some(v) = by_num.get(&n) {
                for i in v {
                    if !matches.contains(i) {
                        matches.push(*i);
                    }
                }
            }
        }
        if matches.is_empty() {
            let mut out = Vec::with_capacity(headers.len());
            for (idx, _) in &left_cols {
                out.push(arow.get(*idx).cloned().unwrap_or_default());
            }
            for _ in &right_cols {
                out.push(String::new());
            }
            rows.push(out);
        } else {
            for bi in matches {
                used_b[bi] = true;
                let brow = &right.rows[bi];
                let mut out = Vec::with_capacity(headers.len());
                for (idx, _) in &left_cols {
                    out.push(arow.get(*idx).cloned().unwrap_or_default());
                }
                for (idx, _) in &right_cols {
                    out.push(brow.get(*idx).cloned().unwrap_or_default());
                }
                rows.push(out);
            }
        }
    }

    for (bi, used) in used_b.iter().enumerate() {
        if *used {
            continue;
        }
        let brow = &right.rows[bi];
        let mut out = Vec::with_capacity(headers.len());
        for _ in &left_cols {
            out.push(String::new());
        }
        for (idx, _) in &right_cols {
            out.push(brow.get(*idx).cloned().unwrap_or_default());
        }
        rows.push(out);
    }

    Ok(DataTable {
        headers,
        rows,
        header_groups,
        plain_sheet: false,
        header_bands: vec![],
    })
}

fn unique_header(existing: &[String], name: &str, group: u32) -> String {
    if !existing.iter().any(|h| h == name) {
        return name.to_string();
    }
    let letter = match group {
        1 => "B",
        2 => "C",
        3 => "D",
        4 => "E",
        5 => "F",
        _ => "X",
    };
    let candidate = format!("{name}_{letter}");
    if !existing.iter().any(|h| h == &candidate) {
        return candidate;
    }
    let mut n = 2usize;
    loop {
        let c = format!("{name}_{letter}{n}");
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
        plain_sheet: table.plain_sheet,
        header_bands: table.header_bands.clone(),
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
                    return Err("列数据去重的依据列不能为空".into());
                }
                table.col_index(c)
            })
            .collect::<Result<_, String>>()?
    };
    if idxs.is_empty() {
        return Err("表没有列，无法做列数据去重".into());
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
        plain_sheet: table.plain_sheet,
        header_bands: table.header_bands.clone(),
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

    fn eval_nums(expr: &str, nums: HashMap<String, f64>) -> CalcValue {
        let tables: HashMap<String, &DataTable> = HashMap::new();
        let texts: HashMap<String, String> = nums
            .iter()
            .map(|(k, v)| (k.clone(), format_number(*v)))
            .collect();
        let env = FormulaEnv {
            nums,
            texts,
            tables: &tables,
            base_id: "base",
        };
        eval_formula(expr, &env).unwrap()
    }

    fn eval_empty(expr: &str) -> CalcValue {
        eval_nums(expr, HashMap::new())
    }

    #[test]
    fn formula_subtract() {
        let mut nums = HashMap::new();
        nums.insert("a".into(), 1500.0);
        nums.insert("b".into(), 800.0);
        assert_eq!(eval_nums("[a]-[b]", nums), CalcValue::Num(700.0));
    }

    #[test]
    fn formula_coalesce_invoice_keeps_long_id() {
        let base = DataTable {
            headers: vec!["发票号码".into(), "数电发票号码".into()],
            rows: vec![
                vec!["".into(), "26322000007031773891".into()],
                vec!["12345".into(), "26322000007058503036".into()],
            ],
            ..Default::default()
        };
        let mut tables = HashMap::new();
        tables.insert("src:国税".into(), &base);
        let out = apply_calculate(
            &tables,
            "src:国税",
            &[CalcColumn {
                output_field: "唯一发票号".into(),
                formula: r#"=IF([发票号码]<>"",[发票号码],[数电发票号码])"#.into(),
            }],
            &[],
        )
        .unwrap();
        assert_eq!(out.rows[0].last().unwrap(), "26322000007031773891");
        assert_eq!(out.rows[1].last().unwrap(), "12345");
    }
    #[test]
    fn formula_excel_date_fns() {
        assert_eq!(
            eval_empty("YEAR(DATE(2024,6,15))"),
            CalcValue::Num(2024.0)
        );
        assert_eq!(
            eval_empty("MONTH(DATE(2024,6,15))"),
            CalcValue::Num(6.0)
        );
        assert_eq!(
            eval_empty("DAY(DATE(2024,6,15))"),
            CalcValue::Num(15.0)
        );
        let day_of_year = eval_empty("TODAY()-DATE(YEAR(TODAY()),1,1)+1")
            .as_number()
            .unwrap();
        assert!(
            (1.0..=366.0).contains(&day_of_year),
            "day_of_year={day_of_year}"
        );
        let mut nums = HashMap::new();
        nums.insert("src:学时7.30!合计".into(), 100.0);
        let annualized = eval_nums(
            "[src:学时7.30!合计]/(TODAY()-DATE(YEAR(TODAY()),1,1)+1)*365",
            nums,
        )
        .as_number()
        .unwrap();
        assert!(annualized.is_finite() && annualized > 0.0);
    }

    #[test]
    fn formula_math_fns() {
        assert_eq!(eval_empty("ABS(-3.5)"), CalcValue::Num(3.5));
        assert_eq!(eval_empty("ROUND(1.234,2)"), CalcValue::Num(1.23));
        // 加减乘除：操作数先收成 2 位再算
        assert_eq!(eval_empty("1.006+1.004"), CalcValue::Num(2.01)); // 1.01+1.00
        assert_eq!(eval_empty("10.006*2"), CalcValue::Num(20.02)); // 10.01*2
        assert_eq!(eval_empty("POWER(2,3)"), CalcValue::Num(8.0));
        assert_eq!(eval_empty("2^3"), CalcValue::Num(8.0));
        assert_eq!(eval_empty("IF(1,10,20)"), CalcValue::Num(10.0));
        assert_eq!(eval_empty("IF(0,10,20)"), CalcValue::Num(20.0));
    }

    fn eval_texts(expr: &str, texts: HashMap<String, String>) -> CalcValue {
        let tables: HashMap<String, &DataTable> = HashMap::new();
        let nums: HashMap<String, f64> = texts
            .iter()
            .filter_map(|(k, v)| parse_number_opt(v).map(|n| (k.clone(), n)))
            .collect();
        let env = FormulaEnv {
            nums,
            texts,
            tables: &tables,
            base_id: "base",
        };
        eval_formula(expr, &env).unwrap()
    }

    #[test]
    fn formula_text_fns_basic() {
        assert_eq!(eval_empty(r#"LEFT("abcdef",2)"#), CalcValue::Str("ab".into()));
        assert_eq!(eval_empty(r#"RIGHT("abcdef",3)"#), CalcValue::Str("def".into()));
        assert_eq!(eval_empty(r#"MID("abcdef",2,3)"#), CalcValue::Str("bcd".into()));
        assert_eq!(eval_empty(r#"LEN("你好")"#), CalcValue::Num(2.0));
        assert_eq!(eval_empty(r#"FIND("-","a-b-c")"#), CalcValue::Num(2.0));
        assert_eq!(eval_empty(r#"SEARCH("B","abc")"#), CalcValue::Num(2.0));
        assert_eq!(
            eval_empty(r#"SUBSTITUTE("a-b-c","-","")"#),
            CalcValue::Str("abc".into())
        );
        assert_eq!(
            eval_empty(r#""A"&"-"&"B""#),
            CalcValue::Str("A-B".into())
        );
        assert_eq!(
            eval_empty(r#"12.5&"_"&3"#),
            CalcValue::Str("12.50_3.00".into())
        );
        assert_eq!(
            eval_empty(r#"CONCAT(1.2,"_",3)"#),
            CalcValue::Str("1.20_3.00".into())
        );
        // 单元格里无小数点的工号/单号按原文拼接，不变成 xxx.00
        let mut cells = HashMap::new();
        cells.insert("工号".into(), "26070006".into());
        cells.insert("保费".into(), "12.5".into());
        assert_eq!(
            eval_texts(r#"[工号]&"_"&[保费]"#, cells),
            CalcValue::Str("26070006_12.50".into())
        );
        assert_eq!(
            eval_empty(r#"IFERROR(FIND("x","abc"),0)"#),
            CalcValue::Num(0.0)
        );
    }

    #[test]
    fn formula_extract_voucher_codes() {
        // BZ… → GD… → 开头连续数字（遇 a / - / 中文停止）
        let expr = r#"IFERROR(ALNUMFROM([备注],FIND("BZ",[备注])),IFERROR(ALNUMFROM([备注],FIND("GD",[备注])),LEADINGDIGITS([备注])))"#;

        let cases = [
            (
                "南通中支报销防灾防损费-BZ20304202608000023;RZ2030426081400000011",
                "BZ20304202608000023",
            ),
            (
                "26080857转入2026-08-21联共保抵扣和进项税调整;GD20300202609000002",
                "GD20300202609000002",
            ),
            (
                "联共保抵扣和进项税调整;GD20300202609000002",
                "GD20300202609000002",
            ),
            ("26070006a1-转入2026-07-01手续费", "26070006"),
            (
                "王春报销其他应付款-租赁付款额-房屋租赁-99999B0300201-BZ20308202607000038;RZ2030826072200000007",
                "BZ20308202607000038",
            ),
        ];
        for (raw, want) in cases {
            let mut texts = HashMap::new();
            texts.insert("备注".into(), raw.into());
            assert_eq!(
                eval_texts(expr, texts),
                CalcValue::Str(want.into()),
                "raw={raw}"
            );
        }
    }

    #[test]
    fn formula_if_or_compare_strings() {
        let mut nums = HashMap::new();
        nums.insert(
            "tmp:c872cb82!个人回滚12个月车险及个非年化实收保费".into(),
            6.0,
        );
        nums.insert(
            "tmp:c872cb82!个人回滚12个月团非年化实收保费".into(),
            1.0,
        );
        let expr = r#"IF(OR([tmp:c872cb82!个人回滚12个月车险及个非年化实收保费]>=5,[tmp:c872cb82!个人回滚12个月团非年化实收保费]>=5),"符合","不符合")"#;
        assert_eq!(eval_nums(expr, nums.clone()), CalcValue::Str("符合".into()));

        nums.insert(
            "tmp:c872cb82!个人回滚12个月车险及个非年化实收保费".into(),
            3.0,
        );
        assert_eq!(eval_nums(expr, nums), CalcValue::Str("不符合".into()));

        assert_eq!(eval_empty(r#"AND(1>=1,0)"#), CalcValue::Bool(false));
        assert_eq!(eval_empty(r#"NOT(0)"#), CalcValue::Bool(true));
    }

    #[test]
    fn formula_sumif_like_excel() {
        // =SUMIF('寿险'!条件列, 当前行C, '寿险'!求和列)
        let life = DataTable {
            headers: vec!["保费".into(), "代码".into()],
            rows: vec![
                vec!["10".into(), "A".into()],
                vec!["20".into(), "B".into()],
                vec!["5".into(), "A".into()],
                vec!["7".into(), "C".into()],
            ],
            ..Default::default()
        };
        let base = DataTable {
            headers: vec!["代码".into()],
            rows: vec![vec!["A".into()], vec!["B".into()], vec!["Z".into()]],
            ..Default::default()
        };
        let mut tables = HashMap::new();
        tables.insert("src:寿险-7.29".into(), &life);
        tables.insert("tmp:base".into(), &base);
        let out = apply_calculate(
            &tables,
            "tmp:base",
            &[CalcColumn {
                output_field: "汇总".into(),
                formula: "=SUMIF([src:寿险-7.29!代码],[代码],[src:寿险-7.29!保费])".into(),
            }],
            &[],
        )
        .unwrap();
        assert_eq!(out.rows[0].last().unwrap(), "15"); // 10+5
        assert_eq!(out.rows[1].last().unwrap(), "20");
        assert_eq!(out.rows[2].last().unwrap(), "0");
    }

    #[test]
    fn formula_sumif_matches_numeric_ids() {
        let life = DataTable {
            headers: vec!["原工号".into(), "保费".into()],
            rows: vec![
                vec!["001".into(), "10".into()],
                vec!["1".into(), "5".into()],
                vec!["2".into(), "20".into()],
            ],
            ..Default::default()
        };
        let base = DataTable {
            headers: vec!["销售人员代码".into()],
            rows: vec![vec!["1".into()], vec!["2.0".into()]],
            ..Default::default()
        };
        let mut tables = HashMap::new();
        tables.insert("src:寿险-7.29".into(), &life);
        tables.insert("tmp:sales".into(), &base);
        let out = apply_calculate(
            &tables,
            "tmp:sales",
            &[CalcColumn {
                output_field: "汇总".into(),
                formula: "=SUMIF([src:寿险-7.29!原工号],[销售人员代码],[src:寿险-7.29!保费])"
                    .into(),
            }],
            &[],
        )
        .unwrap();
        // 001 and 1 both match key "1" → 10+5
        assert_eq!(out.rows[0].last().unwrap(), "15");
        assert_eq!(out.rows[1].last().unwrap(), "20");
    }

    #[test]
    fn formula_sumif_rejects_cross_table_ranges() {
        let life = DataTable {
            headers: vec!["原工号".into(), "保费".into()],
            rows: vec![vec!["A".into(), "10".into()]],
            ..Default::default()
        };
        let base = DataTable {
            headers: vec!["销售人员代码".into(), "新单标保".into()],
            rows: vec![vec!["A".into(), "99".into()]],
            ..Default::default()
        };
        let mut tables = HashMap::new();
        tables.insert("src:寿险-7.29".into(), &life);
        tables.insert("tmp:1aa0d98f".into(), &base);
        let err = apply_calculate(
            &tables,
            "tmp:1aa0d98f",
            &[CalcColumn {
                output_field: "汇总".into(),
                formula: "=SUMIF([src:寿险-7.29!原工号],[销售人员代码],[tmp:1aa0d98f!新单标保])"
                    .into(),
            }],
            &[],
        )
        .unwrap_err();
        assert!(err.contains("必须来自同一张表"), "{err}");
    }

    #[test]
    fn apply_calculate_multi_columns() {
        let base = DataTable {
            headers: vec!["代码".into(), "保费".into()],
            rows: vec![vec!["A".into(), "10".into()], vec!["B".into(), "3".into()]],
            ..Default::default()
        };
        let mut tables = HashMap::new();
        tables.insert("tmp:b".into(), &base);
        let out = apply_calculate(
            &tables,
            "tmp:b",
            &[
                CalcColumn {
                    output_field: "翻倍".into(),
                    formula: "=[保费]*2".into(),
                },
                CalcColumn {
                    output_field: "标签".into(),
                    formula: r#"=IF([翻倍]>=10,"高","低")"#.into(),
                },
            ],
            &[],
        )
        .unwrap();
        assert_eq!(out.headers, vec!["代码", "保费", "翻倍", "标签"]);
        assert_eq!(out.rows[0], vec!["A", "10", "20", "高"]);
        assert_eq!(out.rows[1], vec!["B", "3", "6", "低"]);
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
        let out = apply_vlookup_multi(
            &left,
            &[],
            &[(&right, "代码", "工号", &[] as &[String])],
        )
        .unwrap();
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
    fn full_join_keeps_both_sides() {
        let left = DataTable {
            headers: vec!["代码".into(), "姓名".into()],
            rows: vec![
                vec!["1".into(), "甲".into()],
                vec!["2".into(), "乙".into()],
            ],
            ..Default::default()
        };
        let right = DataTable {
            headers: vec!["工号".into(), "保费".into()],
            rows: vec![
                vec!["2".into(), "200".into()],
                vec!["3".into(), "300".into()],
            ],
            ..Default::default()
        };
        let out = apply_full_join(&left, &right, "代码", "工号", &[], &[]).unwrap();
        assert_eq!(out.headers, vec!["代码", "姓名", "工号", "保费"]);
        assert_eq!(out.rows.len(), 3);
        assert_eq!(out.rows[0], vec!["1", "甲", "", ""]);
        assert_eq!(out.rows[1], vec!["2", "乙", "2", "200"]);
        assert_eq!(out.rows[2], vec!["", "", "3", "300"]);
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
        let out = apply_vlookup_multi(
            &left,
            &["代码".into(), "名称".into()],
            &[(
                &right,
                "代码",
                "代码",
                &["名称".into(), "保费".into()] as &[String],
            )],
        )
        .unwrap();
        assert_eq!(out.headers, vec!["代码", "名称", "名称_B", "保费"]);
        assert_eq!(out.rows[0], vec!["A1", "甲", "乙", "10"]);
    }

    #[test]
    fn vlookup_multi_tables() {
        let left = DataTable {
            headers: vec!["代码".into(), "姓名".into()],
            rows: vec![
                vec!["1".into(), "张三".into()],
                vec!["2".into(), "李四".into()],
            ],
            ..Default::default()
        };
        let right_b = DataTable {
            headers: vec!["工号".into(), "保费".into()],
            rows: vec![
                vec!["1".into(), "100".into()],
                vec!["2".into(), "200".into()],
            ],
            ..Default::default()
        };
        let right_c = DataTable {
            headers: vec!["人员代码".into(), "机构".into()],
            rows: vec![
                vec!["1".into(), "南京".into()],
                vec!["9".into(), "苏州".into()],
            ],
            ..Default::default()
        };
        let out = apply_vlookup_multi(
            &left,
            &[],
            &[
                (&right_b, "代码", "工号", &[] as &[String]),
                (&right_c, "代码", "人员代码", &["机构".into()]),
            ],
        )
        .unwrap();
        assert_eq!(
            out.headers,
            vec!["代码", "姓名", "工号", "保费", "机构"]
        );
        assert_eq!(out.header_groups, vec![0, 0, 1, 1, 2]);
        assert_eq!(out.rows[0], vec!["1", "张三", "1", "100", "南京"]);
        assert_eq!(out.rows[1], vec!["2", "李四", "2", "200", ""]);
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

    #[test]
    fn side_layout_horizontal_gap_and_vertical() {
        let a = DataTable {
            headers: vec!["A1".into(), "A2".into()],
            rows: vec![vec!["1".into(), "2".into()]],
            ..Default::default()
        };
        let b = DataTable {
            headers: vec!["B1".into()],
            rows: vec![vec!["x".into()], vec!["y".into()]],
            ..Default::default()
        };
        let mut map = HashMap::new();
        map.insert("a".into(), &a);
        map.insert("b".into(), &b);
        let blocks = vec![
            crate::models::SideBlock {
                table_id: "a".into(),
                columns: vec![],
            },
            crate::models::SideBlock {
                table_id: "b".into(),
                columns: vec![],
            },
        ];
        let h = apply_side_by_side_layout(&map, &blocks, 1, 2, 1, 1).unwrap();
        assert!(h.plain_sheet);
        // A1 A2 _ B1
        assert_eq!(h.headers, vec!["A1", "A2", "", "B1"]);
        assert_eq!(h.rows.len(), 2); // max body rows
        assert_eq!(h.rows[0][0], "1");
        assert_eq!(h.rows[0][3], "x");
        assert_eq!(h.rows[1][3], "y");
        assert_eq!(h.header_bands.len(), 2);

        let v = apply_side_by_side_layout(&map, &blocks, 2, 1, 1, 1).unwrap();
        // row0 headers A; body a; gap; headers B; body b...
        assert_eq!(v.headers, vec!["A1", "A2"]);
        // rows: a data, gap, B header, b data x, b data y
        assert_eq!(v.rows.len(), 5);
        assert_eq!(v.rows[0], vec!["1", "2"]);
        assert_eq!(v.rows[1], vec!["", ""]);
        assert_eq!(v.rows[2][0], "B1");
        assert_eq!(v.rows[3][0], "x");
        assert_eq!(v.rows[4][0], "y");
        assert_eq!(v.header_bands.len(), 2);
    }
}
