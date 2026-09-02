import { expect, test } from "bun:test";
import { extractMermaidBlocks, extractMermaidDiagrams, SpecError } from "../src/index.js";

test("accepts a raw state diagram", () => {
  const source = "stateDiagram-v2\n[*] --> Ready";
  expect(extractMermaidDiagrams(source)).toEqual([source]);
});

test("extracts state diagrams from Markdown without guessing other blocks", () => {
  const source = `# Contract

\`\`\`mermaid
sequenceDiagram
  Client->>API: GET /health (health)
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  [*] --> Ready
\`\`\``;
  expect(extractMermaidDiagrams(source)).toHaveLength(1);
  expect(extractMermaidBlocks(source).map((block) => block.type)).toEqual(["apiContract", "stateMachine"]);
});

test("rejects input without a state diagram", () => {
  expect(() => extractMermaidDiagrams("# No diagram")).toThrow(SpecError);
});
