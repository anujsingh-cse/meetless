# Markdown-to-HTML CLI Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI tool that reads Markdown from stdin or a file argument and outputs HTML to stdout.

**Architecture:** Three focused modules: CLI entry point handles I/O and arguments, Parser converts Markdown to an intermediate AST, Renderer converts AST to HTML. Each is a pure function with no side effects for easy testing.

**Tech Stack:** TypeScript, Node.js (no external dependencies)

**Spec:** (this plan — no separate spec document)

## Global Constraints

- Zero external dependencies (no `marked`, `remark`, etc.)
- Support: headers (#-######), paragraphs, bold (**), italic (*), inline code (`), code blocks (```), links ([text](url))
- Single binary output via `tsx` or compiled JS
- Input: stdin or file path argument; Output: stdout

---

### Task 1: Project Setup & CLI Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/cli.ts`

**Interfaces:**
- Produces: `cli.ts` with `main(args: string[]): Promise<void>` entry point

- [ ] **Step 1: Write package.json**

```json
{
  "name": "md2html",
  "version": "1.0.0",
  "type": "module",
  "bin": { "md2html": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.7.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write CLI skeleton with argument parsing**

```typescript
// src/cli.ts
import { parse } from "./parser.js";
import { render } from "./renderer.js";

async function main(args: string[]): Promise<void> {
  const fileArg = args[0];
  let input: string;

  if (fileArg && fileArg !== "-") {
    input = await Bun.file(fileArg).text();
  } else {
    input = await new Response(Bun.stdin).text();
  }

  const ast = parse(input);
  const html = render(ast);
  console.log(html);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

export { main };
```

- [ ] **Step 4: Run build to verify compiles**

Run: `npm run build`
Expected: SUCCESS, outputs `dist/cli.js`

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json src/cli.ts
git commit -m "chore: project setup and CLI skeleton"
```

---

### Task 2: Markdown Parser (AST)

**Files:**
- Create: `src/parser.ts`
- Test: `tests/parser.test.ts`

**Interfaces:**
- Consumes: (none — first implementation task)
- Produces: `parse(markdown: string): ASTNode[]` where `ASTNode` is a discriminated union

- [ ] **Step 1: Write failing tests for parser**

```typescript
// tests/parser.test.ts
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

describe("parse", () => {
  it("parses empty string", () => {
    expect(parse("")).toEqual([]);
  });

  it("parses heading", () => {
    expect(parse("# Hello")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", value: "Hello" }] }
    ]);
  });

  it("parses paragraph", () => {
    expect(parse("Hello world")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "Hello world" }] }
    ]);
  });

  it("parses bold", () => {
    expect(parse("**bold**")).toEqual([{
      type: "paragraph",
      children: [{ type: "bold", children: [{ type: "text", value: "bold" }] }]
    }]);
  });

  it("parses italic", () => {
    expect(parse("*italic*")).toEqual([{
      type: "paragraph",
      children: [{ type: "italic", children: [{ type: "text", value: "italic" }] }]
    }]);
  });

  it("parses inline code", () => {
    expect(parse("`code`")).toEqual([{
      type: "paragraph",
      children: [{ type: "code", value: "code" }]
    }]);
  });

  it("parses code block", () => {
    expect(parse("```\ncode\n```")).toEqual([
      { type: "codeBlock", language: "", value: "code" }
    ]);
  });

  it("parses link", () => {
    expect(parse("[link](url)")).toEqual([{
      type: "paragraph",
      children: [{ type: "link", url: "url", children: [{ type: "text", value: "link" }] }]
    }]);
  });

  it("parses multiple elements", () => {
    const result = parse("# Title\n\nParagraph with **bold**.");
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("heading");
    expect(result[1].type).toBe("paragraph");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (parser not implemented)

- [ ] **Step 3: Write parser implementation**

```typescript
// src/parser.ts
export type ASTNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "codeBlock"; language: string; value: string };

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "link"; url: string; children: InlineNode[] };

