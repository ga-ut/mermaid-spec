import { SpecError } from "./errors.js";

/** Extract Mermaid code blocks from Markdown, or accept a raw diagram. */
export function extractMermaidDiagrams(source) {
  if (/^\s*stateDiagram(?:-v2)?\b/m.test(source) && !source.includes("```")) {
    return [source];
  }

  const diagrams = [];
  const pattern = /```mermaid\s*\n([\s\S]*?)```/g;
  for (const match of source.matchAll(pattern)) {
    if (/^\s*stateDiagram(?:-v2)?\b/m.test(match[1])) diagrams.push(match[1]);
  }

  if (diagrams.length === 0) {
    throw new SpecError("No Mermaid stateDiagram block found");
  }
  return diagrams;
}

/** Extract every Mermaid block with its diagram type and source position. */
export function extractMermaidBlocks(source) {
  const blocks = [];
  const pattern = /```mermaid\s*\n([\s\S]*?)```/g;
  for (const match of source.matchAll(pattern)) {
    const diagram = match[1].trim();
    const header = diagram.split(/\r?\n/, 1)[0].trim();
    const type = /^stateDiagram(?:-v2)?$/.test(header) ? "stateMachine"
      : header === "erDiagram" ? "entityModel"
        : header === "sequenceDiagram" ? "apiContract" : "unsupported";
    blocks.push({ type, source: diagram, offset: match.index ?? 0 });
  }
  return blocks;
}
