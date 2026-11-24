import config, { type LockkeeperConfig } from "../../lockkeeper.config";
import type { Identity } from "./access";
import type { LandingEntry } from "./advice";
import { parseDecision, RISK_LEVELS } from "./clef";
import type { LockkeeperEnv } from "./env";
import { GEIST_MONO_WOFF2, GEIST_WOFF2 } from "./monitorFonts";
import { present, type Present, type PresentBranch, type PresentRepo } from "./present";
import { getDecisions, getOutcomes, getRepos, getSetting, recentMainMoves, type DecisionRow, type MainMove, type Outcome, type RepoRow } from "./store";

/**
 * The monitor (DESIGN.md, "The monitor"): one page at `/` for a person, behind Access like every
 * other route. It shows what the API already answers (the repositories, the branches in flight,
 * the landing queue) and, as their first reader, the decision ledger and the outcomes. It reads
 * Lockkeeper's own ledger and writes nothing.
 *
 * The page is rendered here, as text, with no script: every string a pull request chose (a
 * title, a branch name, a file name, a commit message, a claim's goal) passes through `h`, a
 * number is written only where its type was checked on the way in, and a link leads to GitHub or
 * to the page itself, so the content policy can forbid scripts outright.
 */

export interface MonitorData {
  now: Date;
  who: Identity;
  /** The one repository shown (`owner/name`), or null for all. */
  only: string | null;
  present: Present;
  repos: RepoRow[];
  landed: { repo: string; moves: MainMove[] }[];
  decisions: DecisionRow[];
  outcomes: Outcome[];
  poll: { errors?: string[]; notes?: string[]; at?: string } | null;
  advice: { errors?: string[]; at?: string } | null;
}

const json = <T>(v: string | null): T | null => {
  try {
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};

export async function monitorData(env: LockkeeperEnv, who: Identity, repo?: string, opts: { now?: Date; settings?: LockkeeperConfig } = {}): Promise<MonitorData> {
  const settings = opts.settings ?? config;
  const now = opts.now ?? new Date();
  const repos = await getRepos(env);
  const only = repo && repos.some((r) => r.repo === repo) ? repo : null;
  const since = new Date(now.getTime() - settings.recentHours * 3600_000).toISOString();
  const landed: MonitorData["landed"] = [];
  for (const r of repos.filter((x) => !only || x.repo === only)) {
    const moves = await recentMainMoves(env, r.repo, since);
    if (moves.length) landed.push({ repo: r.repo, moves });
  }
  return {
    now,
    who,
    only,
    present: await present(env, only ?? undefined, { now, settings }),
    repos,
    landed,
    decisions: await getDecisions(env, 20, only ?? undefined),
    outcomes: await getOutcomes(env, only ?? undefined, 20),
    poll: json(await getSetting(env, "poll_report")),
    advice: json(await getSetting(env, "advise_report")),
  };
}

// ---------- text ----------

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

// Control characters, and the invisible and direction-changing ones: text that could reorder or
// hide what a row says (a claim that reads as another person's, a title that mirrors its line).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Every string that reaches the page goes through here; a number is written only where its type was checked on the way in. */
export function h(value: unknown): string {
  return String(value ?? "")
    .replace(INVISIBLE, "")
    .replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
}

/** A link only for a GitHub URL, with no dot segment in it; anything else is shown as plain text. */
function link(url: string | null | undefined, text: string, cls = ""): string {
  const ok = typeof url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9._/#?=&%-]+$/.test(url) && !/\/\.{1,2}(\/|$)/.test(url) && !url.includes("//", 8);
  return ok ? `<a${cls ? ` class="${cls}"` : ""} href="${h(url)}" rel="noreferrer noopener">${h(text)}</a>` : h(text);
}

const short = (repo: string) => repo.split("/").slice(1).join("/") || repo;
const sha7 = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "unknown");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "–");