export function parse(markdown: string): ASTNode[] {
  const lines = markdown.split("\n");
  const blocks: ASTNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("#")) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const text = line.slice(level).trim();
      blocks.push({ type: "heading", level: Math.min(level, 6) as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(text) });
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "codeBlock", language, value: codeLines.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```")) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraphLines.join(" ")) });
    }
  }

  return blocks;
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      nodes.push({ type: "bold", children: [{ type: "text", value: boldMatch[1] }] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      nodes.push({ type: "italic", children: [{ type: "text", value: italicMatch[1] }] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch) {
      nodes.push({ type: "code", value: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/);
    if (linkMatch) {
      nodes.push({ type: "link", url: linkMatch[2], children: [{ type: "text", value: linkMatch[1] }] });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text - find next special char
    const nextSpecial = remaining.search(/[\*\[`]/);
    if (nextSpecial === -1) {
      nodes.push({ type: "text", value: remaining });
      break;
    }
    if (nextSpecial > 0) {
      nodes.push({ type: "text", value: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    } else {
      // Single special char not part of syntax - treat as text
      nodes.push({ type: "text", value: remaining[0] });
      remaining = remaining.slice(1);
    }
  }

  // Merge adjacent text nodes
  return nodes.reduce((acc, node) => {
    if (acc.length > 0 && acc[acc.length - 1].type === "text" && node.type === "text") {
      acc[acc.length - 1] = { type: "text", value: acc[acc.length - 1].value + node.value };
    } else {
      acc.push(node);
    }
    return acc;
  }, [] as InlineNode[]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat: implement markdown parser with AST"
```

---

### Task 3: HTML Renderer

**Files:**
- Create: `src/renderer.ts`
- Test: `tests/renderer.test.ts`

**Interfaces:**
- Consumes: `parse()` output from Task 2 (`ASTNode[]`)
- Produces: `render(ast: ASTNode[]): string`

- [ ] **Step 1: Write failing tests for renderer**

```typescript
// tests/renderer.test.ts
import { describe, it, expect } from "vitest";
import { render } from "../src/renderer.js";

describe("render", () => {
  it("renders empty AST", () => {
    expect(render([])).toBe("");
  });

  it("renders heading", () => {
    const ast = [{ type: "heading", level: 1, children: [{ type: "text", value: "Hello" }] } as const];
    expect(render(ast)).toBe("<h1>Hello</h1>");
  });

  it("renders paragraph", () => {
    const ast = [{ type: "paragraph", children: [{ type: "text", value: "Hello world" }] } as const];
    expect(render(ast)).toBe("<p>Hello world</p>");
  });

  it("renders bold", () => {
    const ast = [{ type: "paragraph", children: [{ type: "bold", children: [{ type: "text", value: "bold" }] }] } as const];
    expect(render(ast)).toBe("<p><strong>bold</strong></p>");
  });

  it("renders italic", () => {
    const ast = [{ type: "paragraph", children: [{ type: "italic", children: [{ type: "text", value: "italic" }] }] } as const];
    expect(render(ast)).toBe("<p><em>italic</em></p>");
  });

  it("renders inline code", () => {
    const ast = [{ type: "paragraph", children: [{ type: "code", value: "code" }] } as const];
    expect(render(ast)).toBe("<p><code>code</code></p>");
  });

  it("renders code block", () => {
    const ast = [{ type: "codeBlock", language: "js", value: "const x = 1;" } as const];
    expect(render(ast)).toBe('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it("renders link", () => {
    const ast = [{ type: "paragraph", children: [{ type: "link", url: "https://example.com", children: [{ type: "text", value: "link" }] }] } as const];
    expect(render(ast)).toBe('<p><a href="https://example.com">link</a></p>');
  });

  it("renders nested inline elements", () => {
    const ast = [{ type: "paragraph", children: [
      { type: "text", value: "Hello " },
      { type: "bold", children: [{ type: "text", value: "world" }] },
      { type: "text", value: "!" }
    ]} as const];
    expect(render(ast)).toBe("<p>Hello <strong>world</strong>!</p>");
  });

  it("renders multiple blocks", () => {
    const ast = [
      { type: "heading", level: 2, children: [{ type: "text", value: "Title" }] },
      { type: "paragraph", children: [{ type: "text", value: "Content" }] }
    ] as const;
    expect(render(ast)).toBe("<h2>Title</h2><p>Content</p>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (renderer not implemented)

- [ ] **Step 3: Write renderer implementation**

```typescript
// src/renderer.ts
import type { ASTNode, InlineNode } from "./parser.js";

export function render(ast: ASTNode[]): string {
  return ast.map(renderBlock).join("");
}

function renderBlock(node: ASTNode): string {
  switch (node.type) {
    case "heading":
      return `<h${node.level}>${renderInline(node.children)}</h${node.level}>`;
    case "paragraph":
      return `<p>${renderInline(node.children)}</p>`;
    case "codeBlock": {
      const lang = node.language ? ` class="language-${node.language}"` : "";
      const escaped = escapeHtml(node.value);
      return `<pre><code${lang}>${escaped}</code></pre>`;
    }
  }
}

function renderInline(nodes: InlineNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: InlineNode): string {
  switch (node.type) {
    case "text":
      return escapeHtml(node.value);
    case "bold":
      return `<strong>${renderInline(node.children)}</strong>`;
    case "italic":
      return `<em>${renderInline(node.children)}</em>`;
    case "code":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "link":
      return `<a href="${escapeHtml(node.url)}">${renderInline(node.children)}</a>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """)
    .replace(/'/g, "'");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts tests/renderer.test.ts
git commit -m "feat: implement HTML renderer"
```

---

### Task 4: Integration Test & Polish

**Files:**
- Test: `tests/integration.test.ts`
- Modify: `src/cli.ts` (fix imports if needed)

**Interfaces:**
- Consumes: full pipeline from CLI → Parser → Renderer

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration.test.ts
import { describe, it, expect } from "vitest";
import { main } from "../src/cli.js";
import { parse } from "../src/parser.js";
import { render } from "../src/renderer.js";

describe("full pipeline", () => {
  it("converts markdown to html via parse + render", () => {
    const markdown = `# Title

Paragraph with **bold** and *italic*.

\`\`\`js
console.log("hello");
\`\`\`

[Link](https://example.com)`;
    
    const ast = parse(markdown);
    const html = render(ast);
    
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Paragraph with <strong>bold</strong> and <em>italic</em>.</p>");
    expect(html).toContain('<pre><code class="language-js">console.log("hello");</code></pre>');
    expect(html).toContain('<a href="https://example.com">Link</a>');
  });

  it("handles empty input", () => {
    const ast = parse("");
    const html = render(ast);
    expect(html).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Manual CLI test**

Run: `echo '# Hello' | npm run dev`
Expected: `<h1>Hello</h1>`

Run: `echo '**bold**' | npm run dev`
Expected: `<p><strong>bold</strong></p>`

- [ ] **Step 4: Build and verify binary**

Run: `npm run build`
Run: `node dist/cli.js <<< '# Test'`
Expected: `<h1>Test</h1>`

- [ ] **Step 5: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add integration tests and verify CLI"
```

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-24-markdown-to-html-cli.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**