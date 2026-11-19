// The MCP surface at /mcp: JSON-RPC 2.0 in the shapes the suite's client speaks — server/discover
// and initialize handshakes, a constant tools/list, and tools/call for the six repository tools.
// Every tool acts on the same store as REST and GraphQL, and a tool result carries the object both
// as JSON text content and as structuredContent, the way the github-mcp-server shapes it.

import {
  VIEWER,
  branchTip,
  createRepoRecord,
  findRepo,
  repoKey,
  repos,
  tickIso,
  allocEntityId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';

export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

/** The six tools, in a fixed order; tools/list must be byte-identical across calls. */
const TOOLS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body text of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The name of the branch to merge from.' },
      base: { type: 'string', description: 'The name of the branch to merge into.' },
      body: { type: 'string', description: 'The body text of the pull request.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([name, spec]) => [name, { type: spec.type, description: spec.description }]),
      ),
      required: [...tool.required],
    },
  }));
}

// ------------------------------------------------------------------ results

interface RpcOutcome {
  readonly status: number;
  readonly body?: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/** A successful tool call: the object as JSON text and as structuredContent. */
function toolOk(id: unknown, value: unknown): RpcOutcome {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  });
}

/** A failed tool call: an isError result, not a protocol error. */
function toolError(id: unknown, message: string): RpcOutcome {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

// ------------------------------------------------------------------ tools

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function repoArg(args: Record<string, unknown>): Repo | undefined {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner === undefined || repo === undefined) return undefined;
  return findRepo(owner, repo);
}

function callTool(id: unknown, name: string, args: Record<string, unknown>): RpcOutcome {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (spec === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  for (const required of spec.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(id, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name') as string;
      if (repos.has(repoKey(VIEWER.login, repoName))) return toolError(id, 'Repository already exists');
      const repo = createRepoRecord({
        name: repoName,
        description: stringArg(args, 'description') ?? '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
        defaultBranch: 'main',
      });
      return toolOk(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (repo === undefined) return toolError(id, 'Repository not found');
      return toolOk(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (repo === undefined) return toolError(id, 'Repository not found');
      const stamp = tickIso();
      const issue: Issue = {
        id: allocEntityId(),
        number: repo.nextNumber,
        title: stringArg(args, 'title') as string,
        body: stringArg(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        seq: repo.nextSeq,
      };
      repo.nextNumber += 1;
      repo.nextSeq += 1;
      repo.issues.set(issue.number, issue);
      return toolOk(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (repo === undefined) return toolError(id, 'Repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return toolOk(id, issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (repo === undefined) return toolError(id, 'Repository not found');
      const head = (stringArg(args, 'head') as string).replace(/^refs\/heads\//, '');
      const base = (stringArg(args, 'base') as string).replace(/^refs\/heads\//, '');
      if (branchTip(repo, head) === undefined) return toolError(id, `Head branch '${head}' does not exist`);
      if (branchTip(repo, base) === undefined) return toolError(id, `Base branch '${base}' does not exist`);
      const stamp = tickIso();
      const pull: Pull = {
        id: allocEntityId(),
        number: repo.nextNumber,
        title: stringArg(args, 'title') as string,
        body: stringArg(args, 'body') ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: stamp,
        updatedAt: stamp,
        seq: repo.nextSeq,
      };
      repo.nextNumber += 1;
      repo.nextSeq += 1;
      repo.pulls.set(pull.number, pull);
      return toolOk(id, pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (repo === undefined) return toolError(id, 'Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError(id, 'Pull request not found');
      const outcome = mergePull(repo, pull);
      if (!outcome.ok) return toolError(id, 'Pull Request is not mergeable');
      return toolOk(id, { ...pullJson(repo, pull), sha: outcome.sha });
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------------ dispatch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Handle one MCP request. `rawBody` is the exact request text: a body that is not JSON at all is a
 * -32700 parse error, which a pre-parsed body could not distinguish from a JSON `null`.
 */
export function handleMcp(rawBody: string): RpcOutcome {
  let message: unknown;
  try {
    message = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(message)) {
    const replies: unknown[] = [];
    for (const entry of message) {
      const outcome = dispatch(entry);
      if (outcome.body !== undefined) replies.push(outcome.body);
    }
    return { status: 200, body: replies };
  }
  return dispatch(message);
}

function dispatch(message: unknown): RpcOutcome {
  if (!isRecord(message) || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const method = message.method;
  const id = message.id;
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    return rpcResult(id ?? null, {
      supportedVersions: [...MCP_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...MCP_SERVER_INFO },
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
    });
  }
  if (method === 'initialize') {
    const params = isRecord(message.params) ? message.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const version =
      requested !== undefined && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSIONS[0];
    return rpcResult(id ?? null, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { ...MCP_SERVER_INFO },
    });
  }
  if (method.startsWith('notifications/')) return { status: 202 };
  if (isNotification) return { status: 202 };

  switch (method) {
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call': {
      const params = isRecord(message.params) ? message.params : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      return callTool(id, name, args);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
