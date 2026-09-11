use crate::models::{Operation, Pipeline, PromptField};
use std::collections::{HashMap, HashSet};

/// Replace `${key}` placeholders. Must preserve UTF-8 (do not walk raw bytes as chars).
fn substitute(text: &str, values: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let key = after[..end].trim();
            if let Some(v) = values.get(key) {
                out.push_str(v);
            } else {
                out.push_str(&rest[start..start + 2 + end + 1]);
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn apply_op(op: &Operation, values: &HashMap<String, String>) -> Operation {
    match op {
        Operation::Filter {
            input_table_id,
            conditions,
            match_mode,
        } => Operation::Filter {
            input_table_id: input_table_id.clone(),
            match_mode: match_mode.clone(),
            conditions: conditions
                .iter()
                .map(|c| crate::models::FilterCondition {
                    column: c.column.clone(),
                    op: c.op.clone(),
                    value: substitute(&c.value, values),
                    join: c.join.clone(),
                })
                .collect(),
        },
        Operation::Calculate {
            base_table_id,
            output_field,
            formula,
            columns,
            joins,
        } => Operation::Calculate {
            base_table_id: base_table_id.clone(),
            output_field: output_field.clone(),
            formula: substitute(formula, values),
            columns: columns
                .iter()
                .map(|c| crate::models::CalcColumn {
                    output_field: substitute(&c.output_field, values),
                    formula: substitute(&c.formula, values),
                })
                .collect(),
            joins: joins.clone(),
        },
        other => other.clone(),
    }
}

/// Replace `${key}` in filter/calc fields. Does not mutate prompt_fields definitions.
pub fn apply_runtime_params(
    mut pipeline: Pipeline,
    values: &HashMap<String, String>,
) -> Pipeline {
    if values.is_empty() {
        return pipeline;
    }
    for step in &mut pipeline.steps {
        step.operation = apply_op(&step.operation, values);
    }
    pipeline
}

fn extract_keys_from_text(text: &str, into: &mut HashSet<String>) {
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let key = after[..end].trim();
            if !key.is_empty() {
                into.insert(key.to_string());
            }
            rest = &after[end + 1..];
        } else {
            break;
        }
    }
}

fn collect_keys_from_op(op: &Operation, into: &mut HashSet<String>) {
    match op {
        Operation::Filter { conditions, .. } => {
            for c in conditions {
                extract_keys_from_text(&c.value, into);
            }
        }
        Operation::Calculate {
            formula, columns, ..
        } => {
            extract_keys_from_text(formula, into);
            for c in columns {
                extract_keys_from_text(&c.output_field, into);
                extract_keys_from_text(&c.formula, into);
            }
        }
        _ => {}
    }
}

/// Merge declared prompt_fields with keys found in steps.
pub fn collect_prompt_fields(pipeline: &Pipeline) -> Vec<PromptField> {
    let mut by_key: HashMap<String, PromptField> = HashMap::new();
    for f in &pipeline.prompt_fields {
        let key = f.key.trim();
        if key.is_empty() {
            continue;
        }
        by_key.insert(
            key.to_string(),
            PromptField {
                key: key.to_string(),
                label: if f.label.trim().is_empty() {
                    key.to_string()
                } else {
                    f.label.clone()
                },
                default_value: f.default_value.clone(),
                required: f.required,
            },
        );
    }
    let mut found = HashSet::new();
    for step in &pipeline.steps {
        collect_keys_from_op(&step.operation, &mut found);
    }
    for key in found {
        by_key.entry(key.clone()).or_insert(PromptField {
            key: key.clone(),
            label: key,
            default_value: String::new(),
            required: true,
        });
    }
    let mut out: Vec<_> = by_key.into_values().collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

pub fn validate_runtime_params(
    fields: &[PromptField],
    values: &HashMap<String, String>,
) -> Result<(), String> {
    for f in fields {
        if !f.required {
            continue;
        }
        let v = values.get(&f.key).map(|s| s.trim()).unwrap_or("");
        if v.is_empty() {
            let label = if f.label.trim().is_empty() {
                &f.key
            } else {
                &f.label
            };
            return Err(format!("请填写「{label}」"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::FilterCondition;

    #[test]
    fn substitutes_filter_value() {
        let mut values = HashMap::new();
        values.insert("月份".into(), "2026-03".into());
        let op = Operation::Filter {
            input_table_id: "src:a".into(),
            match_mode: "and".into(),
            conditions: vec![FilterCondition {
                column: "月份".into(),
                op: "eq".into(),
                value: "${月份}".into(),
                join: "and".into(),
            }],
        };
        let next = apply_op(&op, &values);
        if let Operation::Filter { conditions, .. } = next {
            assert_eq!(conditions[0].value, "2026-03");
        } else {
            panic!("expected filter");
        }
    }

    #[test]
    fn substitute_preserves_chinese_outside_placeholders() {
        let mut values = HashMap::new();
        values.insert("month".into(), "2026-08".into());
        let formula = r#"=IF([发票号码]<>"",[发票号码],[数电发票号码])"#;
        assert_eq!(substitute(formula, &values), formula);
        let mixed = r#"=IF([进项税凭证号]<>"${month}",[发票号码],"x")"#;
        assert_eq!(
            substitute(mixed, &values),
            r#"=IF([进项税凭证号]<>"2026-08",[发票号码],"x")"#
        );
    }
}
