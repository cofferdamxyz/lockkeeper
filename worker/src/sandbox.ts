import { DurableObject } from "cloudflare:workers";

import type { LockkeeperEnv } from "./env";
import type { Outbound } from "./outbound";
import { agentPrompt, resolverPrompt } from "./prompt";
import { finishTask } from "./tasks";

type ContainerApi = NonNullable<DurableObjectState["container"]>;

interface SandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly Outbound: LoopbackForExport<typeof Outbound> };
}

export const SNAPSHOT_SETTING = "agent_snapshot";
export const MANAGED_IMAGE = "cloudflare/debian-trixie";

const WORKSPACE = "/workspace";
const REPO_DIR = "/workspace/repo";
const PROJECT_DIR = "/workspace/project";
const TASK_DIR = "/workspace/task";
const EVENTS_PATH = `${TASK_DIR}/events.jsonl`;
const STDERR_PATH = `${TASK_DIR}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIR}/exit-code`;
const PID_PATH = `${TASK_DIR}/pid`;
const PROMPT_PATH = `${TASK_DIR}/prompt.md`;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
const CHECK_INTERVAL_MS = 30 * 1_000;
const GIT_IDENTITY = ["-c", "user.name=Lockkeeper agent", "-c", "user.email=agent@lockkeeper.invalid"];

// exec() does not inherit start() env. Every command that speaks HTTPS trusts the intercept CA.
const TRUST_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
  npm_config_cafile: CA_PATH,
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/root",
  CI: "1",
};

// The agent runs in the background so it survives the request that started it.
const TASK_SCRIPT = `"$@" >${EVENTS_PATH} 2>${STDERR_PATH}
printf '%s\\n' "$?" >${EXIT_CODE_PATH}.tmp && mv ${EXIT_CODE_PATH}.tmp ${EXIT_CODE_PATH}`;

export interface RunTaskParams {
  taskId: string;
  project: string;
  forkRepo: string;
  forkRemote: string;
  goal: string;
  brief: string;
  conventionsPath: string;
  testCommand: string;
  model: string;
  maxMinutes: number;
  gateway: { accountId: string; gatewayId: string };
}

interface StoredTask extends RunTaskParams {
  kind: "agent" | "resolve" | "bootstrap";
  sandbox: string;
  baseSha: string;
  startedAt: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MergeAttempt {
  conflict: boolean;
  conflictedFiles: string[];
  testsOk: boolean | null;
  mergeSha: string | null;
  mainBefore: string;
  output: string;
}

export type ResolveStatus =
  | { state: "none" }
  | { state: "running" }
  | { state: "failed"; error: string }
  | { state: "succeeded"; summary: string; testsOk: boolean; mergeSha: string | null };

/**
 * One Durable Object per sandbox. Agent sandboxes are named `agent-<task>`; each project has one
 * merge sandbox named `merge-<project>` that keeps a clone of the project repository.
 * The container is Cloudflare's managed Debian image restored from the bootstrap snapshot, so no
 * Docker build is needed anywhere.
 */
export class AgentSandbox extends DurableObject<LockkeeperEnv> {
  readonly #container: ContainerApi;
  readonly #ctx: SandboxState;

