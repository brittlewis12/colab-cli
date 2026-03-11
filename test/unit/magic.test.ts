import { describe, test, expect } from "bun:test";
import { commentMagics, uncommentMagics } from "../../src/notebook/magic.ts";

describe("commentMagics", () => {
  test("comments line magics", () => {
    expect(commentMagics("%matplotlib inline")).toBe("# %matplotlib inline");
  });

  test("comments cell magics", () => {
    expect(commentMagics("%%timeit")).toBe("# %%timeit");
  });

  test("comments shell commands", () => {
    expect(commentMagics("!pip install torch")).toBe("# !pip install torch");
  });

  test("comments help syntax", () => {
    expect(commentMagics("?print")).toBe("# ?print");
  });

  test("does NOT comment regular Python", () => {
    expect(commentMagics("x = 1")).toBe("x = 1");
    expect(commentMagics("print('hello')")).toBe("print('hello')");
    expect(commentMagics("# a comment")).toBe("# a comment");
    expect(commentMagics("def foo():")).toBe("def foo():");
  });

  test("does NOT comment POSIX-named variable assignments", () => {
    expect(commentMagics("cat = 42")).toBe("cat = 42");
    expect(commentMagics("ls = [1, 2]")).toBe("ls = [1, 2]");
  });

  test("does NOT comment // (not an IPython magic) (regression #8)", () => {
    expect(commentMagics("// this is not python")).toBe("// this is not python");
  });
});

describe("uncommentMagics", () => {
  test("uncomments line magics", () => {
    expect(uncommentMagics("# %matplotlib inline")).toBe("%matplotlib inline");
  });

  test("uncomments shell commands", () => {
    expect(uncommentMagics("# !pip install torch")).toBe("!pip install torch");
  });

  test("does NOT uncomment regular comments", () => {
    expect(uncommentMagics("# a comment")).toBe("# a comment");
    expect(uncommentMagics("# x = 1")).toBe("# x = 1");
  });
});

describe("magic round-trip: commentMagics → uncommentMagics", () => {
  test("POSIX comments survive round-trip (regression #3)", () => {
    // These are Python comments that happen to start with POSIX command names.
    // They should NOT be modified by commentMagics (they're already comments),
    // and uncommentMagics should NOT strip the # prefix.
    const sources = [
      "# mv tmp files",
      "# ls files in dir",
      "# rm old stuff",
      "# cd to directory",
      "# cat the file",
      "# echo hello world",
    ];
    for (const src of sources) {
      // commentMagics should leave comments alone
      expect(commentMagics(src)).toBe(src);
      // uncommentMagics should NOT turn these into shell commands
      expect(uncommentMagics(src)).toBe(src);
    }
  });

  test("// comments survive round-trip (regression #8)", () => {
    const src = "# // a C-style comment";
    expect(uncommentMagics(src)).toBe(src);
  });

  test("POSIX magics are commented but NOT uncommented (ambiguous)", () => {
    // Bare POSIX commands (ls, cd, cat) ARE commented on pull — they're
    // real IPython magics in the notebook. But they are NOT uncommented
    // on push because `# ls -la` is indistinguishable from a comment.
    // Users should use `!ls -la` for unambiguous shell commands.
    const magics = ["ls -la", "cd /tmp", "cat file.txt"];
    for (const m of magics) {
      // commentMagics recognizes them
      expect(commentMagics(m)).toBe(`# ${m}`);
      // uncommentMagics does NOT (ambiguous with comments)
      expect(uncommentMagics(`# ${m}`)).toBe(`# ${m}`);
    }
  });

  test("! prefixed shell commands DO round-trip", () => {
    // The unambiguous way to write shell commands
    const magics = ["!ls -la", "!cd /tmp", "!cat file.txt"];
    for (const m of magics) {
      const commented = commentMagics(m);
      expect(commented).toBe(`# ${m}`);
      expect(uncommentMagics(commented)).toBe(m);
    }
  });

  test("bare POSIX commands without arguments are commented (regression #12)", () => {
    expect(commentMagics("ls")).toBe("# ls");
    expect(commentMagics("cd")).toBe("# cd");
    expect(commentMagics("cat")).toBe("# cat");
  });

  test("bare POSIX commands are NOT uncommented in strict mode (regression #12)", () => {
    // Bare POSIX without ! prefix is ambiguous — don't uncomment
    expect(uncommentMagics("# ls")).toBe("# ls");
    expect(uncommentMagics("# cd")).toBe("# cd");
  });
});