export function ago(iso: string | null | undefined, now: Date): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return "unknown";
  const m = Math.round((now.getTime() - t) / 60_000);
  if (m < 0) return m > -60 ? `in ${-m} min` : `in ${Math.round(-m / 60)} h`;
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const when = (iso: string | null | undefined, now: Date) => `<time datetime="${h(iso ?? "")}" title="${h(iso ?? "")}">${h(ago(iso, now))}</time>`;

const CI_WORD: Record<string, [string, string]> = { pass: ["ok", "CI passed"], fail: ["bad", "CI failed"], pending: ["wait", "CI running"], none: ["mute", "No CI result"] };

function ci(state: string): string {
  const [cls, word] = CI_WORD[state] ?? CI_WORD.none;
  return `<span class="chip ${cls}">${h(word)}</span>`;
}

function risk(v: number | null): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "–";
  const word = RISK_LEVELS[Math.min(RISK_LEVELS.length - 1, Math.max(0, Math.round(v)))].toLowerCase();
  return `${v.toFixed(2)} of 3, ${word}`;
}

// ---------- sections ----------

function queueRow(e: LandingEntry, total: number, now: Date): string {
  const verdict = e.eligible ? '<span class="chip proof">Could land unattended</span>' : '<span class="chip mute">Needs a person</span>';
  const reasons = e.eligible || !e.reasons.length ? "" : `<details class="why"><summary>Why (${e.reasons.length})</summary><ul>${e.reasons.map((r) => `<li>${h(r[0]?.toUpperCase() + r.slice(1))}.</li>`).join("")}</ul></details>`;
  return `<li class="q">
  <div class="pos" aria-label="position ${e.position} of ${total}">${e.position}</div>
  <div class="what">
    <div class="t">${link(e.url, `#${e.pr}`, "pr")} ${h(e.title ?? "")}${e.draft ? ' <span class="tag">draft</span>' : ""}</div>
    <div class="m"><code>${h(e.branch)}</code> at <code>${h(sha7(e.head))}</code> · ${e.ahead} ahead, ${e.behind} behind${e.issue ? ` · for ${h(e.issue)}` : ""}${e.label ? ` · suggested label <code>${h(e.label)}</code>` : ""}</div>
    <dl class="clef"><div><dt>next</dt><dd>${num(e.nextP)}</dd></div><div><dt>unattended</dt><dd>${num(e.unattended)}</dd></div><div><dt>risk</dt><dd>${h(risk(e.risk))}</dd></div><div><dt>advised</dt><dd>${when(e.decidedAt, now)}</dd></div></dl>
    ${reasons}
  </div>
  <div class="state">${ci(e.ci)}${verdict}</div>
</li>`;
}

/** Open pull requests as the poll saw them. The advice may be behind: not asked yet, or past `clef.maxCandidates`. */
const openPulls = (r: PresentRepo) => r.branches.filter((b) => b.pr !== null).length;

function queue(d: MonitorData): string {
  const repos = d.present.repos.filter((r) => r.order.length || openPulls(r));
  if (!repos.length) return '<p class="empty">No pull request is open. Nothing is waiting to land.</p>';
  return repos
    .map((r) => {
      const open = Math.max(openPulls(r), r.order.length);
      const waiting = open - r.order.length;
      const count = waiting > 0 ? `${open} open, ${waiting} not advised yet` : `${open} open`;
      const rows = r.order.length
        ? `<ol class="queue">${r.order.map((e) => queueRow(e, r.order.length, d.now)).join("")}</ol>`
        : '<p class="empty">Its open pull requests have no advice yet: the advising pass runs after each poll.</p>';
      return `<article class="card">
  <header><h3>${repoLink(r.repo)}</h3><p><code>${h(r.defaultBranch)}</code> at <code>${h(sha7(r.head))}</code> · ${count}</p></header>
  ${rows}
</article>`;
    })
    .join("");
}

const repoLink = (repo: string) => link(`https://github.com/${repo}`, short(repo));

function branchRow(b: PresentBranch, repo: string, now: Date, all: PresentBranch[]): string {
  const pr = b.pr ? `${link(b.pr.url, `#${b.pr.number}`, "pr")} ${h(cut(b.pr.title ?? "", 70))}${b.pr.draft ? ' <span class="tag">draft</span>' : ""}` : '<span class="muted">no pull request</span>';
  const shares = b.overlaps.length
    ? b.overlaps
        .map((o) => {
          const other = all.find((x) => x.name === o.with)?.pr;
          // The other branch by its pull request where it has one: a number reads faster than a branch name.
          return `<span title="${h(`${o.with}: ${o.files.join(", ")}`)}">${other ? h(`#${other.number}`) : `<code>${h(cut(o.with, 32))}</code>`} <span class="muted">${o.shared} ${o.shared === 1 ? "file" : "files"}</span></span>`;
        })
        .join(", ")
    : '<span class="muted">nothing</span>';
  return `<tr>
  <td><code>${link(`https://github.com/${repo}/tree/${encodeURIComponent(b.name).replace(/%2F/g, "/")}`, cut(b.name, 60))}</code>${b.sensitive ? ' <span class="tag">sensitive</span>' : ""}${b.issue ? ` <span class="muted">${h(b.issue)}</span>` : ""}</td>
  <td class="n">${b.ahead} / ${b.behind}</td>
  <td>${when(b.lastCommitAt, now)}${b.author ? ` <span class="muted">${h(cut(b.author, 24))}</span>` : ""}</td>
  <td>${pr}</td>
  <td>${b.pr ? ci(b.ci) : ""}</td>
  <td>${shares}</td>
</tr>`;
}

const MAX_CLAIMS = 20;

function inFlight(d: MonitorData): string {
  if (!d.present.repos.length) return '<p class="empty">Nothing is in flight.</p>';
  return d.present.repos
    .map((r: PresentRepo) => {
      const claims = r.claims.length
        ? `<ul class="claims">${r.claims
            .slice(0, MAX_CLAIMS)
            .map(
              (c) =>
                // The identity Access verified comes first; the session label is the claimant's own words, and is quoted as such.
                `<li><span class="tag">claim</span> ${h(cut(c.goal, 140))} <span class="muted">by ${h(c.who)}${c.session ? `, session &quot;${h(cut(c.session, 60))}&quot;` : ""}, expires ${h(ago(c.expiresAt, d.now))}${c.branch ? `, for <code>${h(cut(c.branch, 40))}</code>` : ""}${c.paths.length ? `, on ${c.paths.slice(0, 4).map((p) => `<code>${h(cut(p, 50))}</code>`).join(", ")}${c.paths.length > 4 ? ` and ${c.paths.length - 4} more` : ""}` : ", on the whole repository"}</span></li>`,
            )
            .join("")}${r.claims.length > MAX_CLAIMS ? `<li class="muted">and ${r.claims.length - MAX_CLAIMS} more</li>` : ""}</ul>`
        : "";
      const table = r.branches.length
        ? `<div class="scroll"><table><thead><tr><th>Branch</th><th class="n">Ahead / behind</th><th>Last commit</th><th>Pull request</th><th>CI</th><th>Shares files with</th></tr></thead><tbody>${r.branches.map((b) => branchRow(b, r.repo, d.now, r.branches)).join("")}</tbody></table></div>`
        : "";
      return `<article class="card"><header><h3>${repoLink(r.repo)}</h3><p>${r.branches.length} ${r.branches.length === 1 ? "branch" : "branches"}${r.claims.length ? `, ${r.claims.length} ${r.claims.length === 1 ? "claim" : "claims"}` : ""} · polled ${when(r.polledAt, d.now)}</p></header>${table}${claims}</article>`;
    })
    .join("");
}

function landed(d: MonitorData): string {
  if (!d.landed.length) return `<p class="empty">Nothing landed in the last ${config.recentHours} hours.</p>`;
  return d.landed
    .map(
      ({ repo, moves }) => `<article class="card"><header><h3>${repoLink(repo)}</h3></header><ul class="commits">${moves
        // Moves come newest first, and each move's commits oldest first: newest commit on top, twenty at most.
        .flatMap((m) => m.commits.slice(-12).reverse().map((c) => ({ c, at: m.at })))
        .slice(0, 20)
        .map(({ c, at }) => `<li><code>${h(c.slice(0, 7))}</code> ${h(cut(c.slice(8), 150))} <span class="muted">${when(at, d.now)}</span></li>`)
        .join("")}</ul></article>`,
    )
    .join("");
}

function decisions(d: MonitorData): string {
  const asked = d.decisions.length
    ? `<div class="scroll"><table><thead><tr><th>Asked</th><th>Repository</th><th class="n">Candidates</th><th>Clef's pick</th><th>Past Clef's thresholds</th><th>Answer</th></tr></thead><tbody>${d.decisions
        .map((row) => {
          const parsed = row.response == null ? null : parseDecision(row.response, row.candidates);
          const pr = (id: string) => `#${id.replace(/^pr-/, "")}`;
          const pick = parsed?.next ? `${h(pr(parsed.next))} <span class="muted">${num(parsed.nextProbabilities[parsed.next])}</span>` : '<span class="muted">none</span>';
          const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
          // Clef's numbers alone, against today's thresholds. The verdict also needs the rules (CI,
          // sensitive paths, shared files, a fresh base): that is the queue above, not this column.
          const able = parsed
            ? row.candidates
                .filter((id) => finite(parsed.unattended[id]) && finite(parsed.risk[id]) && parsed.unattended[id] >= config.clef.unattended && parsed.risk[id] <= config.clef.maxRisk)
                .map((id) => h(pr(id)))
                .join(", ") || '<span class="muted">none</span>'
            : "";
          const whole = parsed !== null && row.candidates.length > 0 && row.candidates.every((id) => finite(parsed.unattended[id]) && finite(parsed.risk[id]));
          const answer = row.error
            ? `<span class="chip bad">failed</span> <span class="muted">${h(cut(row.error, 120))}</span>`
            : whole
              ? '<span class="chip ok">answered</span>'
              : parsed
                ? '<span class="chip wait">answered in part</span>'
                : '<span class="chip mute">no answer</span>';
          return `<tr><td>${when(row.at, d.now)}</td><td>${h(short(row.repo))}</td><td class="n">${row.candidates.length}</td><td>${pick}</td><td>${able}</td><td>${answer}</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : '<p class="empty">Clef has not been asked yet.</p>';
  const outcomes = d.outcomes.length
    ? `<h3 class="sub">What happened to its advice</h3><div class="scroll"><table><thead><tr><th>When</th><th>Pull request</th><th class="n">Advised position</th><th>Verdict</th><th class="n">Unattended</th><th class="n">Risk</th><th>Outcome</th></tr></thead><tbody>${d.outcomes
        .map(
          (o) =>
            `<tr><td>${when(o.at, d.now)}</td><td>${link(`https://github.com/${o.repo}/pull/${o.pr_number}`, `${short(o.repo)}#${o.pr_number}`)}</td><td class="n">${o.position} of ${o.candidates}</td><td>${o.eligible ? "could land unattended" : "needed a person"}</td><td class="n">${num(o.unattended)}</td><td class="n">${num(o.risk)}</td><td><span class="chip ${o.outcome === "landed" ? "ok" : "mute"}">${h(o.outcome)}</span></td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : "";
  return asked + outcomes;
}

function repositories(d: MonitorData): string {
  if (!d.repos.length) return '<p class="empty">No repository has been polled yet.</p>';
  return `<div class="scroll"><table><thead><tr><th>Repository</th><th>Default branch</th><th>Last push</th><th>Polled</th></tr></thead><tbody>${d.repos
    .map((r) => `<tr><td>${repoLink(r.repo)}</td><td><code>${h(r.default_branch)}</code> at <code>${h(sha7(r.head_sha))}</code></td><td>${when(r.pushed_at, d.now)}</td><td>${when(r.polled_at, d.now)}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

// ---------- the page ----------

const MARK = `<svg class="mark" viewBox="0 0 1024 1024" role="img" aria-label="Lockkeeper"><polygon points="252.8,190.5 254.0,185.6 255.6,180.7 257.7,176.0 260.3,171.4 263.3,167.0 266.7,162.9 270.5,159.1 274.6,155.6 278.9,152.5 283.5,149.8 288.3,147.6 293.2,145.8 298.2,144.5 303.2,143.8 308.1,143.5 357.0,143.5 361.9,143.8 366.6,144.5 371.1,145.8 375.4,147.6 379.4,149.8 383.1,152.5 386.3,155.6 389.2,159.1 391.6,162.9 393.6,167.0 395.0,171.4 396.0,176.0 396.4,180.7 396.3,185.6 395.7,190.5 299.3,737.6 793.7,737.6 798.6,737.9 803.3,738.6 807.8,739.9 812.1,741.7 816.1,743.9 819.7,746.6 823.0,749.7 825.9,753.2 828.3,757.0 830.3,761.1 831.7,765.5 832.7,770.1 833.1,774.8 833.0,779.7 832.4,784.6 823.8,833.5 822.7,838.4 821.0,843.3 818.9,848.0 816.4,852.6 813.4,857.0 809.9,861.1 806.2,864.9 802.1,868.4 797.7,871.5 793.1,874.2 788.3,876.4 783.4,878.2 778.5,879.5 773.5,880.2 768.5,880.5 178.2,880.5 173.3,880.2 168.6,879.5 164.1,878.2 159.8,876.4 155.8,874.2 152.1,871.5 148.9,868.4 146.0,864.9 143.6,861.1 141.6,857.0 140.2,852.6 139.2,848.0 138.8,843.3 138.9,838.4 139.5,833.5"/><polygon points="440.9,510.1 442.0,505.2 443.6,500.3 445.8,495.6 448.3,491.0 451.3,486.6 454.7,482.5 458.5,478.7 462.6,475.2 467.0,472.1 471.6,469.4 476.3,467.2 481.2,465.4 486.2,464.1 491.2,463.4 496.2,463.1 842.1,463.1 847.0,463.4 851.7,464.1 856.2,465.4 860.5,467.2 864.5,469.4 868.1,472.1 871.4,475.2 874.3,478.7 876.7,482.5 878.7,486.6 880.1,491.0 881.1,495.6 881.5,500.3 881.4,505.2 880.8,510.1 872.2,559.0 871.1,563.9 869.4,568.8 867.3,573.5 864.8,578.1 861.8,582.5 858.3,586.6 854.6,590.4 850.5,593.9 846.1,597.0 841.5,599.7 836.7,601.9 831.8,603.7 826.9,605.0 821.9,605.7 816.9,606.0 471.0,606.0 466.1,605.7 461.4,605.0 456.9,603.7 452.6,601.9 448.6,599.7 444.9,597.0 441.7,593.9 438.8,590.4 436.4,586.6 434.4,582.5 433.0,578.1 432.0,573.5 431.6,568.8 431.7,563.9 432.3,559.0"/></svg>`;

const CSS = `
@font-face{font-family:"Geist";src:url(/monitor/geist.woff2?v=${GEIST_WOFF2.length}) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/monitor/geist-mono.woff2?v=${GEIST_MONO_WOFF2.length}) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:dark light;--bg:#000;--fg:#fff;--muted:#b0b4ba;--muted-2:#6c7079;--card:#101113;--surface:#141518;--border:#2a2d32;--control:#6c7079;--proof:#3c8aff;--ok:#7ce3a2;--wait:#ffc857;--bad:#ff8b7a;
--sans:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#1a1a1a;--muted:#595959;--muted-2:#8a8a8a;--card:#fff;--surface:#f0f0f3;--border:#e2e2e6;--control:#8a8a8a;--proof:#0000ff;--ok:#1a8c4a;--wait:#b8860b;--bad:#cc2818}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.5 var(--sans);font-feature-settings:"tnum"}
main{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--control);text-underline-offset:3px}a:hover{text-decoration-color:var(--fg)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--proof);outline-offset:2px;border-radius:4px}
code{font:500 13px/1.4 var(--mono);overflow-wrap:anywhere}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.mark{width:30px;height:30px;fill:currentColor;flex:none}
.top h1{font:700 22px/1 var(--sans);letter-spacing:-0.03em;margin:0}.top p{margin:0 0 0 auto;color:var(--muted);font:500 13px/1.4 var(--mono);text-align:right}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:22px 0 0;padding:0;list-style:none}
.stats li{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px 16px}.stats b{display:block;font:700 28px/1.1 var(--sans);letter-spacing:-0.02em}.stats span{color:var(--muted);font-size:13px}
.note{margin:14px 0 0;padding:12px 16px;border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--muted)}.note b{color:var(--fg);font-weight:600}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 0}
nav a{text-decoration:none;border:1px solid var(--border);border-radius:999px;padding:5px 12px;font:500 13px/1.4 var(--sans);color:var(--muted)}nav a[aria-current]{border-color:var(--fg);color:var(--fg)}
section{margin-top:40px}h2{font:700 20px/1.2 var(--sans);letter-spacing:-0.02em;margin:0}h2+p{margin:4px 0 14px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:16px 18px;margin-top:10px}
.card header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.card h3{font:600 16px/1.3 var(--mono);margin:0}.card header p{margin:0;color:var(--muted);font-size:13px}
.sub{font:600 15px/1.3 var(--sans);margin:22px 0 0}
.queue{list-style:none;margin:10px 0 0;padding:0}
.q{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:6px 14px;padding:14px 0;border-top:1px solid var(--border)}
.pos{font:700 26px/1 var(--sans);letter-spacing:-0.02em;color:var(--muted)}.q:first-child .pos{color:var(--fg)}
.t{font-weight:600;overflow-wrap:anywhere}.pr{font-family:var(--mono);font-weight:500}.m{color:var(--muted);font-size:13px;margin-top:2px}
.why{margin:6px 0 0;color:var(--muted);font-size:13px}.why summary{cursor:pointer;width:fit-content;font:500 12.5px/1.6 var(--sans)}.why ul{margin:4px 0 0;padding:0 0 0 18px}.why li{margin:1px 0;overflow-wrap:anywhere}
.state{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-content:flex-start}
.clef{display:flex;gap:4px 18px;flex-wrap:wrap;margin:6px 0 0}.clef div{display:flex;gap:6px;align-items:baseline}
.clef dt{color:var(--muted-2);font:500 12px/1.4 var(--mono)}.clef dd{margin:0;font:500 13px/1.4 var(--mono);color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:2px 10px;font:500 12.5px/1.5 var(--sans);white-space:nowrap}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--control)}
.chip.ok::before{background:var(--ok)}.chip.bad::before{background:var(--bad)}.chip.wait::before{background:var(--wait)}.chip.proof{border-color:var(--proof)}.chip.proof::before{background:var(--proof)}.chip.mute{color:var(--muted)}
.tag{border:1px solid var(--border);border-radius:8px;padding:0 6px;font:500 11.5px/1.6 var(--mono);color:var(--muted);white-space:nowrap}
.muted{color:var(--muted)}.empty{color:var(--muted);margin:10px 0 0}
.scroll{overflow-x:auto;margin-top:8px}table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;font:500 12px/1.4 var(--mono);color:var(--muted-2);padding:8px 14px 8px 0;white-space:nowrap;border-bottom:1px solid var(--border)}
td{padding:9px 14px 9px 0;border-bottom:1px solid var(--border);vertical-align:top}tr:last-child td{border-bottom:0}.n{text-align:right;white-space:nowrap;font-family:var(--mono)}
.claims,.commits{list-style:none;margin:10px 0 0;padding:0}.claims li,.commits li{padding:7px 0;border-top:1px solid var(--border);overflow-wrap:anywhere}.commits li:first-child{border-top:0}
footer{margin-top:44px;color:var(--muted-2);font-size:13px}
@media (max-width:760px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.q{grid-template-columns:34px minmax(0,1fr)}.state{grid-column:2;justify-content:flex-start}.top p{margin-left:0;text-align:left;width:100%}}
`;

export function renderMonitor(d: MonitorData): string {
  const repos = d.present.repos;
  const branches = repos.reduce((n, r) => n + r.branches.length, 0);
  const open = repos.reduce((n, r) => n + Math.max(openPulls(r), r.order.length), 0);
  const claims = repos.reduce((n, r) => n + r.claims.length, 0);
  const eligible = repos.reduce((n, r) => n + r.order.filter((e) => e.eligible).length, 0);
  const stat = (n: number, label: string) => `<li><b>${n}</b><span>${h(label)}</span></li>`;
  const notes = [
    ...(d.poll?.notes ?? []).map((t) => `<p class="note"><b>Note.</b> ${h(t)}</p>`),
    ...(d.poll?.errors ?? []).slice(0, 5).map((t) => `<p class="note"><b>The last poll failed for one repository.</b> ${h(cut(t, 300))}</p>`),
    ...(d.advice?.errors ?? []).slice(0, 5).map((t) => `<p class="note"><b>The last advising pass reported an error.</b> ${h(cut(t, 300))}</p>`),
  ].join("");
  const withWork = (d.only ? d.repos.filter((r) => r.repo === d.only) : d.repos.filter((r) => repos.some((p) => p.repo === r.repo))).map((r) => r.repo);
  const chips =
    `<a href="/"${d.only ? "" : ' aria-current="page"'}>All</a>` +
    [...new Set([...withWork, ...repos.map((r) => r.repo)])].map((r) => `<a href="/?repo=${encodeURIComponent(short(r))}"${d.only === r ? ' aria-current="page"' : ""}>${h(short(r))}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex">
<title>Lockkeeper</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(MARK.replace('class="mark"', 'xmlns="http://www.w3.org/2000/svg" fill="#888"'))}">
<style>${CSS}</style>
</head>
<body>
<main>
<div class="top">${MARK}<h1>Lockkeeper</h1><p>polled ${when(d.present.polledAt, d.now)} · advised ${when(d.present.advisedAt, d.now)}</p></div>
<ul class="stats">${stat(d.only ? 1 : d.repos.length, d.only ? "repository shown" : "repositories")}${stat(branches, "branches in flight")}${stat(open, "open pull requests")}${stat(claims, "claims")}${stat(eligible, "could land unattended")}</ul>
${notes}
<nav aria-label="Repository">${chips}</nav>
<section><h2>Landing queue</h2><p>The order to land the open pull requests in, as Clef and the rules advise. Advice only: a person lands each one.</p>${queue(d)}</section>
<section><h2>In flight</h2><p>Branches ahead of the default branch, open pull requests, and claims for work not pushed yet.</p>${inFlight(d)}</section>
<section><h2>Landed recently</h2><p>What moved into a default branch in the last ${config.recentHours} hours.</p>${landed(d)}</section>
<section><h2>Clef's decisions</h2><p>Each time Clef was asked about a repository's open pull requests, newest first.</p>${decisions(d)}</section>
<section><h2>Repositories</h2><p>Every repository Lockkeeper can see.</p>${repositories(d)}</section>
<footer>Signed in as ${h(d.who.who)}. This page reloads every minute and changes nothing. Awareness, not a lock: main always wins and branches rebase onto it.</footer>
</main>
</body>
</html>`;
}

/** No script and no other origin: the page is text, its two fonts and one inline icon. */
export const MONITOR_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
