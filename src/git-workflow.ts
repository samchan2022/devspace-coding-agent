import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { getGitEligibility } from "./git.js";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const SAFE_BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,119}$/;
const SECRET_FILE = /(^|\/)(?:\.env(?:\..+)?|id_(?:rsa|ed25519|ecdsa)|credentials(?:\.json)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const SECRET_CONTENT = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

async function runGit(root: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root, timeout, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  return stdout.trim();
}

async function requireRepositoryRoot(root: string): Promise<void> {
  const eligible = await getGitEligibility(root);

  if (!eligible.ok || !eligible.gitRoot) throw new Error("Workspace is not a Git repository.");

  if ((await realpath(root)) !== (await realpath(eligible.gitRoot))) {
    throw new Error("Git write tools require the workspace to be the repository root.");
  }
}

function validateBranch(branch: string, allowProtected = false): void {
  if (!SAFE_BRANCH.test(branch) || branch.includes("..") || branch.includes("//") ||
      branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".") ||
      branch.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("Invalid Git branch name.");
  }

  if (!allowProtected && ["main", "master"].includes(branch.toLowerCase())) {
    throw new Error("Protected branch: use a feature branch, not main or master.");
  }
}

async function currentBranch(root: string): Promise<string> {
  const branch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  validateBranch(branch);
  const originHead = await runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");

  if (originHead && branch === originHead.replace(/^origin\//, "")) {
    throw new Error("Refusing to modify the origin default branch.");
  }

  return branch;
}

function validateFilePath(file: string): void {
  if (!file || file.length > 512 || isAbsolute(file) ||
      /^[A-Za-z]:/.test(file) || /[\\*?[\]\0]/.test(file) ||
      file.startsWith(":") ||
      file.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Invalid relative file path for staging.");
  }

  if (SECRET_FILE.test(file) && !file.endsWith(".env.example")) {
    throw new Error("Refusing to stage a potentially sensitive file.");
  }
}

async function stagedPaths(root: string): Promise<string[]> {
  const output = await runGit(root, ["diff", "--cached", "--name-only", "-z"]);

  return output.split("\0").filter(Boolean);
}

async function reviewStaged(root: string): Promise<string[]> {
  const paths = await stagedPaths(root);

  if (!paths.length) throw new Error("No staged changes to commit.");

  for (const file of paths) validateFilePath(file);
  await runGit(root, ["diff", "--cached", "--check"]);
  const patch = await runGit(root, ["diff", "--cached", "--no-ext-diff", "--unified=0"]);

  if (SECRET_CONTENT.test(patch)) {
    throw new Error("Potential secret in staged changes. Review the diff before committing.");
  }

  return paths;
}

export async function createGitBranch(root: string, branch: string): Promise<string> {
  await requireRepositoryRoot(root);
  validateBranch(branch);
  await runGit(root, ["check-ref-format", "--branch", branch]);
  await runGit(root, ["switch", "-c", branch]);

  return branch;
}

export async function stageGitFiles(root: string, files: string[]): Promise<string[]> {
  await requireRepositoryRoot(root);
  await currentBranch(root);

  if (files.length < 1 || files.length > 200) throw new Error("Select 1–200 explicit file paths to stage.");
  const uniqueFiles = [...new Set(files)];

  for (const file of uniqueFiles) {
    validateFilePath(file);

    const stats = await lstat(resolve(root, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

    if (stats?.isDirectory()) throw new Error("Stage explicit files, not whole directories.");
  }

  await runGit(root, ["--literal-pathspecs", "add", "-A", "--", ...uniqueFiles]);

  return stagedPaths(root);
}

export async function commitGitChanges(root: string, message: string): Promise<{ branch: string; commit: string; files: string[] }> {
  await requireRepositoryRoot(root);
  const branch = await currentBranch(root);

  if (!/^(?:feat|fix|refactor|docs|test|chore|perf|ci)(?:\([\w.-]+\))?!?: .{4,180}$/.test(message) ||
      message.includes("\n")) throw new Error("Use a single-line conventional commit message.");
  const files = await reviewStaged(root);
  await runGit(root, ["commit", "--no-gpg-sign", "-m", message], 90_000);
  const commit = await runGit(root, ["rev-parse", "HEAD"]);

  return { branch, commit, files };
}

export async function pushGitBranch(root: string, branch: string, expectedHead: string, confirmed: boolean): Promise<string> {
  if (!confirmed) throw new Error("Confirm publishing the branch to origin before pushing.");
  await requireRepositoryRoot(root);
  validateBranch(branch);

  if ((await currentBranch(root)) !== branch) throw new Error("Selected branch does not match the current branch.");
  const head = await runGit(root, ["rev-parse", "HEAD"]);

  if (!SHA_PATTERN.test(expectedHead) || head !== expectedHead) {
    throw new Error("HEAD changed since review. Inspect changes and confirm the new commit SHA.");
  }

  const origin = await runGit(root, ["remote", "get-url", "origin"]);

  if (!origin || /^(?:ext::|\s*-)/i.test(origin)) throw new Error("Invalid origin remote.");
  await runGit(root, ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], 120_000);

  return `${branch} pushed to origin at ${head}`;
}

export interface PullRequestInput {
  base: string;
  title: string;
  body: string;
  confirmed: boolean;
}

export async function createGitHubPullRequest(
  root: string,
  input: PullRequestInput,
  runGh: (args: string[]) => Promise<string> = async (args) => {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    });

    return stdout;
  },
): Promise<string> {
  if (!input.confirmed) throw new Error("Confirm opening the GitHub pull request before publishing.");
  await requireRepositoryRoot(root);
  const head = await currentBranch(root);
  validateBranch(input.base, true);

  if (head === input.base) throw new Error("Pull request base must differ from the feature branch.");

  if (!input.title.trim() || input.title.length > 180 || /[\r\n]/.test(input.title)) {
    throw new Error("PR title must be a single line of at most 180 characters.");
  }

  if (!input.body.trim() || input.body.length > 20000) throw new Error("PR body is required (up to 20,000 characters).");

  const result = (await runGh([
    "pr", "create", "--base", input.base, "--head", head,
    "--title", input.title, "--body", input.body,
  ])).trim();

  if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(result)) {
    throw new Error("GitHub CLI did not return a pull request URL.");
  }

  return result;
}
