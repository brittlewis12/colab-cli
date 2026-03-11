import { describe, test, expect } from "bun:test";
import { StringParser } from "../../src/notebook/string-parser.ts";

describe("StringParser", () => {
  test("not quoted initially", () => {
    const parser = new StringParser();
    expect(parser.isQuoted()).toBe(false);
  });

  test("regular code line does not trigger quoted state", () => {
    const parser = new StringParser();
    parser.readLine('x = 1 + 2');
    expect(parser.isQuoted()).toBe(false);
  });

  test("triple double quote opens string", () => {
    const parser = new StringParser();
    parser.readLine('x = """');
    expect(parser.isQuoted()).toBe(true);
  });

  test("triple single quote opens string", () => {
    const parser = new StringParser();
    parser.readLine("x = '''");
    expect(parser.isQuoted()).toBe(true);
  });

  test("triple quote opened and closed on same line", () => {
    const parser = new StringParser();
    parser.readLine('x = """hello"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("triple quote across multiple lines", () => {
    const parser = new StringParser();
    parser.readLine('x = """');
    expect(parser.isQuoted()).toBe(true);
    parser.readLine("some content");
    expect(parser.isQuoted()).toBe(true);
    parser.readLine("# %% this is inside a string, not a cell marker");
    expect(parser.isQuoted()).toBe(true);
    parser.readLine('end of string"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("comment stops processing", () => {
    const parser = new StringParser();
    parser.readLine('x = 1  # """not a real triple quote');
    expect(parser.isQuoted()).toBe(false);
  });

  test("single-line string does not persist across lines", () => {
    const parser = new StringParser();
    parser.readLine('x = "hello');
    // Unterminated single-line string resets at end of line
    expect(parser.isQuoted()).toBe(false);
  });

  test("escaped quote inside single-line string", () => {
    const parser = new StringParser();
    parser.readLine('x = "he said \\"hello\\""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("triple quote inside comment is ignored", () => {
    const parser = new StringParser();
    parser.readLine('# x = """');
    expect(parser.isQuoted()).toBe(false);
  });

  test("# %% inside triple-quoted string is not a cell marker context", () => {
    const parser = new StringParser();
    parser.readLine('text = """');
    expect(parser.isQuoted()).toBe(true);
    // This line has # %% but we're inside a string
    parser.readLine("# %%");
    expect(parser.isQuoted()).toBe(true);
    parser.readLine('"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("mixed single and triple quotes", () => {
    const parser = new StringParser();
    parser.readLine(`x = 'hello' + """`);
    expect(parser.isQuoted()).toBe(true);
    parser.readLine('world"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("quadruple quote (edge case from jupytext tests)", () => {
    const parser = new StringParser();
    // """" is a triple quote opening followed by a single quote char
    // The triple opens, then the 4th " starts looking for close
    parser.readLine('x = """"');
    // After reading """": triple opens at 4, then the 4th " is content inside the string
    expect(parser.isQuoted()).toBe(true);
  });

  test("empty line", () => {
    const parser = new StringParser();
    parser.readLine("");
    expect(parser.isQuoted()).toBe(false);
  });

  test("escaped triple quote inside triple-quoted string (regression #5)", () => {
    const parser = new StringParser();
    parser.readLine('x = """');
    expect(parser.isQuoted()).toBe(true);
    // \""" in Python: escaped quote + two quotes, does NOT close the string
    parser.readLine('content with \\""" inside');
    expect(parser.isQuoted()).toBe(true);
    parser.readLine("still in string");
    expect(parser.isQuoted()).toBe(true);
    parser.readLine('"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("escaped backslash before triple quote DOES close string (regression #5)", () => {
    const parser = new StringParser();
    parser.readLine('x = """');
    expect(parser.isQuoted()).toBe(true);
    // \\""" in Python: escaped backslash + unescaped """, DOES close
    parser.readLine('content \\\\"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("same-line escaped triple quote does not false-close (regression #10)", () => {
    const parser = new StringParser();
    // x = """foo\""" — the \" escapes one quote, leaving "" (not enough to close)
    parser.readLine('x = """foo\\"""');
    expect(parser.isQuoted()).toBe(true);
    parser.readLine('still in string"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("same-line escaped backslash before close DOES close (regression #10)", () => {
    const parser = new StringParser();
    // x = """foo\\""" — \\ is escaped backslash, then """ closes
    parser.readLine('x = """foo\\\\"""');
    expect(parser.isQuoted()).toBe(false);
  });

  test("triple quote close with content after", () => {
    const parser = new StringParser();
    parser.readLine('x = """');
    expect(parser.isQuoted()).toBe(true);
    parser.readLine('""" + y');
    expect(parser.isQuoted()).toBe(false);
  });
});
