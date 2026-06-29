import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type AtpStatus = "LOCKED" | "READY" | "CLAIMED" | "COMPLETED" | "FAILED";
type WorkerResultStatus = "DONE" | "FAILED";

type AtpNode = {
	title: string;
	instruction: string;
	dependencies?: string[];
	status: AtpStatus;
	type?: string;
	context?: string;
	report?: string;
	artifacts?: string[];
	worker_id?: string;
	started_at?: string | null;
	completed_at?: string | null;
	lease_expires_at?: string | null;
	scope_children?: string[];
	future_state?: string | null;
	candidate_status?: WorkerResultStatus;
	candidate_report?: string;
	candidate_artifacts?: string[];
	candidate_verification?: string[];
	candidate_run_id?: string;
	candidate_completed_at?: string;
	judge_report?: string;
	[key: string]: unknown;
};

type AtpGraph = {
	meta?: { project_name?: string; version?: string; project_status?: string; [key: string]: unknown };
	nodes: Record<string, AtpNode>;
	[key: string]: unknown;
};

type ClaimedTask = {
	nodeId: string;
	title: string;
	assignmentBlock: string;
};

type DirectRun = {
	runId: string;
	nodeId: string;
	planPath: string;
	cwd: string;
	model?: string;
	dispatchedAt: number;
	completedAt?: number;
	status: "running" | "done" | "failed";
	result?: ParsedWorkerResult;
	error?: string;
};

type ParsedWorkerResult = {
	status: WorkerResultStatus;
	report: string;
	artifacts: string[];
	verification: string[];
	rawOutput: string;
};

const DEFAULT_PLAN_PATH = process.env.ATP_FILE || ".atp.json";
const EXTENSION_DIR = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const COMPLETION_TYPE = "pi-atp-orchestrator-worker-complete";
const RESULT_START = "ATP_WORKER_RESULT_JSON_START";
const RESULT_END = "ATP_WORKER_RESULT_JSON_END";
const ATP_TOOL_NAMES = [
	"atp_create_plan",
	"atp_status",
	"atp_activate",
	"atp_spawn_node",
	"atp_spawn_ready",
	"atp_accept_node",
	"atp_reject_node",
];
const runs = new Map<string, DirectRun>();

let latestPi: ExtensionAPI | undefined;
let orchestratorMode = false;
let defaultPlanPath = DEFAULT_PLAN_PATH;

function isoNow(): string {
	return new Date().toISOString();
}

