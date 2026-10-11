"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api, apiText, type DecisionView, getToken, projectFromUrl, setToken, type StateView, STATUS_COLOR, STATUS_LABEL, type TaskStatus, type TaskView } from "../lib/api";

const Scene = dynamic(() => import("./Scene"), { ssr: false, loading: () => <div className="loading">Loading the map…</div> });

const ORDER: TaskStatus[] = ["running", "queued", "ready", "merging", "approved", "needs_review", "blocked", "failed", "merged", "abandoned"];

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

function Bar({ value, label, threshold }: { value: number | null | undefined; label: string; threshold?: number }) {
  const v = value == null || Number.isNaN(value) ? null : value;
  return (
    <div className="bar">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${v == null ? 0 : Math.min(100, v * 100)}%` }} />
        {threshold !== undefined && <span className="bar-threshold" style={{ left: `${threshold * 100}%` }} />}
      </span>
      <span className="bar-value">{v == null ? "n/a" : v.toFixed(2)}</span>
    </div>
  );
}

function RiskBar({ value }: { value: number | null | undefined }) {
  const v = value == null || Number.isNaN(value) ? null : value;
  return (
    <div className="bar">
      <span className="bar-label">risk</span>
      <span className="bar-track">
        <span className="bar-fill risk" style={{ width: `${v == null ? 0 : Math.min(100, (v / 3) * 100)}%` }} />
      </span>
      <span className="bar-value">{v == null ? "n/a" : v.toFixed(2)} / 3</span>
    </div>
  );
}

export default function Dashboard() {
  const [project] = useState(projectFromUrl);
  const [state, setState] = useState<StateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const [tail, setTail] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setHasToken(getToken() !== null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api<StateView>(`/api/state?project=${encodeURIComponent(project)}`);
      setState(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [project]);

  useEffect(() => {
    if (!hasToken) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(id);
  }, [refresh, hasToken]);

  const selectedTask = useMemo(() => state?.tasks.find((t) => t.id === selected) ?? null, [state, selected]);
  const selectedFile = useMemo(() => state?.positions.find((p) => p.id === selected && p.kind === "file") ?? null, [state, selected]);

  useEffect(() => {
    setTail(null);
    if (!selectedTask) return;
    let cancelled = false;
    void apiText(`/api/tasks/${selectedTask.id}/tail`).then((t) => {
      if (!cancelled) setTail(t);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedTask?.id, selectedTask?.status]);

  async function launch() {
    const lines = goals.split("\n").map((g) => g.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setBusy(true);
    try {
      await api(`/api/tasks`, { method: "POST", body: JSON.stringify({ project, goals: lines }) });
      setGoals("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(task: TaskView, action: "approve" | "retry" | "abandon") {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/${action}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!hasToken) {
    return (
      <main className="gate-screen">
        <h1>Lockkeeper</h1>
        <p>Paste the dashboard token to continue. It stays in this browser only.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (tokenInput.trim()) {
              setToken(tokenInput.trim());
              setHasToken(true);
            }
          }}
        >
          <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="dashboard token" autoFocus />
          <button type="submit">Open</button>
        </form>
      </main>
    );
  }

  const tasksByStatus = (status: TaskStatus) => state?.tasks.filter((t) => t.status === status) ?? [];
  const decisionsFor = (id: string): DecisionView[] => state?.decisions.filter((d) => d.candidates.includes(id)) ?? [];
  const latestDecision = state?.decisions[0];

  return (
    <div className="app">
      <div className="scene">{state ? <Scene state={state} selected={selected} onSelect={setSelected} /> : <div className="loading">Connecting…</div>}</div>

      <header className="top">
        <div className="brand">
          <span className="brand-mark" />
          <span>Lockkeeper</span>
          <span className="muted">/ {project}</span>
        </div>
        {state?.project && (
          <div className="facts">
            <span>main <code>{short(state.project.head)}</code></span>
            <span>{state.positions.filter((p) => p.kind === "file").length} files</span>
            <span>{state.tasks.filter((t) => ["running", "queued", "ready", "merging", "approved", "needs_review"].includes(t.status)).length} in flight</span>
            <span>{state.tasks.filter((t) => t.status === "merged").length} merged</span>
            <span className={state.snapshot ? "ok" : "warn"}>{state.snapshot ? "sandbox ready" : "no snapshot"}</span>
            <span className={state.index ? "ok" : "warn"}>{state.index ? "index on" : "index off"}</span>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </header>

      <aside className="left">
        <section className="card">
          <h2>Launch</h2>
          <textarea value={goals} onChange={(e) => setGoals(e.target.value)} placeholder={"One goal per line.\nEach becomes an agent in its own fork."} rows={4} />
          <button disabled={busy || !goals.trim()} onClick={() => void launch()}>
            Launch {goals.split("\n").filter((g) => g.trim()).length || ""} agent{goals.split("\n").filter((g) => g.trim()).length === 1 ? "" : "s"}
          </button>
        </section>

        <section className="card tasks">
          <h2>Tasks</h2>
          {ORDER.map((status) => {
            const list = tasksByStatus(status);
            if (list.length === 0) return null;
            return (
              <div key={status} className="group">
                <div className="group-title">
                  <span className="dot" style={{ background: STATUS_COLOR[status] }} /> {STATUS_LABEL[status]} <span className="muted">{list.length}</span>
                </div>
                {list.map((t) => (
                  <button key={t.id} className={`task-row ${selected === t.id ? "selected" : ""}`} onClick={() => setSelected(t.id)}>
                    <span className="task-id">{t.id.slice(-4)}</span>
                    <span className="task-goal">{t.goal}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {state && state.tasks.length === 0 && <p className="muted">No tasks yet.</p>}
        </section>
      </aside>

      <aside className="right">
        {selectedTask ? (
          <section className="card detail">
            <div className="detail-head">
              <span className="dot" style={{ background: STATUS_COLOR[selectedTask.status] }} />
              <h2>{selectedTask.id}</h2>
              <span className="pill">{STATUS_LABEL[selectedTask.status]}</span>
              {selectedTask.resolved && <span className="pill alt">conflict resolved by agent</span>}
            </div>
            <p className="goal">{selectedTask.goal}</p>
            <div className="meta">
              <span>base <code>{short(selectedTask.baseSha)}</code></span>
              <span>head <code>{short(selectedTask.headSha)}</code></span>
              <span>tests {selectedTask.testsOk === null ? "—" : selectedTask.testsOk ? "green" : "red"}</span>
              <span>cost {selectedTask.costUsd == null ? "—" : `$${selectedTask.costUsd.toFixed(3)}`}</span>
            </div>
            {selectedTask.files.length > 0 && (
              <div className="files">
                {selectedTask.files.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </div>
            )}
            {selectedTask.diffstat && <pre className="diffstat">{selectedTask.diffstat.trim()}</pre>}
            {decisionsFor(selectedTask.id).slice(0, 1).map((d) => (
              <div key={d.id} className="decision">
                <div className="decision-title">
                  Clef · {new Date(d.at).toLocaleTimeString()} · {d.candidates.length} candidate{d.candidates.length === 1 ? "" : "s"}
                  {d.chosen === selectedTask.id && <span className="pill alt">chosen next</span>}
                </div>
                {d.next[selectedTask.id] !== undefined && <Bar label="next" value={d.next[selectedTask.id]} />}
                <Bar label="unattended" value={d.unattended[selectedTask.id]} threshold={selectedTask.resolved ? state?.config.clef.unattendedAfterResolve : state?.config.clef.unattended} />
                <RiskBar value={d.risk[selectedTask.id]} />
              </div>
            ))}
            {selectedTask.error && <p className="note">{selectedTask.error}</p>}
            {selectedTask.summary && <p className="summary">{selectedTask.summary}</p>}
            <div className="actions">
              {selectedTask.status === "needs_review" && (
                <button disabled={busy} onClick={() => void act(selectedTask, "approve")}>
                  Approve merge
                </button>
              )}
              {["failed", "blocked", "needs_review", "abandoned"].includes(selectedTask.status) && (
                <button disabled={busy} className="secondary" onClick={() => void act(selectedTask, "retry")}>
                  Retry from main
                </button>
              )}
              {!["merged", "abandoned"].includes(selectedTask.status) && (
                <button disabled={busy} className="danger" onClick={() => void act(selectedTask, "abandon")}>
                  Abandon
                </button>
              )}
            </div>
            {tail && (
              <details open={selectedTask.status === "running"}>
                <summary>Agent output</summary>
                <pre className="tail">{tail.split("\n").filter(Boolean).slice(-12).map((l) => {
                  try {
                    const e = JSON.parse(l) as { type?: string; message?: { content?: { type: string; text?: string; name?: string }[] }; result?: string };
                    if (e.type === "assistant") return (e.message?.content ?? []).map((c) => (c.type === "text" ? c.text : c.type === "tool_use" ? `→ ${c.name}` : "")).join(" ");
                    if (e.type === "result") return `✔ ${e.result ?? ""}`;
                    return "";
                  } catch {
                    return l;
                  }
                }).filter(Boolean).join("\n")}</pre>
              </details>
            )}
          </section>
        ) : selectedFile ? (
          <section className="card detail">
            <h2>{selectedFile.label}</h2>
            <p className="muted">{selectedFile.meta?.bytes ?? 0} bytes · {selectedFile.meta?.dir ?? "."}</p>
            <div className="files">
              {state?.tasks.filter((t) => t.files.includes(selectedFile.label)).map((t) => (
                <button key={t.id} className="task-row" onClick={() => setSelected(t.id)}>
                  <span className="dot" style={{ background: STATUS_COLOR[t.status] }} /> <span className="task-id">{t.id.slice(-4)}</span>
                  <span className="task-goal">{t.goal}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="card detail">
            <h2>Latest decision</h2>
            {latestDecision ? (
              <div className="decision">
                <div className="decision-title">
                  Clef · {new Date(latestDecision.at).toLocaleTimeString()} · {latestDecision.candidates.length} candidate{latestDecision.candidates.length === 1 ? "" : "s"}
                </div>
                {latestDecision.candidates.map((c) => (
                  <div key={c} className="candidate">
                    <div className="candidate-title">
                      <span className="task-id">{c.slice(-4)}</span>
                      {latestDecision.chosen === c && <span className="pill alt">next</span>}
                    </div>
                    {latestDecision.next[c] !== undefined && <Bar label="next" value={latestDecision.next[c]} />}
                    <Bar label="unattended" value={latestDecision.unattended[c]} threshold={state?.config.clef.unattended} />
                    <RiskBar value={latestDecision.risk[c]} />
                  </div>
                ))}
                {latestDecision.error && <p className="note">{latestDecision.error}</p>}
              </div>
            ) : (
              <p className="muted">No merge round yet. Launch agents, or click a task or a file on the map.</p>
            )}
            <h2>Merges</h2>
            <div className="merges">
              {(state?.merges ?? []).slice(0, 8).map((m) => (
                <div key={m.id} className="merge-row">
                  <span className="task-id">{m.task_id.slice(-4)}</span>
                  <span className={`pill ${m.mode}`}>{m.mode.replace("_", " ")}</span>
                  {m.conflict ? <span className="pill warn">conflict{m.resolved_by ? ` · ${m.resolved_by}` : ""}</span> : null}
                  <code>{short(m.main_after)}</code>
                  <span className="muted">{new Date(m.at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
