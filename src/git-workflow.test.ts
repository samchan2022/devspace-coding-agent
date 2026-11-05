import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  createGitBranch, stageGitFiles, commitGitChanges, pushGitBranch,
  createGitHubPullRequest,
} from "./git-workflow.js";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-git-workflow-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await mkdir(repo);
  await exec("git", ["init", "--initial-branch=main", repo]);
  await exec("git", ["init", "--bare", remote]);
  const git = (...args: string[]) => exec("git", args, { cwd: repo });
  await git("config", "user.name", "DevSpace Test");
  await git("config", "user.email", "test@example.com");
  await writeFile(join(repo, "README.md"), "initial\n");
  await git("add", "README.md");
  await git("commit", "-m", "init");
  await git("remote", "add", "origin", remote);
  t.after(async () => rm(root, { recursive: true, force: true }));

  return { repo, remote, git };
}

test("feature branch stages explicit files and commits without touching unrelated work", async (t) => {
  const { repo, git } = await fixture(t);
  await writeFile(join(repo, "feature.txt"), "feature\n");
  await writeFile(join(repo, "unrelated.txt"), "leave untracked\n");
  const branch = await createGitBranch(repo, "feat/git-tools");
  assert.equal(branch, "feat/git-tools");
  const staged = await stageGitFiles(repo, ["feature.txt"]);
  assert.deepEqual(staged, ["feature.txt"]);
  const { commit, branch: committedBranch } = await commitGitChanges(repo, "feat: add Git tools");
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(committedBranch, branch);
  assert.equal((await git("show", "--format=", "--name-only", "HEAD")).stdout.trim(), "feature.txt");
  assert.equal((await git("status", "--porcelain")).stdout.trim(), "?? unrelated.txt");
});

test("protected branches, unsafe paths and empty commits are rejected", async (t) => {
  const { repo } = await fixture(t);
  await assert.rejects(() => commitGitChanges(repo, "feat: unsafe"), /protected|branch/i);
  await assert.rejects(() => createGitBranch(repo, "main"), /protected|branch/i);
  await assert.rejects(() => createGitBranch(repo, "feat/../escape"), /invalid/i);
  await createGitBranch(repo, "feat/safe");
  await assert.rejects(() => stageGitFiles(repo, ["../outside"]), /invalid/i);
  await assert.rejects(() => stageGitFiles(repo, [".env"]), /sensitive/i);
  await assert.rejects(() => stageGitFiles(repo, ["src/*"]), /invalid/i);
  await assert.rejects(() => commitGitChanges(repo, "feat: empty"), /staged/i);
});

test("workspace must be Git root so commands cannot act above workspace boundary", async (t) => {
  const { repo } = await fixture(t);
  const nested = join(repo, "nested");
  await mkdir(nested);
  await assert.rejects(() => createGitBranch(nested, "feat/escape"), /repository root/i);
});

test("push requires explicit confirmation and exact HEAD, never force-pushes", async (t) => {
  const { repo, remote, git } = await fixture(t);
  await createGitBranch(repo, "feat/push-test");
  await writeFile(join(repo, "new.txt"), "hello\n");
  await stageGitFiles(repo, ["new.txt"]);
  const { commit } = await commitGitChanges(repo, "feat: push test");
  await assert.rejects(() => pushGitBranch(repo, "feat/push-test", commit, false), /confirm/i);
  await assert.rejects(() => pushGitBranch(repo, "feat/push-test", "0".repeat(40), true), /HEAD|changed/i);
  await pushGitBranch(repo, "feat/push-test", commit, true);
  const { stdout } = await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/feat/push-test"]);
  assert.equal(stdout.trim(), commit);
  assert.equal((await git("branch", "--show-current")).stdout.trim(), "feat/push-test");
});

test("PR creation requires confirmation, validates branches, and uses argument arrays", async (t) => {
  const { repo } = await fixture(t);
  await createGitBranch(repo, "feat/pr-test");
  const calls: string[][] = [];

  const runGh = async (args: string[]) => {
    calls.push(args);

    return "https://github.com/example/repo/pull/42\n";
  };

  await assert.rejects(
    () => createGitHubPullRequest(repo, { base: "main", title: "feat: demo", body: "Changes", confirmed: false }, runGh),
    /confirm/i,
  );

  const url = await createGitHubPullRequest(
    repo,
    { base: "main", title: "feat: demo", body: "Report; no shell", confirmed: true },
    runGh,
  );

  assert.equal(url, "https://github.com/example/repo/pull/42");
  assert.deepEqual(calls, [["pr", "create", "--base", "main", "--head", "feat/pr-test", "--title", "feat: demo", "--body", "Report; no shell"]]);
});