function resolvePlanPath(cwd: string, input?: string): string {
	const raw = (input || defaultPlanPath || DEFAULT_PLAN_PATH).replace(/^@/, "");
	const expanded = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function parseGraph(raw: string, planPath: string): AtpGraph {
	const parsed = JSON.parse(raw) as AtpGraph;
	if (!parsed || typeof parsed !== "object" || !parsed.nodes || typeof parsed.nodes !== "object") {
		throw new Error(`ATP plan at ${planPath} is missing a top-level nodes object.`);
	}
	return parsed;
}

async function readGraph(planPath: string): Promise<AtpGraph> {
	return parseGraph(await fsp.readFile(planPath, "utf8"), planPath);
}

async function updateGraph<T>(planPath: string, mutate: (graph: AtpGraph) => T): Promise<T> {
	return withFileMutationQueue(planPath, async () => {
		const graph = await readGraph(planPath);
		const result = mutate(graph);
		await fsp.writeFile(planPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
		return result;
	});
}

function dependenciesSatisfied(nodes: Record<string, AtpNode>, deps: string[] = []): boolean {
	return deps.every((id) => nodes[id]?.status === "COMPLETED");
}

function nodeIsClosed(node: AtpNode): boolean {
	return node.future_state === "CLOSED" || node.future_state === "SUPERSEDED";
}

function clearWorker(node: AtpNode): void {
	delete node.worker_id;
	node.lease_expires_at = null;
}

function clearCandidate(node: AtpNode): void {
	delete node.candidate_status;
	delete node.candidate_report;
	delete node.candidate_artifacts;
	delete node.candidate_verification;
	delete node.candidate_run_id;
	delete node.candidate_completed_at;
}

function refreshReadyNodes(graph: AtpGraph): string[] {
	const ready: string[] = [];
	for (const [nodeId, node] of Object.entries(graph.nodes)) {
		if (node.type === "SCOPE" || nodeIsClosed(node) || node.status !== "LOCKED") continue;
		if (dependenciesSatisfied(graph.nodes, node.dependencies || [])) {
			node.status = "READY";
			ready.push(nodeId);
		}
	}
	return ready;
}

function maybeCompleteScopes(graph: AtpGraph): string[] {
	const closed: string[] = [];
	for (const [nodeId, node] of Object.entries(graph.nodes)) {
		if (node.type !== "SCOPE" || node.status === "COMPLETED" || node.status === "FAILED") continue;
		const children = Array.isArray(node.scope_children) ? node.scope_children : [];
		if (children.length > 0 && children.every((childId) => graph.nodes[childId]?.status === "COMPLETED")) {
			node.status = "COMPLETED";
			node.completed_at = isoNow();
			clearWorker(node);
			closed.push(nodeId);
		}
	}
	return closed;
}

function findChildren(nodes: Record<string, AtpNode>, nodeId: string): string[] {
	return Object.entries(nodes)
		.filter(([, node]) => Array.isArray(node.dependencies) && node.dependencies.includes(nodeId))
		.map(([id]) => id)
		.sort((a, b) => a.localeCompare(b));
}

function dependencyContext(nodes: Record<string, AtpNode>, node: AtpNode): string {
	const deps = node.dependencies || [];
	if (deps.length === 0) return "- No parent context; follow the instruction directly.";
	return deps
		.map((depId) => {
			const dep = nodes[depId];
			const report = typeof dep?.report === "string" && dep.report.trim() ? dep.report.trim() : "(no handoff provided)";
			return `- From ${depId} (${dep?.status || "UNKNOWN"}): ${report}`;
		})
		.join("\n");
}

function downstreamContext(nodes: Record<string, AtpNode>, nodeId: string): string {
	const children = findChildren(nodes, nodeId);
	if (children.length === 0) return "- No downstream children yet.";
	return children.map((childId) => `- ${childId} (${nodes[childId].status}): ${nodes[childId].title}`).join("\n");
}

function formatClaimedTask(nodeId: string, node: AtpNode, nodes: Record<string, AtpNode>): ClaimedTask {
	const staticContext = typeof node.context === "string" && node.context.trim() ? `STATIC CONTEXT:\n${node.context.trim()}\n` : "";
	return {
		nodeId,
		title: node.title,
		assignmentBlock: [
			`TASK ASSIGNED: ${nodeId} - ${node.title}`,
			`STATUS: ${node.status}`,
			"INSTRUCTION:",
			node.instruction.trim(),
			staticContext.trimEnd(),
			"CONTEXT FROM DEPENDENCIES:",
			dependencyContext(nodes, node),
			"DOWNSTREAM CHILDREN:",
			downstreamContext(nodes, nodeId),
		]
			.filter(Boolean)
			.join("\n"),
	};
}

function summarizeGraph(graph: AtpGraph): string {
	const counts: Record<string, number> = { READY: 0, LOCKED: 0, CLAIMED: 0, COMPLETED: 0, FAILED: 0 };
	const ready: string[] = [];
	const pendingJudge: string[] = [];
	for (const [id, node] of Object.entries(graph.nodes)) {
		counts[node.status] = (counts[node.status] || 0) + 1;
		if (node.status === "READY") ready.push(`${id}: ${node.title}`);
		if (node.status === "CLAIMED" && node.candidate_report) pendingJudge.push(`${id}: ${node.title}`);
	}
	return [
		`project: ${graph.meta?.project_name || "(unnamed)"} (${graph.meta?.project_status || "unknown"})`,
		`nodes: READY=${counts.READY} LOCKED=${counts.LOCKED} CLAIMED=${counts.CLAIMED} COMPLETED=${counts.COMPLETED} FAILED=${counts.FAILED}`,
		ready.length ? `ready:\n${ready.map((x) => `- ${x}`).join("\n")}` : "ready: none",
		pendingJudge.length ? `pending judge:\n${pendingJudge.map((x) => `- ${x}`).join("\n")}` : "pending judge: none",
	].join("\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writePromptFile(runId: string, content: string): Promise<{ dir: string; file: string }> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-atp-orchestrator-"));
	const file = path.join(dir, `${runId}.md`);
	await fsp.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

function workerSystemPrompt(): string {
	return [
		"You are an ATP Orchestrator Worker Agent.",
		"Execute exactly one already-claimed ATP node. Do not edit the ATP plan file; the pi extension updates it after your result.",
		"Read repo instructions first when relevant. Make the smallest correct code/config/doc changes for the node scope only.",
		"If the node is too broad, do not decompose the plan yourself; return FAILED with a clear decomposition recommendation.",
		"Run the smallest meaningful verification for the touched scope. If verification cannot run, explain why.",
		"Avoid chatter. Your final assistant message must end with this exact machine-readable block:",
		RESULT_START,
		'{"status":"DONE|FAILED","report":"what changed, why, verification, risks","artifacts":["repo/path"],"verification":["command or check result"]}',
		RESULT_END,
	].join("\n");
}

function workerUserPrompt(run: DirectRun, claimedTask: ClaimedTask): string {
	return [
		"Execute one ATP node now.",
		"",
		"### Runtime Context",
		`- project_root: ${run.cwd}`,
		`- plan_path: ${run.planPath}`,
		`- worker_run_id: ${run.runId}`,
		"",
		"### Claimed Task Packet",
		claimedTask.assignmentBlock,
	].join("\n");
}

async function runPiJsonPrompt(params: {
	cwd: string;
	runId: string;
	systemPrompt: string;
	userPrompt: string;
	model?: string;
	tools?: string[] | false;
	excludeTools?: string[];
}): Promise<string> {
	const prompt = await writePromptFile(params.runId, params.systemPrompt);
	const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", prompt.file];
	if (params.tools === false) args.push("--no-tools");
	else if (params.tools?.length) args.push("--tools", params.tools.join(","));
	if (params.excludeTools?.length) args.push("--exclude-tools", params.excludeTools.join(","));
	if (params.model) args.push("--model", params.model);
	args.push(params.userPrompt);

	let stderr = "";
	let output = "";
	let buffer = "";
	try {
		const invocation = getPiInvocation(args);
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, { cwd: params.cwd, stdio: ["ignore", "pipe", "pipe"] });
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) output = consumePiJsonLine(line, output);
			});
			proc.stderr.on("data", (data) => {
				stderr = `${stderr}${data.toString()}`.slice(-8000);
			});
			proc.on("close", (code) => {
				if (buffer.trim()) output = consumePiJsonLine(buffer, output);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));
		});
		if (exitCode !== 0 && !output.trim()) throw new Error(stderr.trim() || `pi subprocess exited ${exitCode}`);
		return output || stderr;
	} finally {
		await fsp.rm(prompt.dir, { recursive: true, force: true });
	}
}

