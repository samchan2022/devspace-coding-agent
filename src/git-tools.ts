import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { ServerConfig } from "./config.js";
import { logToolCall, resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";
import {
  createGitBranch, stageGitFiles, commitGitChanges, pushGitBranch,
  createGitHubPullRequest,
} from "./git-workflow.js";

type ToolTarget = Pick<McpServer, "registerTool">;

export function registerGitTools(server: ToolTarget, workspaces: WorkspaceRegistry, config: ServerConfig): void {
  const workspace_id = z.string().describe("Workspace ID returned by open_workspace.");
  const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const publishAnnotations = { ...writeAnnotations, openWorldHint: true };

  function respond(tool: string, workspaceId: string, started: number, result: string) {
    logToolCall(config, {
      tool, workspaceId, success: true, durationMs: Math.round(performance.now() - started),
    });

    return { content: [textBlock(result)], structuredContent: { result } };
  }

  server.registerTool("git_create_branch", {
    title: "Create Git feature branch",
    description: "Create a new feature branch in the opened repository, preserving uncommitted changes. Never changes main/master.",
    inputSchema: { workspace_id, branch: z.string().min(2).max(120) },
    outputSchema: resultOutputSchema(),
    annotations: writeAnnotations,
  }, async ({ workspace_id, branch }) => {
    const started = performance.now();
    const workspace = await workspaces.getWorkspace(workspace_id);
    const name = await createGitBranch(workspace.root, branch);

    return respond("git_create_branch", workspace_id, started, `Created branch ${name}`);
  });

  server.registerTool("git_stage_changes", {
    title: "Stage selected Git files",
    description: "Stage only explicitly named relative files. Does not stage whole directories or all untracked files.",
    inputSchema: {
      workspace_id,
      paths: z.array(z.string().min(1)).min(1).max(200),
    },
    outputSchema: resultOutputSchema(),
    annotations: writeAnnotations,
  }, async ({ workspace_id, paths }) => {
    const started = performance.now();
    const workspace = await workspaces.getWorkspace(workspace_id);
    const files = await stageGitFiles(workspace.root, paths);

    return respond("git_stage_changes", workspace_id, started, `Staged changes: ${files.join(", ") || "none"}`);
  });

  server.registerTool("git_commit", {
    title: "Commit staged changes",
    description: "Commit the reviewed staged Git changes on a feature branch. Reject sensitive files, patch whitespace errors, empty commits, and main/master.",
    inputSchema: {
      workspace_id,
      message: z.string().min(8).max(200).describe("Conventional single-line commit message."),
    },
    outputSchema: resultOutputSchema({
      branch: z.string(),
      commit: z.string(),
    }),
    annotations: writeAnnotations,
  }, async ({ workspace_id, message }) => {
    const started = performance.now();
    const workspace = await workspaces.getWorkspace(workspace_id);
    const { branch, commit, files } = await commitGitChanges(workspace.root, message);

    return {
      ...respond("git_commit", workspace_id, started, `Committed ${files.length} files on ${branch}: ${commit}`),
      structuredContent: {
        result: `Committed ${files.length} files on ${branch}: ${commit}`,
        branch, commit,
      },
    };
  });

  server.registerTool("git_push", {
    title: "Push Git feature branch",
    description: "PUBLISHES code to origin. Use only with explicit user approval. Requires confirmed=true and exact reviewed HEAD SHA. Never force-pushes or pushes to main/master.",
    inputSchema: {
      workspace_id,
      branch: z.string().min(2),
      expected_head: z.string().describe("Exact HEAD commit SHA previously returned by git_commit or git rev-parse HEAD."),
      confirmed: z.literal(true).describe("Set only after the user approves publishing this branch to origin."),
    },
    outputSchema: resultOutputSchema(),
    annotations: publishAnnotations,
  }, async ({ workspace_id, branch, expected_head, confirmed }) => {
    const started = performance.now();
    const workspace = await workspaces.getWorkspace(workspace_id);
    const result = await pushGitBranch(workspace.root, branch, expected_head, confirmed);

    return respond("git_push", workspace_id, started, result);
  });

  server.registerTool("github_create_pull_request", {
    title: "Create GitHub pull request",
    description: "PUBLISHES a GitHub pull request through the authenticated gh CLI. Requires explicit user approval and a previously pushed feature branch.",
    inputSchema: {
      workspace_id,
      base: z.string().min(2).describe("Base branch, usually main."),
      title: z.string().min(1).max(180),
      body: z.string().min(1).max(20_000),
      confirmed: z.literal(true).describe("Set only after the user approves opening this PR."),
    },
    outputSchema: resultOutputSchema(),
    annotations: publishAnnotations,
  }, async ({ workspace_id, base, title, body, confirmed }) => {
    const started = performance.now();
    const workspace = await workspaces.getWorkspace(workspace_id);
    const result = await createGitHubPullRequest(workspace.root, { base, title, body, confirmed });

    return respond("github_create_pull_request", workspace_id, started, result);
  });
}
