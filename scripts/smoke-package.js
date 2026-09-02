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
const args = Bun.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--archive")) {
  throw new Error("Usage: bun scripts/smoke-package.js [--archive <tarball>]");
}
const temporary = await mkdtemp(join(tmpdir(), "mermaid-spec-package-"));
try {
  let archive = args.length ? resolve(args[1]) : undefined;
  if (!archive) {
    const filename = await run(["bun", "pm", "pack", "--quiet", "--destination", temporary], root);
    const packedPath = filename.split(/\r?\n/).at(-1);
    archive = isAbsolute(packedPath) ? packedPath : join(temporary, packedPath);
  }
  const entries = (await run(["tar", "-tzf", archive], temporary)).split(/\r?\n/);
  const required = [
    "package/package.json",
    "package/README.md",
    "package/SECURITY.md",
    "package/src/cli.js",
    "package/src/index.js",
    "package/src/runtime.js",
    "package/src/http-runtime.js",
    "package/examples/order.md",
    "package/examples/full-stack/specs/domain.md",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`Packed archive is missing ${entry}`);
  }
  const allowed = /^package\/(?:$|(?:src|examples|docs)\/|(?:package\.json|README\.md|CHANGELOG\.md|SECURITY\.md|CONTRIBUTING\.md|LICENSE)$)/;
  const localArtifact = /(^|\/)(?:node_modules|dist|build|coverage|test-results|playwright-report)(\/|$)|\.(?:db|sqlite|sqlite3)(?:-(?:shm|wal))?$|\.(?:log|tgz|mp4|mov|webm)$/i;
  const prohibited = entries.find((entry) => !allowed.test(entry) || localArtifact.test(entry) || entry.split("/").some((part) => part.startsWith(".")));
  if (prohibited) throw new Error(`Packed archive contains prohibited artifact ${prohibited}`);

  await Bun.write(join(temporary, "package.json"), '{"private":true,"type":"module"}\n');
  await run(["bun", "add", "--dev", archive], temporary);

  const installed = join(temporary, "node_modules", "mermaid-spec");
  const metadata = await Bun.file(join(installed, "package.json")).json();
  const cli = ["bun", "x", "--no-install", "mermaid-spec"];
  const help = await run([...cli, "--help"], temporary);
  if (!help.includes("Usage: mermaid-spec <command> <path> [options]")) throw new Error("Installed CLI did not show help");
  const version = await run([...cli, "--version"], temporary);
  if (version !== metadata.version) throw new Error("Installed CLI version does not match its package");
  const example = join(installed, "examples", "order.md");
  const check = await run([...cli, "check", example], temporary);
  if (!check.includes("Valid stateMachine 'order'")) throw new Error("Installed CLI did not validate the example state machine");
  const graph = await run([...cli, "graph", example], temporary);
  if (!graph.includes("Contract graph:")) throw new Error("Installed CLI did not inspect the contract graph");
  await run([...cli, "test", example], temporary);
  await run([...cli, "build", example, "--out", "generated"], temporary);
  await run([...cli, "verify", example, "--out", "generated"], temporary);

  await run(["bun", "--eval", "import { parseStateDiagram } from 'mermaid-spec'; if (parseStateDiagram('stateDiagram-v2\\n[*] --> Ready').initial !== 'Ready') throw new Error('Unexpected package import result');"], temporary);
  await run(["bun", "--eval", "for (const name of ['mermaid-spec/runtime', 'mermaid-spec/http']) { const exports = await import(name); if (!Object.keys(exports).length) throw new Error('Empty export: ' + name); }"], temporary);

  console.log(`Package ${metadata.name}@${metadata.version}: archive policy, CLI help/version/check/test/graph/build/verify, and all public exports passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