async function runPiWorker(run: DirectRun, claimedTask: ClaimedTask): Promise<string> {
	return runPiJsonPrompt({
		cwd: run.cwd,
		runId: run.runId,
		systemPrompt: workerSystemPrompt(),
		userPrompt: workerUserPrompt(run, claimedTask),
		model: run.model,
		excludeTools: ATP_TOOL_NAMES,
	});
}

function consumePiJsonLine(line: string, currentOutput: string): string {
	if (!line.trim()) return currentOutput;
	try {
		const event = JSON.parse(line) as any;
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = (event.message.content || [])
				.map((part: any) => (part?.type === "text" ? part.text : ""))
				.filter(Boolean)
				.join("\n");
			return text || currentOutput;
		}
	} catch {
		return currentOutput;
	}
	return currentOutput;
}

function extractJsonObject(rawOutput: string): string {
	const trimmed = rawOutput.trim();
	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence?.[1]) return fence[1].trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
	return trimmed;
}

function parsePlanJson(rawOutput: string, planPath: string): AtpGraph {
	const graph = parseGraph(extractJsonObject(rawOutput), planPath);
	graph.meta = graph.meta || {};
	graph.meta.version = "1.3";
	graph.meta.project_status = "DRAFT";
	graph.meta.created_at = graph.meta.created_at || isoNow();
	for (const node of Object.values(graph.nodes)) {
		node.dependencies = node.dependencies || [];
		node.status = node.type === "SCOPE" || node.dependencies.length > 0 ? "LOCKED" : "READY";
		clearWorker(node);
		clearCandidate(node);
		delete node.completed_at;
		delete node.report;
		delete node.artifacts;
	}
	return graph;
}

