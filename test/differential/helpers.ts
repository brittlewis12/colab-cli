/**
 * Differential oracle helpers.
 * Shells out to `uvx jupytext` to get the "expected" conversion output.
 */

const UVX = "uvx";
const JUPYTEXT = "jupytext";

/** Convert .ipynb content to percent-format .py using jupytext as oracle. */
export async function jupytextToPercent(
  ipynbContent: string,
): Promise<string> {
  const proc = Bun.spawn(
    [UVX, JUPYTEXT, "--from", "ipynb", "--to", "py:percent", "--output", "-"],
    { stdin: new Blob([ipynbContent]), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `jupytext --to py:percent failed (exit ${exitCode}): ${stderr}`,
    );
  }
  return stdout;
}

/** Convert percent-format .py content to .ipynb using jupytext as oracle. */
export async function jupytextToNotebook(
  pyContent: string,
): Promise<string> {
  const proc = Bun.spawn(
    [UVX, JUPYTEXT, "--from", "py:percent", "--to", "ipynb", "--output", "-"],
    { stdin: new Blob([pyContent]), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `jupytext --to ipynb failed (exit ${exitCode}): ${stderr}`,
    );
  }
  return stdout;
}

/**
 * Strip jupytext-specific metadata from a .py percent file for comparison.
 * jupytext adds version info (jupytext_version, format_version) that we
 * intentionally don't emit. Strip those lines for fair comparison.
 */
export function stripJupytextMeta(py: string): string {
  const lines = py.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.replace(/^#\s*/, "");
    if (trimmed.startsWith("jupytext:")) return false;
    if (trimmed.startsWith("text_representation:")) return false;
    if (trimmed.startsWith("extension:")) return false;
    if (trimmed.startsWith("format_name:")) return false;
    if (trimmed.startsWith("format_version:")) return false;
    if (trimmed.startsWith("jupytext_version:")) return false;
    return true;
  });
  return filtered.join("\n");
}
