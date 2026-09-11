use crate::models::{SourceMatcher, SourceTable};
use std::collections::HashSet;

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

fn score_keyword(table: &SourceTable, keyword: &str) -> i32 {
    let kw = norm(keyword);
    if kw.is_empty() {
        return 0;
    }
    let name = norm(&table.name);
    let path = norm(&table.path);
    if name == kw {
        return 1000;
    }
    if name.contains(&kw) {
        return 500 + (kw.chars().count().min(100) as i32);
    }
    if path.contains(&kw) {
        return 200 + (kw.chars().count().min(100) as i32);
    }
    0
}

/// Bind stable matcher ids to scanned tables by fuzzy keyword on name/path.
pub fn apply_source_matchers(
    scanned: &[SourceTable],
    matchers: &[SourceMatcher],
) -> Vec<SourceTable> {
    let mut list: Vec<&SourceMatcher> = matchers
        .iter()
        .filter(|m| !m.keyword.trim().is_empty() && !m.id.trim().is_empty())
        .collect();
    if list.is_empty() {
        return scanned.to_vec();
    }
    list.sort_by(|a, b| {
        b.keyword
            .trim()
            .chars()
            .count()
            .cmp(&a.keyword.trim().chars().count())
    });

    let mut claimed_ids: HashSet<String> = HashSet::new();
    let mut claimed_paths: HashSet<String> = HashSet::new();
    let mut bound: Vec<SourceTable> = Vec::new();

    for m in list {
        let kw = m.keyword.trim();
        let mut best: Option<&SourceTable> = None;
        let mut best_score = 0;
        for t in scanned {
            if claimed_ids.contains(&t.id) || claimed_paths.contains(&t.path) {
                continue;
            }
            let score = score_keyword(t, kw);
            if score > best_score {
                best_score = score;
                best = Some(t);
            }
        }
        if let Some(hit) = best.filter(|_| best_score > 0) {
            claimed_ids.insert(hit.id.clone());
            claimed_paths.insert(hit.path.clone());
            let display = {
                let label = m.label.trim();
                if !label.is_empty() {
                    label.to_string()
                } else {
                    kw.to_string()
                }
            };
            let mut aliased = hit.clone();
            aliased.id = m.id.clone();
            aliased.name = display;
            aliased.matched_name = hit.name.clone();
            aliased.match_keyword = kw.to_string();
            bound.push(aliased);
        } else {
            let display = {
                let label = m.label.trim();
                if !label.is_empty() {
                    label.to_string()
                } else {
                    kw.to_string()
                }
            };
            bound.push(SourceTable {
                id: m.id.clone(),
                name: display,
                path: String::new(),
                headers: vec![],
                row_count: 0,
                header_row: 1,
                header_ok: false,
                header_message: format!("未匹配到名称含「{kw}」的源表/文件夹"),
                kind: "file".into(),
                file_count: 0,
                sample_path: String::new(),
                matched_name: String::new(),
                match_keyword: kw.to_string(),
            });
        }
    }

    let leftovers: Vec<SourceTable> = scanned
        .iter()
        .filter(|t| !claimed_ids.contains(&t.id) && !claimed_paths.contains(&t.path))
        .cloned()
        .collect();
    bound.extend(leftovers);
    bound
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(id: &str, name: &str) -> SourceTable {
        SourceTable {
            id: id.into(),
            name: name.into(),
            path: format!("/data/{name}.xlsx"),
            headers: vec!["a".into()],
            row_count: 1,
            header_row: 1,
            header_ok: true,
            header_message: String::new(),
            kind: "file".into(),
            file_count: 0,
            sample_path: String::new(),
            matched_name: String::new(),
            match_keyword: String::new(),
        }
    }

    #[test]
    fn fuzzy_binds_renamed_file() {
        let scanned = vec![table("src:人员清单_202603", "人员清单_202603")];
        let matchers = vec![SourceMatcher {
            id: "src:人员清单".into(),
            keyword: "人员清单".into(),
            label: "人员清单".into(),
        }];
        let out = apply_source_matchers(&scanned, &matchers);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "src:人员清单");
        assert_eq!(out[0].matched_name, "人员清单_202603");
        assert!(out[0].path.contains("人员清单_202603"));
    }

    #[test]
    fn longer_keyword_wins() {
        let scanned = vec![
            table("src:赔付", "赔付"),
            table("src:赔付支出明细", "赔付支出明细"),
        ];
        let matchers = vec![
            SourceMatcher {
                id: "src:a".into(),
                keyword: "赔付".into(),
                label: String::new(),
            },
            SourceMatcher {
                id: "src:b".into(),
                keyword: "赔付支出明细".into(),
                label: String::new(),
            },
        ];
        let out = apply_source_matchers(&scanned, &matchers);
        let b = out.iter().find(|t| t.id == "src:b").unwrap();
        assert_eq!(b.matched_name, "赔付支出明细");
        let a = out.iter().find(|t| t.id == "src:a").unwrap();
        assert_eq!(a.matched_name, "赔付");
    }
}
