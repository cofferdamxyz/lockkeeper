import { recordEvent } from "./db";
import type { LockkeeperEnv } from "./env";
import { indexProject } from "./repomap";

interface ArtifactsEvent {
  type: string;
  source?: { namespace?: string; repoName?: string };
  payload?: {
    ref?: string;
    before?: string;
    after?: string;
    commits?: { id: string; message: string }[];
  };
  metadata?: { eventTimestamp?: string };
}

/** Artifacts events arrive through a Queues event subscription on the project repositories. */
export async function handleQueue(batch: MessageBatch<unknown>, env: LockkeeperEnv): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await handleEvent(env, msg.body as ArtifactsEvent);
      msg.ack();
    } catch (e) {
      console.error("event failed", String(e));
      msg.retry();
    }
  }
}

async function handleEvent(env: LockkeeperEnv, ev: ArtifactsEvent): Promise<void> {
  const repo = ev.source?.repoName ?? "";
  const dedupe = `${ev.type}:${repo}:${ev.payload?.after ?? ev.metadata?.eventTimestamp ?? ""}`;
  const fresh = await recordEvent(env.DB, ev.type, dedupe, ev);
  if (!fresh) return;
  if (ev.type !== "cf.artifacts.repo.pushed" || !ev.payload) return;
  const commits = ev.payload.commits ?? [];
  const project = await env.DB.prepare("SELECT id, default_branch FROM projects WHERE repo = ?").bind(repo).first<{ id: string; default_branch: string }>();
  if (project) {
    await env.DB.prepare("INSERT INTO pushes (project, repo, ref, before_sha, after_sha, commits_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(project.id, repo, ev.payload.ref ?? "", ev.payload.before ?? null, ev.payload.after ?? null, JSON.stringify(commits.map((c) => c.message)))
      .run();
    if (ev.payload.ref === `refs/heads/${project.default_branch}`) {
      await env.DB.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").bind(ev.payload.after ?? null, project.id).run();
      await indexProject(env, project.id).catch((e) => console.warn("index after push failed", String(e)));
    }
    return;
  }
  const m = /^task-(.+)$/.exec(repo);
  if (m) {
    await env.DB.prepare("INSERT INTO pushes (task_id, repo, ref, before_sha, after_sha, commits_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(m[1], repo, ev.payload.ref ?? "", ev.payload.before ?? null, ev.payload.after ?? null, JSON.stringify(commits.map((c) => c.message)))
      .run();
  }
}
