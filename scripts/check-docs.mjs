#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/u)
  .filter((file) => file && existsSync(resolve(root, file)));
const markdownFiles = repositoryFiles.filter((file) => file.endsWith(".md"));
const failures = [];
const warnings = [];
const anchorCache = new Map();

const contextBudgetRemediation =
  "Move directory-specific rules to nested or path-scoped context, move " +
  "procedures and reference material to on-demand skills or linked docs, " +
  "simplify repeated wording, and remove completed history or stale conclusions.";
const contextWarningRatio = 0.8;
const codexProjectDocMaxBytes = 32 * 1_024;
const claudeRecommendedLines = 200;
const hermesMinimumContextChars = 20_000;

const agentInstructions = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const claudeWrapper = readFileSync(resolve(root, "CLAUDE.md"), "utf8").replace(
  /^@AGENTS\.md\s*(?:\r?\n)?/u,
  "",
);
const stsInstructions = readFileSync(
  resolve(root, ".agents/skills/stop-that-shit/SKILL.md"),
  "utf8",
);
const topLevelContextBudgets = [
  {
    name: "Codex project instruction chain",
    text: agentInstructions,
    recommended: {
      bytes: Math.floor(codexProjectDocMaxBytes * contextWarningRatio),
    },
    hard: { bytes: codexProjectDocMaxBytes },
  },
  {
    name: "Claude effective project instructions",
    text: `${agentInstructions}\n${claudeWrapper}`,
    recommended: { lines: claudeRecommendedLines },
    hard: {
      lines: Math.ceil(claudeRecommendedLines / contextWarningRatio),
    },
  },
  {
    name: "Hermes root project context",
    text: agentInstructions,
    recommended: {
      chars: Math.floor(hermesMinimumContextChars * contextWarningRatio),
    },
    hard: { chars: hermesMinimumContextChars },
  },
  {
    name: "Required stop-that-shit skill",
    text: stsInstructions,
    recommended: {
      lines: claudeRecommendedLines,
      chars: Math.floor(hermesMinimumContextChars * contextWarningRatio),
      bytes: Math.floor(codexProjectDocMaxBytes * contextWarningRatio),
    },
    hard: {
      lines: Math.ceil(claudeRecommendedLines / contextWarningRatio),
      chars: hermesMinimumContextChars,
      bytes: codexProjectDocMaxBytes,
    },
  },
];
const exactWarningBudgets = new Map([
  ["docs/README.md", [180, 16_000]],
  ["docs/deployment.md", [250, 20_000]],
  ["docs/project-memory.md", [120, 12_000]],
  ["docs/status.md", [120, 12_000]],
  ["docs/todo.md", [160, 16_000]],
]);
const prefixWarningBudgets = [
  ["docs/product/", 180, 16_000],
  ["docs/adr/", 350, 30_000],
  ["docs/research/", 650, 50_000],
  ["docs/operations/", 250, 20_000],
  ["docs/reference/", 250, 20_000],
];

for (const file of markdownFiles) {
  const absolute = resolve(root, file);
  const text = readFileSync(absolute, "utf8");
  checkFormat(file, text);
  checkBudget(file, text);

  const scannable = withoutFencedCode(text).replace(/`[^`\n]*`/gu, "");
  const targets = [
    ...inlineLinkTargets(scannable),
    ...matches(scannable, /^\s*\[[^\]]+\]:\s+(\S+)/gmu),
    ...matches(scannable, /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/giu),
  ];
  for (const raw of targets) checkLink(file, absolute, raw);
}

checkTopLevelContextBudgets();

if (warnings.length > 0) {
  process.stderr.write(`${warnings.map((warning) => `warning: ${warning}`).join("\n")}\n`);
}
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Documentation checks passed (${markdownFiles.length} Markdown files).\n`);

function checkFormat(file, text) {
  if (text.length > 0 && !text.endsWith("\n")) {
    failures.push(`${file}: missing final newline`);
  }
  if (text.endsWith("\n\n")) {
    failures.push(`${file}: extra blank line at end of file`);
  }
}

function checkBudget(file, text) {
  const warningBudget =
    exactWarningBudgets.get(file) ??
    prefixWarningBudgets
      .filter(([prefix]) => file.startsWith(prefix))
      .map(([, maxLines, maxBytes]) => [maxLines, maxBytes])[0];
  const lines = logicalLines(text);
  const bytes = Buffer.byteLength(text);
  if (warningBudget) {
    const [maxLines, maxBytes] = warningBudget;
    if (lines <= maxLines && bytes <= maxBytes) return;
    warnings.push(
      `${file}: exceeds ${maxLines}-line/${maxBytes}-byte gardening threshold ` +
        `(${lines} lines, ${bytes} bytes)`,
    );
  }
}

