import type { Operation, Pipeline, PromptField, Step } from "./types";

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

/** Flowchart node id for an execution prompt field. */
export const PROMPT_FIELD_NODE_PREFIX = "prompt:";

export function promptFieldNodeId(key: string): string {
  return `${PROMPT_FIELD_NODE_PREFIX}${key.trim()}`;
}

export function parsePromptFieldNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith(PROMPT_FIELD_NODE_PREFIX)) return null;
  const key = nodeId.slice(PROMPT_FIELD_NODE_PREFIX.length).trim();
  return key || null;
}

export function isPromptFieldNodeId(nodeId: string): boolean {
  return parsePromptFieldNodeId(nodeId) != null;
}

export function promptPlaceholder(key: string): string {
  return `\${${key.trim()}}`;
}

/** Collect `${key}` tokens from a string. */
export function extractPlaceholderKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text))) {
    const k = m[1].trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

function walkOpStrings(op: Operation, visit: (s: string) => void) {
  switch (op.type) {
    case "filter":
      for (const c of op.conditions ?? []) visit(c.value ?? "");
      break;
    case "calculate":
      for (const c of op.columns ?? []) {
        visit(c.formula ?? "");
        visit(c.outputField ?? "");
      }
      if (op.formula) visit(op.formula);
      break;
    default:
      break;
  }
}

/** Prompt field keys referenced by a step (`${key}` in filter/calc). */
export function stepPromptFieldKeys(op: Operation): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  walkOpStrings(op, (text) => {
    for (const key of extractPlaceholderKeys(text)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  });
  return keys;
}

function stripKeyFromText(text: string, key: string): string {
  const token = promptPlaceholder(key);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(escaped, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Insert `${key}` into a filter/calculate step if not already present. */
export function applyPromptFieldLink(op: Operation, key: string): Operation {
  const k = key.trim();
  if (!k) return op;
  if (stepPromptFieldKeys(op).includes(k)) return op;
  const token = promptPlaceholder(k);
  switch (op.type) {
    case "filter": {
      const conditions = [...(op.conditions ?? [])];
      const emptyIdx = conditions.findIndex((c) => !(c.value ?? "").trim());
      if (emptyIdx >= 0) {
        conditions[emptyIdx] = { ...conditions[emptyIdx], value: token };
      } else if (conditions.length > 0) {
        const cur = conditions[0].value ?? "";
        conditions[0] = {
          ...conditions[0],
          value: cur ? `${cur}${token}` : token,
        };
      } else {
        conditions.push({
          column: "",
          op: "contains",
          value: token,
          join: "and",
        });
      }
      return { ...op, conditions };
    }
    case "calculate": {
      const columns = [...(op.columns ?? [])];
      if (columns.length === 0) {
        return {
          ...op,
          columns: [{ outputField: "计算结果", formula: `=${token}` }],
        };
      }
      const formula = columns[0].formula?.trim() || "=";
      columns[0] = {
        ...columns[0],
        formula: formula === "=" ? `=${token}` : `${formula}${token}`,
      };
      return { ...op, columns };
    }
    default:
      return op;
  }
}

/** Remove `${key}` placeholders from a step operation. */
export function applyPromptFieldUnlink(op: Operation, key: string): Operation {
  const k = key.trim();
  if (!k) return op;
  switch (op.type) {
    case "filter":
      return {
        ...op,
        conditions: (op.conditions ?? []).map((c) => ({
          ...c,
          value: stripKeyFromText(c.value ?? "", k),
        })),
      };
    case "calculate":
      return {
        ...op,
        columns: (op.columns ?? []).map((c) => ({
          ...c,
          outputField: stripKeyFromText(c.outputField ?? "", k),
          formula: stripKeyFromText(c.formula ?? "", k) || "=",
        })),
        formula: op.formula ? stripKeyFromText(op.formula, k) : op.formula,
      };
    default:
      return op;
  }
}

/** Keys declared in promptFields plus any `${…}` used in steps. */
export function collectRuntimePromptFields(pipeline: Pipeline): PromptField[] {
  const byKey = new Map<string, PromptField>();
  for (const f of pipeline.promptFields ?? []) {
    const key = f.key?.trim();
    if (!key) continue;
    byKey.set(key, {
      key,
      label: f.label?.trim() || key,
      defaultValue: f.defaultValue ?? "",
      required: f.required !== false,
    });
  }
  for (const step of pipeline.steps) {
    for (const key of stepPromptFieldKeys(step.operation)) {
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          label: key,
          defaultValue: "",
          required: true,
        });
      }
    }
  }
  return [...byKey.values()];
}

