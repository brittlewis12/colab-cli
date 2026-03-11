/**
 * StringParser: tracks whether we're inside a triple-quoted string.
 *
 * Used to prevent false `# %%` cell marker matches inside string literals.
 * Ported from jupytext's StringParser (cell_reader.py).
 *
 * Key behaviors:
 * - Tracks `"""` and `'''` open/close state
 * - Handles escaped quotes (`\"`)
 * - Stops processing at `#` comments when not inside a string
 * - Single-line quotes reset at end of line
 */

export class StringParser {
  private tripleQuoteOpen: '"""' | "'''" | null = null;

  /** Returns true if currently inside a triple-quoted string. */
  isQuoted(): boolean {
    return this.tripleQuoteOpen !== null;
  }

  /**
   * Process one line of Python source.
   * Call this for each line in order. After calling, check isQuoted()
   * to determine if the NEXT line starts inside a string.
   */
  readLine(line: string): void {
    let i = 0;
    const len = line.length;

    while (i < len) {
      if (this.tripleQuoteOpen !== null) {
        // Inside a triple-quoted string: scan for the closing triple quote,
        // skipping backslash escape sequences (e.g. \""" does NOT close)
        const q = this.tripleQuoteOpen[0]!;
        let found = false;
        while (i < len) {
          if (line[i] === "\\") {
            i += 2;
            continue;
          }
          if (
            line[i] === q &&
            i + 2 < len &&
            line[i + 1] === q &&
            line[i + 2] === q
          ) {
            i += 3;
            this.tripleQuoteOpen = null;
            found = true;
            break;
          }
          i++;
        }
        if (!found) {
          return;
        }
        continue;
      }

      // Not inside a triple-quoted string
      const ch = line[i]!;

      // Comment — stop processing (rest of line is comment, not code)
      if (ch === "#") {
        return;
      }

      // Check for triple quotes
      if (
        (ch === '"' || ch === "'") &&
        i + 2 < len &&
        line[i + 1] === ch &&
        line[i + 2] === ch
      ) {
        // Look for close on the same line, skipping escape sequences
        let j = i + 3;
        let sameLine = false;
        while (j + 2 < len) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === ch && line[j + 1] === ch && line[j + 2] === ch) {
            j += 3;
            sameLine = true;
            break;
          }
          j++;
        }
        if (sameLine) {
          i = j;
          continue;
        }
        // Opened but not closed — we're now inside a triple-quoted string
        this.tripleQuoteOpen = (ch + ch + ch) as '"""' | "'''";
        return;
      }

      // Single/double quote (not triple) — skip to closing quote on same line
      if (ch === '"' || ch === "'") {
        i++;
        while (i < len) {
          if (line[i] === "\\") {
            i += 2; // skip escaped character
            continue;
          }
          if (line[i] === ch) {
            i++; // past closing quote
            break;
          }
          i++;
        }
        // If we hit end of line without closing, the quote "resets" (Python
        // single-line strings can't span lines without \)
        continue;
      }

      i++;
    }
  }
}
