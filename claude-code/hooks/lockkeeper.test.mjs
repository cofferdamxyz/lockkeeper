// Plain node:test, no dependencies: `node --test claude-code/hooks/`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { commandDir, gitVerb, repoFromRemote } from "./lockkeeper.mjs";

test("reads the repository from any remote", () => {
  assert.equal(repoFromRemote("https://github.com/cofferdamxyz/cofferdam-app.git"), "cofferdamxyz/cofferdam-app");
  assert.equal(repoFromRemote("git@github.com:cofferdamxyz/lockkeeper.git"), "cofferdamxyz/lockkeeper");
  assert.equal(repoFromRemote("http://local_proxy@127.0.0.1:41537/git/cofferdamxyz/cofferdam-api"), "cofferdamxyz/cofferdam-api");
});

test("sees commits and pushes, nothing else", () => {
  assert.equal(gitVerb("git commit -s -m x"), "commit");
  assert.equal(gitVerb("cd /home/claude/cofferdam-app && git push -u origin claude/x"), "push");
  assert.equal(gitVerb("git -C ../cofferdam push"), "push");
  assert.equal(gitVerb("git status && git log"), null);
  assert.equal(gitVerb("echo 'git commit is next'"), "commit"); // conservative: a check never hurts
});

test("finds the directory git runs in", () => {
  assert.equal(commandDir("git -C ../cofferdam push", "/home/claude/lockkeeper"), "/home/claude/cofferdam");
  assert.equal(commandDir("cd /home/claude/cofferdam-app && git push", "/x"), "/home/claude/cofferdam-app");
  assert.equal(commandDir("git push", "/x"), "/x");
});

test("is silent and exits 0 when not configured", () => {
  const out = execFileSync(process.execPath, [new URL("./lockkeeper.mjs", import.meta.url).pathname, "pre-tool"], {
    input: JSON.stringify({ tool_input: { command: "git push" } }),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(out, "");
});
