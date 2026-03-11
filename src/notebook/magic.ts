/**
 * IPython magic command commenting/uncommenting.
 *
 * When writing .py (pull): comment magics so the .py is valid Python.
 * When reading .py (push): uncomment them back for the notebook.
 *
 * Recognized patterns:
 * - Line magics: %matplotlib, %time, %load_ext, etc.
 * - Cell magics: %%timeit, %%capture, %%HTML, etc.
 * - Shell commands: !pip install, !ls, etc.
 * - Help: ?obj, obj?
 */

/** Regex for lines that are IPython magics and should be commented in .py */
const MAGIC_RE =
  /^(\s*)(%%?\w|!\w|!\.|!\[|\?)(.*)$/;

/**
 * Regex for common POSIX-like commands that IPython intercepts.
 * These only match at the start of a line (no indentation) and only
 * if followed by a space or end of line — to avoid matching Python
 * variables named `cat`, `ls`, etc.
 */
const POSIX_COMMANDS = new Set([
  "cat",
  "cd",
  "cp",
  "echo",
  "ls",
  "man",
  "mkdir",
  "more",
  "mv",
  "rm",
  "rmdir",
  "head",
  "tail",
  "wc",
]);

/**
 * Check if a line is an IPython magic.
 *
 * @param strict — When true (used by uncommentMagics), only match
 *   unambiguous magics with distinctive prefixes (%, %%, !, ?).
 *   POSIX bare commands (ls, cd, cat) are excluded because `# ls files`
 *   is indistinguishable from a Python comment about listing files.
 *   When false (used by commentMagics), also match POSIX commands.
 */
function isMagic(line: string, strict = false): boolean {
  // Standard magics: %..., %%..., !..., ?...
  if (MAGIC_RE.test(line)) return true;

  // POSIX commands: only in non-strict mode (commentMagics).
  // In strict mode (uncommentMagics), these are ambiguous with comments.
  if (!strict) {
    const trimmed = line.trimStart();
    if (trimmed === line) { // no indent — possible POSIX magic
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        // Bare command with no arguments (e.g., `ls`, `cd`, `pwd`)
        if (POSIX_COMMANDS.has(trimmed)) return true;
      } else {
        const cmd = trimmed.slice(0, spaceIdx);
        const rest = trimmed.slice(spaceIdx + 1).trimStart();
        if (POSIX_COMMANDS.has(cmd) && !rest.startsWith("=")) {
          return true;
        }
      }
    }
  }

  const trimmed = line.trimStart();

  // Help suffix: `float?`, `float??`
  if (/^\w+\?{1,2}$/.test(trimmed)) return true;

  // Magic assignment: `x = %time expr`, `x = !command`
  if (/^\s*\w+\s*=\s*[%!]/.test(line)) return true;

  return false;
}

/** Comment magic lines in source (notebook → .py). */
export function commentMagics(source: string): string {
  if (!source) return source;
  const lines = source.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    if (isMagic(line)) {
      // Preserve leading whitespace, add # prefix
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      const content = line.slice(indent.length);
      result.push(`${indent}# ${content}`);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

/** Uncomment magic lines in source (.py → notebook). */
export function uncommentMagics(source: string): string {
  if (!source) return source;
  const lines = source.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    // Try to uncomment: remove "# " prefix and check if result is a magic.
    // Use strict mode to avoid uncommenting ambiguous patterns (POSIX commands).
    const match = line.match(/^(\s*)# (.*)$/);
    if (match) {
      const indent = match[1]!;
      const content = match[2]!;
      const uncommented = indent + content;
      if (isMagic(uncommented, true)) {
        result.push(uncommented);
        continue;
      }
    }
    result.push(line);
  }

  return result.join("\n");
}
