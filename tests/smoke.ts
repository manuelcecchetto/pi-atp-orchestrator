import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_START = "ATP_WORKER_RESULT_JSON_START";
const RESULT_END = "ATP_WORKER_RESULT_JSON_END";

// Fake the Pi worker subprocess. The extension respawns this same script via getPiInvocation().
if (process.argv.includes("--mode")) {
  const prompt = process.argv[process.argv.length - 1] || "";
  const root = prompt.match(/project_root: (.*)/)?.[1]?.trim();
  if (root) await fsp.writeFile(path.join(root, "hello.txt"), "done\n", "utf8");

  const text = [
    "fake worker complete",
    RESULT_START,
    JSON.stringify({
      status: "DONE",
      report: "Changed hello.txt to done and verified by fake worker.",
      artifacts: ["hello.txt"],
      verification: ["fake smoke check passed"],
    }),
    RESULT_END,
  ].join("\n");

  console.log(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 2 },
      stopReason: "end",
    },
  }));
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const extensionPath = path.join(repoRoot, "extensions", "pi-atp-orchestrator.ts");

function findPiRoot(): string {
  const candidates: string[] = [];
  if (process.env.PI_CODING_AGENT_ROOT) candidates.push(process.env.PI_CODING_AGENT_ROOT);
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(path.join(globalRoot, "@earendil-works", "pi-coding-agent"));
  } catch {
    // ignore
  }
  try {
    const piBin = execFileSync("command", ["-v", "pi"], { encoding: "utf8", shell: true }).trim();
    const cli = fs.realpathSync(piBin);
    candidates.push(path.dirname(path.dirname(cli)));
  } catch {
    // ignore
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error("Could not find @earendil-works/pi-coding-agent. Set PI_CODING_AGENT_ROOT=/path/to/pi-coding-agent.");
}

async function ensurePeerSymlinks(): Promise<string[]> {
  const piRoot = findPiRoot();
  const created: string[] = [];
  const links: Array<[string, string]> = [
    [path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"), piRoot],
    [path.join(repoRoot, "node_modules", "@earendil-works", "pi-ai"), path.join(piRoot, "node_modules", "@earendil-works", "pi-ai")],
    [path.join(repoRoot, "node_modules", "@earendil-works", "pi-tui"), path.join(piRoot, "node_modules", "@earendil-works", "pi-tui")],
    [path.join(repoRoot, "node_modules", "typebox"), path.join(piRoot, "node_modules", "typebox")],
  ];
  for (const [link, target] of links) {
    if (fs.existsSync(link)) continue;
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.symlink(target, link, "dir");
    created.push(link);
  }
  return created;
}

if (!process.env.PI_ATP_SMOKE_READY) {
  const createdLinks = await ensurePeerSymlinks();
  let status = 1;
  try {
    const child = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, PI_ATP_SMOKE_READY: "1" },
      stdio: "inherit",
    });
    status = child.status ?? 1;
  } finally {
    for (const link of createdLinks.reverse()) await fsp.rm(link, { force: true, recursive: true });
  }
  process.exit(status);
}

const { default: extension } = await import(extensionPath);
try {
  const tools: Record<string, any> = {};
  const messages: any[] = [];
  const pi = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand() {},
    registerMessageRenderer() {},
    on() {},
    sendMessage(message: any) { messages.push(message); },
    sendUserMessage() {},
  };
  extension(pi as any);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-atp-smoke-"));
  const planPath = path.join(tmp, ".atp.json");
  await fsp.writeFile(path.join(tmp, "hello.txt"), "before\n", "utf8");
  await fsp.writeFile(planPath, `${JSON.stringify({
    meta: { project_name: "smoke", version: "1.3", project_status: "ACTIVE" },
    nodes: {
      n1: {
        title: "Write hello",
        instruction: "Change hello.txt to exactly `done`. Run a minimal check.",
        dependencies: [],
        status: "READY",
        reasoning_effort: "minimal",
      },
    },
  }, null, 2)}\n`, "utf8");

  const ctx = { cwd: tmp, hasUI: false, ui: { notify() {} }, isIdle: () => true };
  const status1 = await tools.atp_status.execute("status", { planPath }, undefined, undefined, ctx);
  if (!status1.content[0].text.includes("READY=1")) throw new Error(`bad initial status: ${status1.content[0].text}`);

  const spawn = await tools.atp_spawn_ready.execute("spawn", { planPath, limit: 1 }, undefined, undefined, ctx);
  if (!spawn.content[0].text.includes("dispatched 1")) throw new Error(`spawn failed: ${spawn.content[0].text}`);

  const deadline = Date.now() + 5000;
  let graph: any;
  while (Date.now() < deadline) {
    graph = JSON.parse(await fsp.readFile(planPath, "utf8"));
    if (graph.nodes.n1.candidate_status) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (graph.nodes.n1.candidate_status !== "DONE") throw new Error(`candidate missing: ${JSON.stringify(graph.nodes.n1)}`);
  if ((await fsp.readFile(path.join(tmp, "hello.txt"), "utf8")) !== "done\n") throw new Error("worker did not edit hello.txt");
  if (!messages.some((m) => String(m.content || "").includes("ATP WORKER COMPLETE"))) throw new Error("completion message not delivered");

  const accept = await tools.atp_accept_node.execute("accept", { planPath, nodeId: "n1" }, undefined, undefined, ctx);
  if (!accept.content[0].text.includes("Accepted n1")) throw new Error(`accept failed: ${accept.content[0].text}`);
  graph = JSON.parse(await fsp.readFile(planPath, "utf8"));
  if (graph.nodes.n1.status !== "COMPLETED") throw new Error(`not completed: ${graph.nodes.n1.status}`);
  if (!graph.nodes.n1.report.includes("Changed hello.txt")) throw new Error("candidate report not copied");

  console.log(`PASS ${tmp}`);
} finally {
  // temp project is intentionally left in the PASS line for debugging.
}
