import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function run(command, cwd) {
  const subprocess = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr}`);
  return stdout.trim();
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "mermaid-spec-package-"));
try {
  const filename = await run(["bun", "pm", "pack", "--quiet", "--destination", temporary], root);
  const packedPath = filename.split(/\r?\n/).at(-1);
  const archive = isAbsolute(packedPath) ? packedPath : join(temporary, packedPath);
  const entries = (await run(["tar", "-tzf", archive], temporary)).split(/\r?\n/);
  const required = [
    "package/README.md",
    "package/SECURITY.md",
    "package/src/cli.js",
    "package/examples/full-stack/specs/domain.md",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`Packed archive is missing ${entry}`);
  }
  const prohibited = entries.find((entry) =>
    /(^|\/)(node_modules|dist|\.data)(\/|$)|\.(?:db|sqlite|sqlite3)$/i.test(entry),
  );
  if (prohibited) throw new Error(`Packed archive contains prohibited artifact ${prohibited}`);

  await Bun.write(join(temporary, "package.json"), '{"private":true,"type":"module"}\n');
  await run(["bun", "add", "--dev", archive], temporary);

  const cli = join(temporary, "node_modules", "mermaid-spec", "src", "cli.js");
  const example = join(root, "examples", "order.md");
  const check = await run(["bun", cli, "check", example], temporary);
  if (!check.includes("Valid stateMachine 'order'")) throw new Error("Installed CLI did not validate the example state machine");
  const graph = await run(["bun", cli, "graph", example], temporary);
  if (!graph.includes("Contract graph:")) throw new Error("Installed CLI did not inspect the contract graph");

  await run(["bun", "--eval", "import { parseStateDiagram } from 'mermaid-spec'; if (parseStateDiagram('stateDiagram-v2\\n[*] --> Ready').initial !== 'Ready') throw new Error('Unexpected package import result');"], temporary);

  console.log("Packed Bun archive, CLI, and module imports passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
