/**
 * YAML front-matter header for percent-format .py files.
 *
 * Format:
 *   # ---
 *   # jupyter:
 *   #   kernelspec:
 *   #     display_name: Python 3
 *   #     language: python
 *   #     name: python3
 *   # ---
 *
 * We only serialize/parse what we need: kernelspec and language_info
 * under the `jupyter:` key. We do NOT use a full YAML parser — the
 * structure is simple enough for hand-rolled serialization.
 */

import type { NotebookMetadata, KernelSpec, LanguageInfo } from "./types.ts";

// --- Serialize ---

function yamlScalar(value: string): string {
  // Quote if it contains special YAML characters
  if (/[:#\[\]{},&*?|>!%@`]/.test(value) || value !== value.trim()) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function serializeKernelspec(ks: KernelSpec): string[] {
  return [
    "#   kernelspec:",
    `#     display_name: ${yamlScalar(ks.display_name)}`,
    `#     language: ${yamlScalar(ks.language)}`,
    `#     name: ${yamlScalar(ks.name)}`,
  ];
}

/**
 * Serialize notebook metadata to a YAML header string (including the --- delimiters).
 * kernelspec is always first. language_info is omitted by default (jupytext behavior).
 * Other metadata keys are serialized after kernelspec.
 */
export function serializeHeader(metadata: NotebookMetadata): string | null {
  if (!metadata.kernelspec) return null;

  const lines: string[] = ["# ---", "# jupyter:"];

  // Emit kernel_info before kernelspec if present (matches jupytext ordering)
  if (metadata.kernel_info) {
    const ki = metadata.kernel_info as Record<string, unknown>;
    lines.push("#   kernel_info:");
    for (const [k, v] of Object.entries(ki)) {
      lines.push(`#     ${k}: ${yamlScalar(String(v))}`);
    }
  }

  lines.push(...serializeKernelspec(metadata.kernelspec));

  lines.push("# ---");

  return lines.join("\n");
}

// --- Parse ---

interface ParsedHeader {
  metadata: NotebookMetadata;
  bodyStart: number; // line index where the body begins (after header)
}

/**
 * Parse YAML front-matter from a .py file's lines.
 * Returns the extracted metadata and the line index where the body starts.
 * If no header is found, returns empty metadata and bodyStart=0.
 */
export function parseHeader(lines: string[]): ParsedHeader {
  // Find opening `# ---`
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed === "#") continue; // skip blank/comment-only lines
    if (trimmed === "# ---") {
      start = i;
      break;
    }
    // If first non-blank line isn't `# ---`, no header
    return { metadata: {}, bodyStart: 0 };
  }

  if (start === -1) return { metadata: {}, bodyStart: 0 };

  // Find closing `# ---`
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "# ---") {
      end = i;
      break;
    }
  }

  if (end === -1) return { metadata: {}, bodyStart: 0 };

  // Extract the YAML content (strip `# ` or `#` prefix from each line)
  const yamlLines: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (line.startsWith("# ")) {
      yamlLines.push(line.slice(2));
    } else if (line.startsWith("#")) {
      yamlLines.push(line.slice(1));
    } else {
      yamlLines.push(line);
    }
  }

  const metadata = parseSimpleYaml(yamlLines);

  // bodyStart is the line after the closing `# ---`, skipping one blank line
  let bodyStart = end + 1;
  if (bodyStart < lines.length && lines[bodyStart]!.trim() === "") {
    bodyStart++;
  }

  return { metadata, bodyStart };
}

/**
 * Minimal YAML parser for the `jupyter:` block.
 * Only handles the specific nested structure we care about:
 *   jupyter:
 *     kernelspec:
 *       key: value
 *     language_info:
 *       key: value
 */
function parseSimpleYaml(lines: string[]): NotebookMetadata {
  const metadata: NotebookMetadata = {};

  let section: "root" | "kernelspec" | "language_info" | "other" = "root";

  const kernelspec: Partial<KernelSpec> = {};
  const languageInfo: Partial<LanguageInfo> = {};

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "" || trimmed === "jupyter:") continue;

    // Detect section by indentation
    const indent = line.length - line.trimStart().length;
    const content = line.trimStart();

    if (indent <= 2 && content.startsWith("kernelspec:")) {
      section = "kernelspec";
      continue;
    }
    if (indent <= 2 && content.startsWith("language_info:")) {
      section = "language_info";
      continue;
    }
    if (indent <= 2 && content.includes(":")) {
      section = "other";
      continue;
    }

    // Parse key: value
    const kvMatch = content.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1]!;
    let value = kvMatch[2]!.trim();

    // Unquote YAML strings
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    if (section === "kernelspec") {
      if (key === "display_name") kernelspec.display_name = value;
      else if (key === "language") kernelspec.language = value;
      else if (key === "name") kernelspec.name = value;
    } else if (section === "language_info") {
      if (key === "name") languageInfo.name = value;
      else if (key === "version") languageInfo.version = value;
    }
  }

  if (kernelspec.display_name && kernelspec.language && kernelspec.name) {
    metadata.kernelspec = kernelspec as KernelSpec;
  }

  if (languageInfo.name) {
    metadata.language_info = languageInfo as LanguageInfo;
  }

  return metadata;
}