function checkTopLevelContextBudgets() {
  for (const budget of topLevelContextBudgets) {
    const measures = {
      lines: logicalLines(budget.text),
      chars: [...budget.text].length,
      bytes: Buffer.byteLength(budget.text),
    };
    if (exceeds(measures, budget.hard)) {
      failures.push(
        `${budget.name}: exceeds hard context ceiling ${formatLimits(budget.hard)} ` +
          `(${formatUsage(measures, budget.hard)}). ${contextBudgetRemediation}`,
      );
      continue;
    }
    if (exceeds(measures, budget.recommended)) {
      warnings.push(
        `${budget.name}: exceeds recommended working budget ` +
          `${formatLimits(budget.recommended)} ` +
          `(${formatUsage(measures, budget.recommended)}). ` +
          `${contextBudgetRemediation}`,
      );
    }
  }
}

function exceeds(measures, limits) {
  return Object.entries(limits).some(([metric, limit]) => measures[metric] > limit);
}

function formatLimits(limits) {
  return Object.entries(limits)
    .map(([metric, limit]) => `${limit} ${metricLabel(metric)}`)
    .join(" / ");
}

function formatUsage(measures, limits) {
  return Object.keys(limits)
    .map((metric) => `${measures[metric]} ${metricLabel(metric)}`)
    .join(", ");
}

function metricLabel(metric) {
  return metric === "bytes" ? "UTF-8 bytes" : metric;
}

function checkLink(file, sourcePath, raw) {
  const target = linkTarget(raw);
  if (!target || isExternal(target)) return;

  const [pathAndQuery, rawFragment = ""] = target.split("#", 2);
  const rawPath = pathAndQuery.split("?", 1)[0];
  let pathText;
  let fragment;
  try {
    pathText = decodeURIComponent(rawPath);
    fragment = decodeURIComponent(rawFragment).toLowerCase();
  } catch {
    failures.push(`${file}: invalid URL encoding: ${target}`);
    return;
  }

  const targetPath = pathText
    ? pathText.startsWith("/")
      ? resolve(root, `.${pathText}`)
      : resolve(dirname(sourcePath), pathText)
    : sourcePath;
  const repoRelative = relative(root, targetPath);
  if (repoRelative === ".." || repoRelative.startsWith(`..${sep}`)) {
    failures.push(`${file}: link leaves repository: ${target}`);
    return;
  }
  if (!existsSync(targetPath)) {
    failures.push(`${file}: missing link target: ${target}`);
    return;
  }
  if (
    fragment &&
    statSync(targetPath).isFile() &&
    extname(targetPath).toLowerCase() === ".md" &&
    !anchorsFor(targetPath).has(fragment)
  ) {
    failures.push(`${file}: missing anchor in ${repoRelative}: #${rawFragment}`);
  }
}

function logicalLines(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/u).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function matches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function inlineLinkTargets(text) {
  const targets = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== "]" || text[index + 1] !== "(") continue;
    let depth = 1;
    let cursor = index + 2;
    const start = cursor;
    for (; cursor < text.length && depth > 0; cursor += 1) {
      if (text[cursor] === "\\") {
        cursor += 1;
      } else if (text[cursor] === "(") {
        depth += 1;
      } else if (text[cursor] === ")") {
        depth -= 1;
      }
    }
    if (depth === 0) {
      targets.push(text.slice(start, cursor - 1));
      index = cursor - 1;
    }
  }
  return targets;
}

function linkTarget(raw) {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    return end > 0 ? value.slice(1, end) : null;
  }
  return value.split(/\s+["']/u, 1)[0];
}

function isExternal(target) {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) {
    return true;
  }
  return target.startsWith("/") && !/\.md(?:[?#]|$)/iu.test(target);
}

function withoutFencedCode(text) {
  let fence = null;
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
        }
        return "";
      }
      if (marker) {
        fence = marker;
        return "";
      }
      return line;
    })
    .join("\n");
}

function anchorsFor(path) {
  const cached = anchorCache.get(path);
  if (cached) return cached;

  const lines = withoutFencedCode(readFileSync(path, "utf8")).split(/\r?\n/u);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(lines[index]);
    if (atx) {
      headings.push(atx[2]);
      continue;
    }
    if (
      lines[index].trim() &&
      index + 1 < lines.length &&
      /^\s*(?:=+|-+)\s*$/u.test(lines[index + 1])
    ) {
      headings.push(lines[index].trim());
      index += 1;
    }
  }

  const anchors = new Set();
  const counts = new Map();
  for (const heading of headings) {
    const base = githubSlug(heading);
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(path, anchors);
  return anchors;
}

function githubSlug(heading) {
  return decodeHtmlEntities(heading)
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/!?\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/giu, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()];
    const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}