  constructor(ctx: DurableObjectState, env: LockkeeperEnv) {
    super(ctx, env);
    this.#ctx = ctx as SandboxState;
    const container = ctx.container;
    if (container === undefined) throw new Error("Container attachment is unavailable");
    this.#container = container;
    if (container.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  // ---------------------------------------------------------------- bootstrap

  /**
   * Build the agent base once: start the managed image with Internet access, install git, ripgrep
   * and Claude Code in the background, then (from the alarm) snapshot the filesystem and store the
   * snapshot id in settings. Progress is in the `bootstrap_status` setting.
   */
  async startBootstrap(claudeCodeVersion: string): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
    this.#container.start({ image: MANAGED_IMAGE, enableInternet: true, instance: "standard-1", entrypoint: ["sleep", "infinity"] });
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    await this.#waitReady();
    await this.#run(["sh", "-c", `rm -rf ${TASK_DIR} && mkdir -p ${TASK_DIR} ${WORKSPACE}`], "/", {});
    const script = [
      "set -eux",
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update",
      "apt-get install -y --no-install-recommends bash ca-certificates git ripgrep curl procps",
      "rm -rf /var/lib/apt/lists/*",
      `npm install --global @anthropic-ai/claude-code@${claudeCodeVersion}`,
      "git config --system init.defaultBranch main",
      "git config --system advice.detachedHead false",
      "claude --version",
      "node --version && git --version",
    ].join("\n");
    await this.#writeFile(`${TASK_DIR}/bootstrap.sh`, script);
    const proc = await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "bootstrap", "bash", `${TASK_DIR}/bootstrap.sh`], {
      cwd: "/",
      env: { HOME: "/root" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await this.#writeFile(PID_PATH, String(proc.pid));
    const stored: StoredTask = {
      kind: "bootstrap",
      sandbox: "bootstrap",
      baseSha: "",
      startedAt: Date.now(),
      taskId: "bootstrap",
      project: "",
      forkRepo: "",
      forkRemote: "",
      goal: claudeCodeVersion,
      brief: "",
      conventionsPath: "",
      testCommand: "",
      model: "",
      maxMinutes: 20,
      gateway: { accountId: "", gatewayId: "" },
    };
    this.ctx.storage.kv.put("task", JSON.stringify(stored));
    await this.#setSetting("bootstrap_status", "installing");
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }

  async #concludeBootstrap(task: StoredTask, exitCode: number | null): Promise<void> {
    try {
      const log = ((await this.#readOptional(EVENTS_PATH)) ?? "") + ((await this.#readOptional(STDERR_PATH)) ?? "");
      if (exitCode !== 0) {
        await this.#setSetting("bootstrap_status", `failed (${exitCode ?? "timeout"}): ${log.slice(-3000)}`);
        return;
      }
      await this.#run(["sh", "-c", `rm -rf ${TASK_DIR}`], "/", {});
      const snapshot = await this.#container.snapshotContainer({ name: `lockkeeper-agent-${task.goal}` });
      await this.#setSetting(SNAPSHOT_SETTING, snapshot.id);
      await this.#setSetting("bootstrap_status", `ready: snapshot ${snapshot.id} (claude-code ${task.goal})`);
    } finally {
      if (this.#container.running) await this.#container.destroy();
    }
  }

  async #setSetting(key: string, value: string): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
      .bind(key, value)
      .run();
  }

  // ---------------------------------------------------------------- agent tasks

  /** Clone the fork, write the prompt, start Claude Code in the background. */
  async runTask(params: RunTaskParams): Promise<{ baseSha: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const sandbox = `agent-${params.taskId}`;
      await this.#ensureStarted(sandbox);
      await this.#run(["sh", "-c", `rm -rf ${REPO_DIR} ${TASK_DIR} && mkdir -p ${TASK_DIR}`], WORKSPACE, {});
      const clone = await this.#run(["git", "clone", "--branch", "main", "--", params.forkRemote, REPO_DIR], WORKSPACE, TRUST_ENV);
      if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr.slice(-2000)}`);
      const baseSha = (await this.#run(["git", "rev-parse", "HEAD"], REPO_DIR, {})).stdout.trim();
      const conventions = await this.#readOptional(`${REPO_DIR}/${params.conventionsPath}`);
      const prompt = agentPrompt({
        taskId: params.taskId,
        goal: params.goal,
        conventions,
        brief: params.brief,
        testCommand: params.testCommand,
      });
      await this.#writeFile(PROMPT_PATH, prompt);
      await this.#startClaude(prompt, params.model, params.gateway, REPO_DIR);
      const stored: StoredTask = { ...params, kind: "agent", sandbox, baseSha, startedAt: Date.now() };
      this.ctx.storage.kv.put("task", JSON.stringify(stored));
      await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
      return { baseSha };
    });
  }

  /** Called by the alarm while a task runs; finishes it when the agent exits. */
  async alarm(): Promise<void> {
    const raw = this.ctx.storage.kv.get<string>("task");
    if (raw === undefined) return;
    const task = JSON.parse(raw) as StoredTask;
    if (task.kind === "resolve") return; // the Workflow polls resolveStatus()
    if (!this.#container.running) {
      this.ctx.storage.kv.delete("task");
      if (task.kind === "bootstrap") await this.#setSetting("bootstrap_status", "failed: container stopped during install");
      else await this.#conclude(task, { state: "lost" });
      return;
    }
    const exit = await this.#readOptional(EXIT_CODE_PATH);
    if (exit === null) {
      const elapsedMin = (Date.now() - task.startedAt) / 60_000;
      if (elapsedMin > task.maxMinutes) {
        const pid = (await this.#readOptional(PID_PATH))?.trim();
        if (pid) await this.#run(["sh", "-c", `kill -TERM ${pid} 2>/dev/null; sleep 2; kill -KILL ${pid} 2>/dev/null; true`], "/", {});
        this.ctx.storage.kv.delete("task");
        if (task.kind === "bootstrap") await this.#concludeBootstrap(task, null);
        else await this.#conclude(task, { state: "timeout" });
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
      return;
    }
    this.ctx.storage.kv.delete("task");
    if (task.kind === "bootstrap") {
      await this.#concludeBootstrap(task, Number.parseInt(exit, 10));
      return;
    }
    await this.#conclude(task, { state: "exited", exitCode: Number.parseInt(exit, 10) });
  }

  async readTail(lines = 60): Promise<string> {
    if (!this.#container.running) return "";
    const r = await this.#run(["sh", "-c", `tail -n ${lines} ${EVENTS_PATH} 2>/dev/null || true`], "/", {});
    return r.stdout;
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("task");
    if (this.#container.running) await this.#container.destroy();
  }

  // ---------------------------------------------------------------- merge sandbox

  /** Make sure the merge sandbox holds a current clone of the project repository. */
  async ensureProjectClone(p: { project: string; remote: string }): Promise<{ head: string }> {
    const sandbox = `merge-${p.project}`;
    await this.#ensureStarted(sandbox);
    const exists = await this.#run(["sh", "-c", `test -d ${PROJECT_DIR}/.git`], WORKSPACE, {});
    if (exists.exitCode !== 0) {
      const clone = await this.#run(["git", "clone", "--", p.remote, PROJECT_DIR], WORKSPACE, TRUST_ENV);
      if (clone.exitCode !== 0) throw new Error(`project clone failed: ${clone.stderr.slice(-2000)}`);
    } else {
      const fetch = await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; git fetch origin && git checkout -q -B main origin/main"], PROJECT_DIR, TRUST_ENV);
      if (fetch.exitCode !== 0) throw new Error(`project fetch failed: ${fetch.stderr.slice(-2000)}`);
    }
    const head = (await this.#run(["git", "rev-parse", "HEAD"], PROJECT_DIR, {})).stdout.trim();
    return { head };
  }

  /** Merge a task's fork onto a fresh `merge` branch and run the tests. Nothing is pushed. */
  async mergeTask(p: {
    taskId: string;
    forkRemote: string;
    testCommand: string;
    message: string;
  }): Promise<MergeAttempt> {
    const mainBefore = (await this.#run(["git", "rev-parse", "origin/main"], PROJECT_DIR, {})).stdout.trim();
    const remote = `fork-${p.taskId}`;
    await this.#run(["sh", "-c", `git remote remove ${remote} 2>/dev/null; git remote add ${remote} "$1"`, "x", p.forkRemote], PROJECT_DIR, {});
    const fetch = await this.#run(["git", "fetch", remote, "main"], PROJECT_DIR, TRUST_ENV);
    if (fetch.exitCode !== 0) throw new Error(`fork fetch failed: ${fetch.stderr.slice(-2000)}`);
    await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; git checkout -q -B merge origin/main"], PROJECT_DIR, {});
    await this.#writeFile(`${TASK_DIR}/merge-message.txt`, p.message);
    const merge = await this.#run(
      ["git", ...GIT_IDENTITY, "merge", "--no-ff", "-F", `${TASK_DIR}/merge-message.txt`, `${remote}/main`],
      PROJECT_DIR,
      {},
    );
    if (merge.exitCode !== 0) {
      const conflicted = (await this.#run(["git", "diff", "--name-only", "--diff-filter=U"], PROJECT_DIR, {})).stdout
        .split("\n")
        .filter(Boolean);
      if (conflicted.length === 0) {
        await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; true"], PROJECT_DIR, {});
        throw new Error(`merge failed: ${merge.stderr.slice(-2000)}`);
      }
      return { conflict: true, conflictedFiles: conflicted, testsOk: null, mergeSha: null, mainBefore, output: merge.stdout + merge.stderr };
    }
    const tests = await this.#run(["sh", "-c", p.testCommand], PROJECT_DIR, TRUST_ENV);
    const mergeSha = (await this.#run(["git", "rev-parse", "HEAD"], PROJECT_DIR, {})).stdout.trim();
    return {
      conflict: false,
      conflictedFiles: [],
      testsOk: tests.exitCode === 0,
      mergeSha,
      mainBefore,
      output: (merge.stdout + tests.stdout + tests.stderr).slice(-6000),
    };
  }

  /** Start Claude Code on the conflicted merge in the background. Poll with resolveStatus(). */
  async startResolve(p: {
    taskId: string;
    project: string;
    candidateGoal: string;
    mergedGoals: string[];
    conflictedFiles: string[];
    testCommand: string;
    model: string;
    maxMinutes: number;
    gateway: { accountId: string; gatewayId: string };
  }): Promise<void> {
    await this.#run(["sh", "-c", `rm -rf ${TASK_DIR} && mkdir -p ${TASK_DIR}`], WORKSPACE, {});
    const prompt = resolverPrompt(p);
    await this.#writeFile(PROMPT_PATH, prompt);
    await this.#startClaude(prompt, p.model, p.gateway, PROJECT_DIR);
    const stored: StoredTask = {
      kind: "resolve",
      sandbox: `merge-${p.project}`,
      baseSha: "",
      startedAt: Date.now(),
      taskId: p.taskId,
      project: p.project,
      forkRepo: "",
      forkRemote: "",
      goal: p.candidateGoal,
      brief: "",
      conventionsPath: "",
      testCommand: p.testCommand,
      model: p.model,
      maxMinutes: p.maxMinutes,
      gateway: p.gateway,
    };
    this.ctx.storage.kv.put("task", JSON.stringify(stored));
    // No alarm: the Workflow polls resolveStatus() and the container stays awake on each poll.
  }

  async resolveStatus(): Promise<ResolveStatus> {
    const raw = this.ctx.storage.kv.get<string>("task");
    if (raw === undefined) return { state: "none" };
    const task = JSON.parse(raw) as StoredTask;
    if (task.kind !== "resolve") return { state: "none" };
    if (!this.#container.running) return { state: "failed", error: "merge sandbox stopped during resolution" };
    const exit = await this.#readOptional(EXIT_CODE_PATH);
    if (exit === null) {
      if ((Date.now() - task.startedAt) / 60_000 > task.maxMinutes) {
        const pid = (await this.#readOptional(PID_PATH))?.trim();
        if (pid) await this.#run(["sh", "-c", `kill -KILL ${pid} 2>/dev/null; true`], "/", {});
        this.ctx.storage.kv.delete("task");
        await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; git checkout -q -B main origin/main"], PROJECT_DIR, {});
        return { state: "failed", error: "resolver timed out" };
      }
      return { state: "running" };
    }
    this.ctx.storage.kv.delete("task");
    const outcome = await this.#claudeOutcome(Number.parseInt(exit, 10));
    if (outcome.isError) {
      await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; git checkout -q -B main origin/main"], PROJECT_DIR, {});
      return { state: "failed", error: outcome.error ?? "resolver failed" };
    }
    // The resolver must have committed; an unfinished merge means it did not.
    const unmerged = (await this.#run(["git", "diff", "--name-only", "--diff-filter=U"], PROJECT_DIR, {})).stdout.trim();
    const inProgress = await this.#run(["sh", "-c", "test -f .git/MERGE_HEAD"], PROJECT_DIR, {});
    if (unmerged || inProgress.exitCode === 0) {
      await this.#run(["sh", "-c", `git ${GIT_IDENTITY.join(" ")} commit -q --no-edit -a || true`], PROJECT_DIR, {});
    }
    const stillMerging = await this.#run(["sh", "-c", "test -f .git/MERGE_HEAD"], PROJECT_DIR, {});
    if (stillMerging.exitCode === 0) {
      await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; git checkout -q -B main origin/main"], PROJECT_DIR, {});
      return { state: "failed", error: "resolver left the merge unfinished" };
    }
    const tests = await this.#run(["sh", "-c", task.testCommand], PROJECT_DIR, TRUST_ENV);
    const mergeSha = (await this.#run(["git", "rev-parse", "HEAD"], PROJECT_DIR, {})).stdout.trim();
    return { state: "succeeded", summary: outcome.result ?? "", testsOk: tests.exitCode === 0, mergeSha };
  }

  /** Push the prepared merge branch to the project's main. The token is injected by the gateway. */
  async pushMerge(): Promise<{ mainAfter: string }> {
    const push = await this.#run(["git", "push", "origin", "merge:main"], PROJECT_DIR, TRUST_ENV);
    if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr.slice(-2000)}`);
    await this.#run(["sh", "-c", "git fetch origin && git checkout -q -B main origin/main"], PROJECT_DIR, TRUST_ENV);
    const mainAfter = (await this.#run(["git", "rev-parse", "HEAD"], PROJECT_DIR, {})).stdout.trim();
    return { mainAfter };
  }

  /** After a resolved conflict, fast-forward the fork's main to the resolved merge so the next round merges cleanly. */
  async pushMergeToFork(p: { taskId: string }): Promise<void> {
    const push = await this.#run(["git", "push", `fork-${p.taskId}`, "merge:main"], PROJECT_DIR, TRUST_ENV);
    if (push.exitCode !== 0) throw new Error(`push to fork failed: ${push.stderr.slice(-2000)}`);
    await this.#run(["sh", "-c", "git checkout -q -B main origin/main"], PROJECT_DIR, {});
  }

  async abortMerge(): Promise<void> {
    await this.#run(["sh", "-c", "git merge --abort 2>/dev/null; git checkout -q -B main origin/main; git branch -D merge 2>/dev/null; true"], PROJECT_DIR, {});
  }

  /** Mirror main to a GitHub remote over HTTPS; the gateway must allow github.com for this sandbox. */
  async mirror(p: { remote: string }): Promise<CommandResult> {
    return this.#run(["git", "push", "--force-with-lease", p.remote, "main:main"], PROJECT_DIR, TRUST_ENV);
  }

  // ---------------------------------------------------------------- internals

  async #conclude(task: StoredTask, how: { state: "lost" } | { state: "timeout" } | { state: "exited"; exitCode: number }): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("task");
    if (task.kind !== "agent") return;
    try {
      if (how.state === "lost") {
        await finishTask(this.env, { taskId: task.taskId, ok: false, error: "sandbox stopped before the agent finished" });
        return;
      }
      const outcome = how.state === "timeout" ? { isError: true, error: `agent exceeded ${task.maxMinutes} minutes`, result: undefined, costUsd: undefined } : await this.#claudeOutcome(how.exitCode);
      const tail = await this.readTail(80);
      // Harvest whatever the agent left, even after a failure, so the ledger shows the work.
      await this.#run(["sh", "-c", `git ${GIT_IDENTITY.join(" ")} add -A && git ${GIT_IDENTITY.join(" ")} commit -q -m "Lockkeeper: uncommitted changes left by the agent" || true`], REPO_DIR, {});
      const ahead = Number.parseInt((await this.#run(["git", "rev-list", "--count", `${task.baseSha}..HEAD`], REPO_DIR, {})).stdout.trim() || "0", 10);
      if (outcome.isError) {
        await finishTask(this.env, { taskId: task.taskId, ok: false, error: outcome.error ?? "agent failed", eventsTail: tail, costUsd: outcome.costUsd });
        return;
      }
      if (ahead === 0) {
        await finishTask(this.env, { taskId: task.taskId, ok: false, error: "the agent made no changes", eventsTail: tail, costUsd: outcome.costUsd, summary: outcome.result });
        return;
      }
      const tests = await this.#run(["sh", "-c", task.testCommand], REPO_DIR, TRUST_ENV);
      const push = await this.#run(["git", "push", "origin", "HEAD:main"], REPO_DIR, TRUST_ENV);
      if (push.exitCode !== 0) {
        await finishTask(this.env, { taskId: task.taskId, ok: false, error: `push failed: ${push.stderr.slice(-1500)}`, eventsTail: tail, costUsd: outcome.costUsd });
        return;
      }
      const range = `${task.baseSha}..HEAD`;
      const headSha = (await this.#run(["git", "rev-parse", "HEAD"], REPO_DIR, {})).stdout.trim();
      const files = (await this.#run(["git", "diff", "--name-only", range], REPO_DIR, {})).stdout.split("\n").filter(Boolean);
      const diffstat = (await this.#run(["git", "diff", "--stat", range], REPO_DIR, {})).stdout;
      const diff = (await this.#run(["sh", "-c", `git diff ${range} | head -c 65536`], REPO_DIR, {})).stdout;
      const commits = (await this.#run(["git", "log", "--format=%s", range], REPO_DIR, {})).stdout.split("\n").filter(Boolean);
      await finishTask(this.env, {
        taskId: task.taskId,
        ok: true,
        headSha,
        files,
        diffstat,
        diff,
        commits,
        testsOk: tests.exitCode === 0,
        testOutput: (tests.stdout + tests.stderr).slice(-3000),
        summary: outcome.result,
        costUsd: outcome.costUsd,
        eventsTail: tail,
      });
    } finally {
      if (this.#container.running) await this.#container.destroy();
    }
  }

  async #claudeOutcome(exitCode: number): Promise<{ isError: boolean; error?: string; result?: string; costUsd?: number }> {
    const events = (await this.#readOptional(EVENTS_PATH)) ?? "";
    let last: { subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number } | undefined;
    for (const line of events.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number };
        if (e.type === "result") last = e;
      } catch {
        // partial line
      }
    }
    if (last === undefined) {
      const stderr = (await this.#readOptional(STDERR_PATH)) ?? "";
      return { isError: true, error: `claude exited with ${exitCode}: ${stderr.slice(-2000)}` };
    }
    if (last.is_error) return { isError: true, error: last.result ?? last.subtype ?? "error", costUsd: last.total_cost_usd };
    return { isError: false, result: last.result ?? "", costUsd: last.total_cost_usd };
  }

  async #startClaude(prompt: string, model: string, gateway: { accountId: string; gatewayId: string }, cwd: string): Promise<void> {
    const argv = [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--model",
      model,
      "--",
      prompt,
    ];
    const env = {
      ...TRUST_ENV,
      ANTHROPIC_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/anthropic`,
      // Claude Code requires a key; the outbound gateway drops it and adds the gateway token.
      ANTHROPIC_API_KEY: "provided-by-worker",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // The container runs as root, where skipping permissions requires this.
      IS_SANDBOX: "1",
    };
    const proc = await this.#container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", ...argv], { cwd, env, stdout: "ignore", stderr: "ignore" });
    await this.#writeFile(PID_PATH, String(proc.pid));
  }

  async #ensureStarted(sandbox: string): Promise<void> {
    if (this.#container.running) return;
    const snapshotId = await this.#snapshotId();
    this.#container.start({
      containerSnapshot: { id: snapshotId },
      instance: "standard-1",
      enableInternet: false,
      entrypoint: ["sleep", "infinity"],
      labels: { app: "lockkeeper", sandbox: sandbox.slice(0, 64) },
    });
    const outbound = this.#ctx.exports.Outbound({ props: { sandbox } });
    await this.#container.interceptAllOutboundHttp(outbound);
    await this.#container.interceptOutboundHttps("*", outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    await this.#waitReady();
  }

  async #snapshotId(): Promise<string> {
    const r = await this.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SNAPSHOT_SETTING).first<{ value: string }>();
    if (!r) throw new Error("no agent snapshot yet: run POST /api/admin/bootstrap first");
    return r.value;
  }

  async #waitReady(): Promise<void> {
    let lastError = "";
    for (let i = 0; i < 40; i++) {
      try {
        const r = await this.#run(["true"], "/", {});
        if (r.exitCode === 0) return;
      } catch (e) {
        lastError = String(e);
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`container did not become ready: ${lastError}`);
  }

  async #run(argv: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
    const proc = await this.#container.exec(argv, { cwd, env });
    const out = await proc.output();
    const dec = new TextDecoder();
    return { exitCode: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  }

  async #writeFile(path: string, content: string): Promise<void> {
    const body = new Blob([content]).stream();
    const proc = await this.#container.exec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "w", path], { cwd: "/", env: {}, stdin: body });
    const out = await proc.output();
    if (out.exitCode !== 0) throw new Error(`write ${path} failed: ${new TextDecoder().decode(out.stderr)}`);
  }

  async #readOptional(path: string): Promise<string | null> {
    const r = await this.#run(["sh", "-c", 'test -f "$1" && cat "$1"', "r", path], "/", {});
    return r.exitCode === 0 ? r.stdout : null;
  }
}