/** Persist discovered `${key}` usages into pipeline.promptFields (keep declared metadata). */
export function syncPromptFieldsFromSteps(pipeline: Pipeline): Pipeline {
  const next = collectRuntimePromptFields(pipeline);
  const prev = pipeline.promptFields ?? [];
  if (
    prev.length === next.length &&
    prev.every(
      (f, i) =>
        f.key === next[i].key &&
        (f.label ?? "") === (next[i].label ?? "") &&
        (f.defaultValue ?? "") === (next[i].defaultValue ?? "") &&
        (f.required !== false) === (next[i].required !== false),
    )
  ) {
    return pipeline;
  }
  return { ...pipeline, promptFields: next };
}

/** Rename `${oldKey}` → `${newKey}` inside a step operation. */
export function renamePromptKeyInOp(
  op: Operation,
  oldKey: string,
  newKey: string,
): Operation {
  const from = oldKey.trim();
  const to = newKey.trim();
  if (!from || !to || from === to) return op;
  const fromTok = promptPlaceholder(from);
  const toTok = promptPlaceholder(to);
  const repl = (s: string) => s.split(fromTok).join(toTok);
  switch (op.type) {
    case "filter":
      return {
        ...op,
        conditions: (op.conditions ?? []).map((c) => ({
          ...c,
          value: repl(c.value ?? ""),
        })),
      };
    case "calculate":
      return {
        ...op,
        columns: (op.columns ?? []).map((c) => ({
          ...c,
          outputField: repl(c.outputField ?? ""),
          formula: repl(c.formula ?? ""),
        })),
        formula: op.formula ? repl(op.formula) : op.formula,
      };
    default:
      return op;
  }
}

export function substitutePlaceholders(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(PLACEHOLDER_RE, (_, raw: string) => {
    const key = String(raw).trim();
    return key in values ? values[key] : `\${${key}}`;
  });
}

function applyOpParams(op: Operation, values: Record<string, string>): Operation {
  switch (op.type) {
    case "filter":
      return {
        ...op,
        conditions: (op.conditions ?? []).map((c) => ({
          ...c,
          value: substitutePlaceholders(c.value ?? "", values),
        })),
      };
    case "calculate":
      return {
        ...op,
        columns: (op.columns ?? []).map((c) => ({
          ...c,
          outputField: substitutePlaceholders(c.outputField ?? "", values),
          formula: substitutePlaceholders(c.formula ?? "", values),
        })),
        formula: op.formula
          ? substitutePlaceholders(op.formula, values)
          : op.formula,
      };
    default:
      return op;
  }
}

/** Deep-clone pipeline with placeholders replaced (does not mutate original). */
export function applyRuntimeParams(
  pipeline: Pipeline,
  values: Record<string, string>,
): Pipeline {
  const steps: Step[] = pipeline.steps.map((s) => ({
    ...s,
    operation: applyOpParams(s.operation, values),
    result: s.result ? { ...s.result } : s.result,
  }));
  return { ...pipeline, steps };
}

export function validateRuntimeParams(
  fields: PromptField[],
  values: Record<string, string>,
): string | null {
  for (const f of fields) {
    if (f.required === false) continue;
    if (!(values[f.key] ?? "").trim()) {
      return `请填写「${f.label || f.key}」`;
    }
  }
  return null;
}