async function createPlan(params: {
	cwd: string;
	planPath: string;
	brief: string;
	mode: "micro" | "macro";
	model?: string;
}): Promise<AtpGraph> {
	const adapter = [
		"### pi-atp-orchestrator planning adapter",
		"Final assistant message must be only the ATP JSON object. No markdown fences, no prose.",
		"Set meta.version to 1.3 and meta.project_status to DRAFT.",
		"Do not include runtime fields such as worker_id, started_at, completed_at, artifacts, or report.",
	].join("\n");
	const raw = await runPiJsonPrompt({
		cwd: params.cwd,
		runId: `atp-plan-${randomUUID().slice(0, 8)}`,
		systemPrompt: `${readArchitectPrompt(params.mode)}\n\n${adapter}`,
		userPrompt: params.brief,
		model: params.model,
		tools: ["read", "grep", "find", "ls"],
	});
	const graph = parsePlanJson(raw, params.planPath);
	await withFileMutationQueue(params.planPath, async () => {
		await fsp.mkdir(path.dirname(params.planPath), { recursive: true });
		await fsp.writeFile(params.planPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
	});
	return graph;
}

function parseWorkerResult(rawOutput: string): ParsedWorkerResult {
	const match = rawOutput.match(new RegExp(`${RESULT_START}\\s*([\\s\\S]*?)\\s*${RESULT_END}`));
	if (!match?.[1]) {
		return {
			status: "FAILED",
			report: `Worker did not return a parsable ATP result block. Raw tail:\n${rawOutput.slice(-4000)}`,
			artifacts: [],
			verification: [],
			rawOutput,
		};
	}
	try {
		const parsed = JSON.parse(match[1]) as { status?: string; report?: string; artifacts?: unknown; verification?: unknown };
		return {
			status: parsed.status === "DONE" ? "DONE" : "FAILED",
			report: parsed.report || "(no report)",
			artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((x): x is string => typeof x === "string") : [],
			verification: Array.isArray(parsed.verification)
				? parsed.verification.filter((x): x is string => typeof x === "string")
				: [],
			rawOutput,
		};
	} catch (error) {
		return {
			status: "FAILED",
			report: `Worker result JSON was invalid: ${error instanceof Error ? error.message : String(error)}`,
			artifacts: [],
			verification: [],
			rawOutput,
		};
	}
}

async function claimSpecificNode(planPath: string, nodeId: string, runId: string): Promise<ClaimedTask> {
	return updateGraph(planPath, (graph) => {
		if (graph.meta?.project_status !== "ACTIVE") throw new Error("ATP project is not ACTIVE. Call atp_activate first.");
		refreshReadyNodes(graph);
		const node = graph.nodes[nodeId];
		if (!node) throw new Error(`Unknown ATP node: ${nodeId}`);
		if (node.status !== "READY") throw new Error(`Node ${nodeId} is ${node.status}, not READY.`);
		node.status = "CLAIMED";
		node.worker_id = runId;
		node.started_at = isoNow();
		node.lease_expires_at = null;
		clearCandidate(node);
		return formatClaimedTask(nodeId, node, graph.nodes);
	});
}

async function claimNextReady(planPath: string, runId: string): Promise<ClaimedTask | null> {
	return updateGraph(planPath, (graph) => {
		if (graph.meta?.project_status !== "ACTIVE") throw new Error("ATP project is not ACTIVE. Call atp_activate first.");
		maybeCompleteScopes(graph);
		refreshReadyNodes(graph);
		const hit = Object.entries(graph.nodes)
			.filter(([, node]) => node.status === "READY" && node.type !== "SCOPE" && !nodeIsClosed(node))
			.sort((a, b) => (a[1].dependencies?.length || 0) - (b[1].dependencies?.length || 0) || a[0].localeCompare(b[0]))[0];
		if (!hit) return null;
		const [nodeId, node] = hit;
		node.status = "CLAIMED";
		node.worker_id = runId;
		node.started_at = isoNow();
		node.lease_expires_at = null;
		clearCandidate(node);
		return formatClaimedTask(nodeId, node, graph.nodes);
	});
}

function deliverCompletion(run: DirectRun): void {
	const pi = latestPi;
	if (!pi) return;
	const result = run.result;
	const content = [
		`[ATP WORKER COMPLETE — ${run.runId}]`,
		`Node: ${run.nodeId}`,
		`Plan: ${run.planPath}`,
		`Status: ${run.status}${result ? ` / ${result.status}` : ""}`,
		"",
		result?.report || run.error || "(no report)",
		"",
		"Judge this result. Inspect the diff or artifacts if needed. If it only needs a tiny, obvious fix (typing, fixture typo, import suffix, brittle assertion, narrow cleanup), patch it directly as orchestrator, rerun targeted verification, then accept. If it is incomplete, unsafe, broad, or unclear, call atp_reject_node or edit the ATP graph. Keep user-facing prose minimal.",
	].join("\n");
	try {
		void Promise.resolve(
			pi.sendMessage(
				{
					customType: COMPLETION_TYPE,
					content,
					display: true,
					details: { ...run, result },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			),
		).catch(() => undefined);
	} catch {
		// Session may have reloaded; no recovery needed for a local prototype.
	}
}

function dispatchRun(run: DirectRun, claimedTask: ClaimedTask): void {
	runs.set(run.runId, run);
	void (async () => {
		try {
			const raw = await runPiWorker(run, claimedTask);
			const result = parseWorkerResult(raw);
			run.result = result;
			run.status = result.status === "DONE" ? "done" : "failed";
			await updateGraph(run.planPath, (graph) => {
				const node = graph.nodes[run.nodeId];
				if (!node) return;
				node.candidate_status = result.status;
				node.candidate_report = result.report;
				node.candidate_artifacts = result.artifacts;
				node.candidate_verification = result.verification;
				node.candidate_run_id = run.runId;
				node.candidate_completed_at = isoNow();
			});
		} catch (error) {
			run.status = "failed";
			run.error = error instanceof Error ? error.message : String(error);
			await updateGraph(run.planPath, (graph) => {
				const node = graph.nodes[run.nodeId];
				if (!node) return;
				node.candidate_status = "FAILED";
				node.candidate_report = run.error || "Worker failed.";
				node.candidate_run_id = run.runId;
				node.candidate_completed_at = isoNow();
			});
		} finally {
			run.completedAt = Date.now();
			runs.set(run.runId, run);
			deliverCompletion(run);
		}
	})();
}

async function spawnClaimed(planPath: string, cwd: string, claimedTask: ClaimedTask, model?: string): Promise<DirectRun> {
	const run: DirectRun = {
		runId: claimedTask.nodeId ? `atp-${claimedTask.nodeId}-${randomUUID().slice(0, 8)}` : `atp-${randomUUID().slice(0, 8)}`,
		nodeId: claimedTask.nodeId,
		planPath,
		cwd,
		model,
		dispatchedAt: Date.now(),
		status: "running",
	};
	// The graph was claimed with a provisional id; keep the visible run id aligned.
	await updateGraph(planPath, (graph) => {
		const node = graph.nodes[claimedTask.nodeId];
		if (node?.status === "CLAIMED") node.worker_id = run.runId;
	});
	dispatchRun(run, claimedTask);
	return run;
}

function resolveBundledPromptPath(mode: "micro" | "macro"): string {
	const fileName = mode === "micro" ? "MICRO_ARCHITECT.md" : "ARCHITECT.md";
	const candidates = [
		process.env.PI_ATP_PROMPTS_DIR ? path.join(process.env.PI_ATP_PROMPTS_DIR, fileName) : "",
		path.resolve(EXTENSION_DIR, "..", "prompts", fileName),
		path.resolve(EXTENSION_DIR, "prompts", fileName),
	].filter(Boolean);
	const hit = candidates.find((candidate) => fs.existsSync(candidate));
	if (!hit) {
		throw new Error(
			`Missing bundled ATP prompt ${fileName}. Expected one of: ${candidates.join(", ")}. Reinstall pi-atp-orchestrator or set PI_ATP_PROMPTS_DIR.`,
		);
	}
	return hit;
}

function readArchitectPrompt(mode: "micro" | "macro"): string {
	return fs.readFileSync(resolveBundledPromptPath(mode), "utf8");
}

function orchestratorPrompt(): string {
	return [
		"### pi-atp-orchestrator Mode",
		"You are the judge/director, not a worker and not the architect unless explicitly planning.",
		"Use the pi-atp-orchestrator tools to create plans, inspect status, activate plans, spawn READY nodes, and accept/reject completed worker candidates.",
		"You may edit the ATP JSON freely when the graph needs replanning, splitting, rewiring, or cleanup.",
		"Prefer micro-nodes: workers should receive narrow, independently verifiable work. If a node is too broad, split it before spawning.",
		"After spawning background workers, do not fill time with narration. Wait for completion messages, then judge.",
		"When a worker completion arrives: inspect the candidate report/artifacts/diff as needed. For tiny, obvious issues (typing/fixture/import typo, brittle assertion, missing narrow cleanup), patch directly as orchestrator, rerun targeted verification, and then accept. Reject/retry only when the result is incomplete, unsafe, broad, unclear, or would require substantial rework. Keep prose minimal.",
	].join("\n");
}

const PlanPathParam = Type.Optional(Type.String({ description: "ATP plan path. Defaults to .atp.json or ATP_FILE." }));
const ModelParam = Type.Optional(Type.String({ description: "Optional pi model for worker subprocesses." }));

export default function piAtpOrchestratorExtension(pi: ExtensionAPI) {
	latestPi = pi;

	pi.registerMessageRenderer(COMPLETION_TYPE, (message, _options, theme) => {
		return new Text(theme.fg("warning", String(message.content)), 0, 0);
	});

	pi.on("before_agent_start", async (event) => {
		if (!orchestratorMode) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt()}` };
	});

	pi.registerCommand("atp-plan", {
		description: "Create an ATP plan with the bundled ARCHITECT/MICRO_ARCHITECT prompts: /atp-plan [micro|macro] <brief>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const maybeMode = parts[0]?.toLowerCase();
			const mode = maybeMode === "macro" || maybeMode === "architect" ? "macro" : "micro";
			const brief = (mode === "micro" && maybeMode !== "micro" ? args : parts.slice(1).join(" ")).trim();
			if (!brief) {
				ctx.ui.notify("Usage: /atp-plan [micro|macro] <work item>", "warning");
				return;
			}
			orchestratorMode = true;
			ctx.ui.notify(`Creating ATP ${mode} plan...`, "info");
			try {
				const planPath = resolvePlanPath(ctx.cwd, defaultPlanPath);
				const graph = await createPlan({ cwd: ctx.cwd, planPath, brief, mode });
				pi.sendMessage({
					customType: COMPLETION_TYPE,
					content: `Created ATP ${mode} plan: ${planPath}\n\n${summarizeGraph(graph)}\n\nReview it, then call atp_activate when ready.`,
					display: true,
				});
			} catch (error) {
				ctx.ui.notify(`ATP plan failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("atp-on", {
		description: "Enable ATP orchestrator/judge prompt. Optional arg sets default plan path.",
		handler: async (args, ctx) => {
			if (args.trim()) defaultPlanPath = args.trim();
			orchestratorMode = true;
			ctx.ui.notify(`ATP orchestrator mode on (${defaultPlanPath})`, "info");
		},
	});

	pi.registerCommand("atp-off", {
		description: "Disable ATP orchestrator prompt.",
		handler: async (_args, ctx) => {
			orchestratorMode = false;
			ctx.ui.notify("ATP orchestrator mode off", "info");
		},
	});

	pi.registerCommand("atp-status", {
		description: "Show ATP plan status.",
		handler: async (args, ctx) => {
			const planPath = resolvePlanPath(ctx.cwd, args.trim() || undefined);
			const graph = await readGraph(planPath);
			pi.sendMessage({ customType: COMPLETION_TYPE, content: summarizeGraph(graph), display: true });
		},
	});

	pi.registerTool({
		name: "atp_create_plan",
		label: "ATP Create Plan",
		description: "Run the bundled ARCHITECT or MICRO_ARCHITECT prompt in a separate pi subprocess and write an ATP v1.3 DRAFT plan.",
		promptSnippet: "Create an ATP v1.3 DRAFT plan using the bundled architect prompts.",
		promptGuidelines: ["Use atp_create_plan for initial ATP planning; use micro mode unless the work needs macro commits/PR-sized nodes."],
		parameters: Type.Object({
			planPath: PlanPathParam,
			brief: Type.String({ description: "Work item to plan." }),
			mode: Type.Optional(StringEnum(["micro", "macro"] as const, { default: "micro" })),
			model: ModelParam,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const mode = params.mode || "micro";
			const graph = await createPlan({ cwd: ctx.cwd, planPath, brief: params.brief, mode, model: params.model });
			orchestratorMode = true;
			return {
				content: [{ type: "text", text: `Created ATP ${mode} plan at ${planPath}.\n\n${summarizeGraph(graph)}` }],
				details: { planPath, graph },
			};
		},
	});

	pi.registerTool({
		name: "atp_status",
		label: "ATP Status",
		description: "Read an ATP plan and summarize READY, CLAIMED, COMPLETED, FAILED, and pending-judge nodes.",
		promptSnippet: "Inspect ATP graph execution status.",
		promptGuidelines: ["Use atp_status before spawning or judging pi-atp-orchestrator workers."],
		parameters: Type.Object({ planPath: PlanPathParam }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const graph = await readGraph(planPath);
			return { content: [{ type: "text", text: summarizeGraph(graph) }], details: { planPath, graph } };
		},
	});

	pi.registerTool({
		name: "atp_activate",
		label: "ATP Activate",
		description: "Set an ATP plan project_status to ACTIVE and refresh READY nodes.",
		promptSnippet: "Activate an ATP plan before spawning workers.",
		promptGuidelines: ["Use atp_activate after the ATP plan is written and reviewed, before atp_spawn_ready."],
		parameters: Type.Object({ planPath: PlanPathParam }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const text = await updateGraph(planPath, (graph) => {
				graph.meta = graph.meta || {};
				graph.meta.project_status = "ACTIVE";
				const scopes = maybeCompleteScopes(graph);
				const ready = refreshReadyNodes(graph);
				return `Activated ${planPath}. READY refreshed: ${ready.length}${scopes.length ? `, scopes completed: ${scopes.join(", ")}` : ""}.`;
			});
			return { content: [{ type: "text", text }], details: { planPath } };
		},
	});

	pi.registerTool({
		name: "atp_spawn_node",
		label: "ATP Spawn Node",
		description: "Claim one READY ATP node and run a non-blocking worker subprocess. Completion is reported back to the orchestrator for judging.",
		promptSnippet: "Spawn a background worker for one READY ATP node.",
		promptGuidelines: [
			"Use atp_spawn_node only for narrow ATP nodes with non-overlapping write scope.",
			"After atp_spawn_node returns, do not narrate progress; wait for the completion message and judge it.",
		],
		parameters: Type.Object({
			planPath: PlanPathParam,
			nodeId: Type.String({ description: "READY node id to claim and execute." }),
			model: ModelParam,
			cwd: Type.Optional(Type.String({ description: "Worker cwd. Defaults to current pi cwd." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const runId = `atp-${params.nodeId}-${randomUUID().slice(0, 8)}`;
			const claimed = await claimSpecificNode(planPath, params.nodeId, runId);
			const run: DirectRun = {
				runId,
				nodeId: claimed.nodeId,
				planPath,
				cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
				model: params.model,
				dispatchedAt: Date.now(),
				status: "running",
			};
			dispatchRun(run, claimed);
			return {
				content: [{ type: "text", text: `dispatched ${run.runId} for ${claimed.nodeId}. Completion will report back for judging.` }],
				details: run,
			};
		},
	});

	pi.registerTool({
		name: "atp_spawn_ready",
		label: "ATP Spawn Ready",
		description: "Claim up to N READY ATP nodes and run non-blocking worker subprocesses. Each completion reports back to the orchestrator for judging.",
		promptSnippet: "Spawn background workers for READY ATP nodes.",
		promptGuidelines: [
			"Use atp_spawn_ready to keep pi-atp-orchestrator workers busy, but keep parallelism low unless node write scopes are clearly independent.",
			"After atp_spawn_ready returns, keep the response minimal and wait for worker completion messages.",
		],
		parameters: Type.Object({
			planPath: PlanPathParam,
			limit: Type.Optional(Type.Number({ description: "Max workers to spawn. Default 1, max 8.", default: 1 })),
			model: ModelParam,
			cwd: Type.Optional(Type.String({ description: "Worker cwd. Defaults to current pi cwd." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const limit = Math.max(1, Math.min(8, Math.floor(params.limit || 1)));
			const dispatched: DirectRun[] = [];
			for (let i = 0; i < limit; i++) {
				const provisional = `atp-${randomUUID().slice(0, 8)}`;
				const claimed = await claimNextReady(planPath, provisional);
				if (!claimed) break;
				dispatched.push(
					await spawnClaimed(planPath, params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd, claimed, params.model),
				);
			}
			const text = dispatched.length
				? `dispatched ${dispatched.length} ATP worker(s):\n${dispatched.map((run) => `- ${run.runId} -> ${run.nodeId}`).join("\n")}`
				: "No READY ATP nodes available.";
			return { content: [{ type: "text", text }], details: { planPath, dispatched } };
		},
	});

	pi.registerTool({
		name: "atp_accept_node",
		label: "ATP Accept Node",
		description: "Judge-approve a completed worker candidate, mark the node COMPLETED, and refresh downstream READY nodes.",
		promptSnippet: "Accept a worker result and unblock dependent ATP nodes.",
		promptGuidelines: [
			"Use atp_accept_node only after judging the worker report/artifacts are acceptable.",
			"It is acceptable to make tiny, obvious orchestrator fixes before accepting, provided you inspect the diff and rerun relevant verification.",
		],
		parameters: Type.Object({
			planPath: PlanPathParam,
			nodeId: Type.String(),
			report: Type.Optional(Type.String({ description: "Optional judge-approved report override. Defaults to candidate_report." })),
			artifacts: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const text = await updateGraph(planPath, (graph) => {
				const node = graph.nodes[params.nodeId];
				if (!node) throw new Error(`Unknown ATP node: ${params.nodeId}`);
				node.status = "COMPLETED";
				node.completed_at = isoNow();
				node.report = params.report || node.candidate_report || node.report || "Accepted by ATP orchestrator.";
				node.artifacts = params.artifacts || node.candidate_artifacts || node.artifacts || [];
				clearWorker(node);
				clearCandidate(node);
				const scopes = maybeCompleteScopes(graph);
				const ready = refreshReadyNodes(graph);
				return `Accepted ${params.nodeId}. Newly READY: ${ready.join(", ") || "none"}${scopes.length ? `. Scopes completed: ${scopes.join(", ")}` : ""}`;
			});
			return { content: [{ type: "text", text }], details: { planPath, nodeId: params.nodeId } };
		},
	});

	pi.registerTool({
		name: "atp_reject_node",
		label: "ATP Reject Node",
		description: "Reject a worker candidate. Either retry by returning the node to READY, or mark it FAILED.",
		promptSnippet: "Reject or retry an ATP worker result.",
		promptGuidelines: [
			"Use atp_reject_node when a worker result is incomplete, unsafe, broad, unclear, or needs retry/splitting.",
			"Do not reject just to outsource a tiny deterministic fix; patch small typing/fixture/import/assertion issues directly as orchestrator when the scope is clear.",
		],
		parameters: Type.Object({
			planPath: PlanPathParam,
			nodeId: Type.String(),
			reason: Type.String(),
			retry: Type.Optional(Type.Boolean({ description: "If true, return node to READY. Otherwise mark FAILED.", default: true })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const planPath = resolvePlanPath(ctx.cwd, params.planPath);
			const text = await updateGraph(planPath, (graph) => {
				const node = graph.nodes[params.nodeId];
				if (!node) throw new Error(`Unknown ATP node: ${params.nodeId}`);
				node.judge_report = params.reason;
				if (params.retry ?? true) {
					node.status = "READY";
					node.started_at = null;
				} else {
					node.status = "FAILED";
					node.completed_at = isoNow();
					node.report = params.reason;
				}
				clearWorker(node);
				clearCandidate(node);
				refreshReadyNodes(graph);
				return `${params.retry ?? true ? "Rejected and queued retry for" : "Rejected and failed"} ${params.nodeId}.`;
			});
			return { content: [{ type: "text", text }], details: { planPath, nodeId: params.nodeId } };
		},
	});
}
