// The REST v3 surface under /api/v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, in GitHub's shapes and statuses. Handlers are pure functions over
// store.ts's state; app.ts owns the HTTP framing (auth, the request-id header, JSON in and out).
//
// Contents, branch and merge writes are real git operations: they build blobs, trees and commits
// in the same object store the smart-HTTP surface serves, so a file written over REST is the file
// a clone fetches, and a squash merge lands a commit git can read.

import {
  VIEWER,
  ZERO_OID,
  branchTip,
  commitTree,
  createCommit,
  createRepoRecord,
  findRepo,
  flattenTree,
  getObject,
  globalId,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  repoKey,
  repos,
  tickIso,
  treeFromFiles,
  allocEntityId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestContext {
  readonly method: string;
  /** Percent-decoded path segments after /api/v3. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body, or undefined when the request carried none. */
  readonly body: unknown;
  /** The base URL the suite dialled (for absolute Link headers). */
  readonly base: string;
}

export interface RestReply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const invalid = (message: string): RestReply => ({ status: 422, body: { message } });

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ serializers

export function userJson(): Json {
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type };
}

export function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
  };
}

function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed' };
}

export function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(comment: { id: number; body: string; createdAt: string; updatedAt: string }): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function refJson(repo: Repo, ref: string): Json {
  const sha = branchTip(repo, ref) ?? ZERO_OID;
  return { ref, sha, label: `${repo.owner}:${ref}` };
}

export function pullJson(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: refJson(repo, pull.headRef),
    base: refJson(repo, pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ------------------------------------------------------------------ pagination

interface Page {
  readonly items: unknown[];
  readonly headers: Record<string, string>;
}

/** Slice a list by page/per_page and build the Link header GitHub paginates with. */
function paginate(ctx: RestContext, path: string, all: readonly unknown[]): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const url = (p: number): string => `${ctx.base}${path}?per_page=${perPage}&page=${p}`;
    headers.link = `<${url(page + 1)}>; rel="next", <${url(lastPage)}>; rel="last"`;
  }
  return { items, headers };
}

// ------------------------------------------------------------------ repositories

function createRepo(ctx: RestContext): RestReply {
  const name = stringField(ctx.body, 'name');
  if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
    return invalid('Repository creation failed: name is invalid');
  }
  if (repos.has(repoKey(VIEWER.login, name))) {
    return { status: 422, body: { message: 'Repository creation failed: name already exists on this account' } };
  }
  const isPrivate = isRecord(ctx.body) && typeof ctx.body.private === 'boolean' ? ctx.body.private : false;
  const repo = createRepoRecord({
    name,
    description: stringField(ctx.body, 'description') ?? '',
    isPrivate,
    defaultBranch: stringField(ctx.body, 'default_branch') ?? 'main',
  });
  return { status: 201, body: repoJson(repo) };
}

function listUserRepos(ctx: RestContext): RestReply {
  const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  const page = paginate(ctx, '/api/v3/user/repos', mine.map(repoJson));
  return { status: 200, body: page.items, headers: page.headers };
}

function patchRepo(ctx: RestContext, repo: Repo): RestReply {
  const description = stringField(ctx.body, 'description');
  if (description !== undefined) repo.description = description;
  if (isRecord(ctx.body) && typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
  const defaultBranch = stringField(ctx.body, 'default_branch');
  if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
  repo.updatedAt = tickIso();
  return { status: 200, body: repoJson(repo) };
}

// ------------------------------------------------------------------ branches, refs, commits

function listBranches(repo: Repo): RestReply {
  const branches: Json[] = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false });
  }
  return { status: 200, body: branches };
}

function getBranch(repo: Repo, branch: string): RestReply {
  const sha = branchTip(repo, branch);
  if (sha === undefined) return notFound();
  return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
}

function getGitRef(repo: Repo, ref: string): RestReply {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = getObject(oid);
  return { status: 200, body: { ref, object: { sha: oid, type: object?.type ?? 'commit' } } };
}

function createGitRef(ctx: RestContext, repo: Repo): RestReply {
  const ref = stringField(ctx.body, 'ref');
  const sha = stringField(ctx.body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isOid(sha)) {
    return invalid('Invalid ref or sha');
  }
  const object = getObject(sha);
  if (object === undefined) return invalid('Object does not exist');
  const existing = repo.refs.get(ref);
  if (existing !== undefined && existing !== sha) return invalid('Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, object: { sha, type: object.type } } };
}

/** One commit in the REST list shape, its author line split the way GitHub shows it. */
function commitJson(oid: string): Json {
  const object = getObject(oid);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const person = (line: string): Json => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    const stamp = match !== null ? Number(match[3]) : 0;
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date(stamp * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    commit: {
      message: commit?.message ?? '',
      author: person(commit?.author ?? ''),
      committer: person(commit?.committer ?? ''),
      tree: { sha: commit?.tree ?? ZERO_OID },
    },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

/** History from a tip, newest first (depth-first pre-order; exact on the linear histories here). */
function historyFrom(tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') return;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) walk(parent);
  };
  walk(tip);
  return order;
}

/** Resolve a `sha`/`ref` query value or branch name to a commit id in this repository. */
function resolveCommit(repo: Repo, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return branchTip(repo, repo.defaultBranch);
  const branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
  const tip = branchTip(repo, branch);
  if (tip !== undefined) return tip;
  if (isOid(value)) {
    const object = getObject(value);
    if (object !== undefined && object.type === 'commit') return value;
  }
  return undefined;
}

function listCommits(ctx: RestContext, repo: Repo): RestReply {
  const tip = resolveCommit(repo, ctx.query.get('sha') ?? undefined);
  if (tip === undefined) return { status: 200, body: [] };
  const page = paginate(ctx, '', historyFrom(tip).map(commitJson));
  return { status: 200, body: page.items, headers: page.headers };
}

// ------------------------------------------------------------------ contents

/** Walk a tree by path segments: a file, a directory, or nothing. */
function walkTree(
  treeOid: string,
  segments: readonly string[],
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; treeOid: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = getObject(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    const last = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return { kind: 'dir', treeOid: entry.oid };
      current = entry.oid;
    } else {
      return last ? { kind: 'file', oid: entry.oid, mode: entry.mode } : null;
    }
  }
  return { kind: 'dir', treeOid: current };
}

function getContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  const tip = resolveCommit(repo, ctx.query.get('ref') ?? undefined);
  if (tip === undefined) return notFound();
  const tree = commitTree(tip);
  if (tree === undefined) return notFound();
  const segments = path === '' ? [] : path.split('/');
  const found = walkTree(tree, segments);
  if (found === null) return notFound();
  if (found.kind === 'file') {
    const blob = getObject(found.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        name: segments[segments.length - 1] ?? '',
        path,
        sha: found.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      },
    };
  }
  const treeObject = getObject(found.treeOid);
  const entries = treeObject !== undefined && treeObject.type === 'tree' ? parseTree(treeObject.data) : [];
  return {
    status: 200,
    body: entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
    })),
  };
}

/** Commit a new flattened file set on a branch and move the ref; answers the commit id. */
function commitFiles(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const tip = branchTip(repo, branch);
  const tree = treeFromFiles(files);
  const commit = createCommit({ tree, parents: tip !== undefined ? [tip] : [], message });
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.updatedAt = tickIso();
  return commit;
}

function putContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  if (!isRecord(ctx.body)) return invalid('Invalid body');
  const content = stringField(ctx.body, 'content');
  if (content === undefined) return invalid('content is required');
  const branch = stringField(ctx.body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip !== undefined) {
    const tree = commitTree(tip);
    if (tree !== undefined) for (const [name, entry] of flattenTree(tree)) files.set(name, entry);
  }
  const existing = files.get(path);
  const expectedSha = stringField(ctx.body, 'sha');
  if (expectedSha !== undefined && (existing === undefined || existing.oid !== expectedSha)) {
    return { status: 409, body: { message: `${path} does not match ${expectedSha}` } };
  }
  const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  const blobOid = putObject('blob', data);
  files.set(path, { oid: blobOid, mode: '100644' });
  const commit = commitFiles(repo, branch, files, stringField(ctx.body, 'message') ?? '');
  return {
    status: existing !== undefined ? 200 : 201,
    body: {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit },
    },
  };
}

function deleteContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  if (!isRecord(ctx.body)) return invalid('Invalid body');
  const branch = stringField(ctx.body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) return notFound();
  const tree = commitTree(tip);
  const files = new Map<string, { oid: string; mode: string }>();
  if (tree !== undefined) for (const [name, entry] of flattenTree(tree)) files.set(name, entry);
  const existing = files.get(path);
  if (existing === undefined) return notFound();
  const expectedSha = stringField(ctx.body, 'sha');
  if (expectedSha !== undefined && expectedSha !== existing.oid) {
    return { status: 409, body: { message: `${path} does not match ${expectedSha}` } };
  }
  files.delete(path);
  const commit = commitFiles(repo, branch, files, stringField(ctx.body, 'message') ?? '');
  return { status: 200, body: { content: null, commit: { sha: commit } } };
}

// ------------------------------------------------------------------ labels

function createLabel(ctx: RestContext, repo: Repo): RestReply {
  const name = stringField(ctx.body, 'name');
  if (name === undefined || name === '') return invalid('name is required');
  if (repo.labels.has(name)) return invalid('Label already exists');
  const color = (stringField(ctx.body, 'color') ?? 'ededed').replace(/^#/, '');
  repo.labels.set(name, { id: allocEntityId(), name, color });
  return { status: 201, body: { id: repo.labels.get(name)?.id, name, color } };
}

function listLabels(repo: Repo): RestReply {
  return { status: 200, body: [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color })) };
}

/** The label names a request body names (strings, or objects with a name); null when malformed. */
function requestedLabels(body: unknown): string[] | null {
  if (!isRecord(body) || body.labels === undefined) return [];
  if (!Array.isArray(body.labels)) return null;
  const names: string[] = [];
  for (const entry of body.labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

// ------------------------------------------------------------------ issues and comments

function createIssue(ctx: RestContext, repo: Repo): RestReply {
  const title = stringField(ctx.body, 'title');
  if (title === undefined || title === '') return invalid('title is required');
  const labels = requestedLabels(ctx.body);
  if (labels === null) return invalid('labels are invalid');
  for (const name of labels) {
    if (!repo.labels.has(name)) return invalid(`Validation Failed: label '${name}' does not exist`);
  }
  const stamp = tickIso();
  const issue: Issue = {
    id: allocEntityId(),
    number: repo.nextNumber,
    title,
    body: stringField(ctx.body, 'body') ?? '',
    state: 'open',
    labels,
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
    seq: repo.nextSeq,
  };
  repo.nextNumber += 1;
  repo.nextSeq += 1;
  repo.issues.set(issue.number, issue);
  return { status: 201, body: issueJson(repo, issue) };
}

function listIssues(ctx: RestContext, repo: Repo): RestReply {
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = ctx.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const page = paginate(ctx, '', issues.map((issue) => issueJson(repo, issue)));
  return { status: 200, body: page.items, headers: page.headers };
}

function patchIssue(ctx: RestContext, repo: Repo, issue: Issue): RestReply {
  const state = stringField(ctx.body, 'state');
  if (state !== undefined) {
    if (state !== 'open' && state !== 'closed') return invalid('state is invalid');
    issue.state = state;
  }
  const title = stringField(ctx.body, 'title');
  if (title !== undefined) issue.title = title;
  const bodyText = stringField(ctx.body, 'body');
  if (bodyText !== undefined) issue.body = bodyText;
  const labels = requestedLabels(ctx.body);
  if (labels === null) return invalid('labels are invalid');
  if (isRecord(ctx.body) && ctx.body.labels !== undefined) {
    for (const name of labels) {
      if (!repo.labels.has(name)) return invalid(`Validation Failed: label '${name}' does not exist`);
    }
    issue.labels = labels;
  }
  issue.updatedAt = tickIso();
  return { status: 200, body: issueJson(repo, issue) };
}

function createComment(ctx: RestContext, repo: Repo, issue: Issue): RestReply {
  const bodyText = stringField(ctx.body, 'body');
  if (bodyText === undefined) return invalid('body is required');
  const stamp = tickIso();
  const comment = { id: allocEntityId(), body: bodyText, createdAt: stamp, updatedAt: stamp };
  issue.comments.push(comment);
  issue.updatedAt = stamp;
  void repo;
  return { status: 201, body: commentJson(comment) };
}

function listComments(repo: Repo, issue: Issue): RestReply {
  const sorted = [...issue.comments].sort((a, b) => a.id - b.id);
  return { status: 200, body: sorted.map((comment) => commentJson(comment)) };
}

// ------------------------------------------------------------------ pull requests

/** Strip an optional `owner:` prefix from a head/base value, leaving the branch name. */
function branchName(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function createPull(ctx: RestContext, repo: Repo): RestReply {
  const headRaw = stringField(ctx.body, 'head');
  const baseRaw = stringField(ctx.body, 'base');
  if (headRaw === undefined || baseRaw === undefined) return invalid('head and base are required');
  const head = branchName(headRaw);
  const base = branchName(baseRaw);
  if (branchTip(repo, head) === undefined) return invalid(`Head branch '${head}' does not exist`);
  if (branchTip(repo, base) === undefined) return invalid(`Base branch '${base}' does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return invalid('A pull request already exists for this branch');
    }
  }
  const stamp = tickIso();
  const pull: Pull = {
    id: allocEntityId(),
    number: repo.nextNumber,
    title: stringField(ctx.body, 'title') ?? '',
    body: stringField(ctx.body, 'body') ?? '',
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
  return { status: 201, body: pullJson(repo, pull) };
}

function listPulls(ctx: RestContext, repo: Repo): RestReply {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => a.seq - b.seq);
  const page = paginate(ctx, '', pulls.map((pull) => pullJson(repo, pull)));
  return { status: 200, body: page.items, headers: page.headers };
}

/** Line counts of a change between two texts, from a longest-common-subsequence diff. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? (dp[i + 1][j + 1] as number) + 1 : Math.max(dp[i + 1][j] as number, dp[i][j + 1] as number);
    }
  }
  const common = dp[0][0] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function filesOf(commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  const files = new Map<string, { oid: string; mode: string }>();
  if (commitOid === undefined) return files;
  const tree = commitTree(commitOid);
  if (tree === undefined) return files;
  for (const [name, entry] of flattenTree(tree)) files.set(name, entry);
  return files;
}

function textOf(oid: string): string {
  const object = getObject(oid);
  return object !== undefined && object.type === 'blob' ? object.data.toString('utf8') : '';
}

/** The three-way file diff of a pull request: merge-base files against head files. */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(baseTip, headTip);
  const from = filesOf(base ?? undefined);
  const to = filesOf(headTip);
  const changes: FileChange[] = [];
  for (const name of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const before = from.get(name);
    const after = to.get(name);
    if (before !== undefined && after === undefined) {
      const diff = lineDiff(textOf(before.oid), '');
      changes.push({ filename: name, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
    } else if (before === undefined && after !== undefined) {
      const diff = lineDiff('', textOf(after.oid));
      changes.push({ filename: name, status: 'added', additions: diff.additions, deletions: 0, changes: diff.additions });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      const diff = lineDiff(textOf(before.oid), textOf(after.oid));
      changes.push({ filename: name, status: 'modified', ...diff, changes: diff.additions + diff.deletions });
    }
  }
  return changes;
}

/** Three-way merge of flattened trees; null when any file conflicts. */
function mergeTrees(
  base: Map<string, { oid: string; mode: string }>,
  ours: Map<string, { oid: string; mode: string }>,
  theirs: Map<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const merged = new Map<string, { oid: string; mode: string }>();
  const names = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const name of names) {
    const b = base.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(o, t)) {
      if (o !== undefined) merged.set(name, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(name, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(name, o);
    } else {
      return null;
    }
  }
  return merged;
}

export type MergeOutcome =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: 'missing' | 'not-open' | 'conflict' };

/** Squash-merge a pull request onto its base branch; shared by the REST and GraphQL surfaces. */
export function mergePull(repo: Repo, pull: Pull): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'missing' };
  const base = mergeBase(baseTip, headTip);
  const mergedFiles = mergeTrees(filesOf(base ?? undefined), filesOf(baseTip), filesOf(headTip));
  if (mergedFiles === null) return { ok: false, reason: 'conflict' };
  const tree = treeFromFiles(mergedFiles);
  const sha = createCommit({ tree, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = tickIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = sha;
  pull.updatedAt = stamp;
  repo.updatedAt = stamp;
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.merged) return true;
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(baseTip, headTip);
  return mergeTrees(filesOf(base ?? undefined), filesOf(baseTip), filesOf(headTip)) !== null;
}

function mergePullRest(repo: Repo, pull: Pull): RestReply {
  const outcome = mergePull(repo, pull);
  if (!outcome.ok) {
    if (outcome.reason === 'not-open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    if (outcome.reason === 'missing') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ------------------------------------------------------------------ routing

/** Route one REST request; answers a reply for everything under /api/v3. */
export function handleRest(ctx: RestContext): RestReply {
  const { method, segments } = ctx;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: `${ctx.base}/api/v3/user`,
        repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${ctx.base}/api/v3/rate_limit`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { verifiable_password_authentication: false, installed_version: '1.0.0-makefun-forge' } };
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { ...userJson(), name: VIEWER.name, email: VIEWER.email } };
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(ctx);
    if (method === 'GET') return listUserRepos(ctx);
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const repo = findRepo(segments[1] as string, segments[2] as string);
  if (repo === undefined) return notFound();
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      return { status: 204 };
    }
    return notFound();
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(repo);
    if (rest.length >= 2 && method === 'GET') return getBranch(repo, rest.slice(1).join('/'));
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') return createGitRef(ctx, repo);
    if (rest.length >= 3 && method === 'GET') return getGitRef(repo, `refs/${rest.slice(2).join('/')}`);
    return notFound();
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(ctx, repo);

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return notFound();
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') return createLabel(ctx, repo);
    if (rest.length === 1 && method === 'GET') return listLabels(repo);
    return notFound();
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(ctx, repo);
      if (method === 'GET') return listIssues(ctx, repo);
      return notFound();
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (issue === undefined) return notFound();
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') return patchIssue(ctx, repo, issue);
      return notFound();
    }
    if (rest[2] === 'comments' && rest.length === 3) {
      if (method === 'POST') return createComment(ctx, repo, issue);
      if (method === 'GET') return listComments(repo, issue);
      return notFound();
    }
    return notFound();
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(ctx, repo);
      if (method === 'GET') return listPulls(ctx, repo);
      return notFound();
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (pull === undefined) return notFound();
    if (rest.length === 2 && method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return {
        status: 200,
        body: pullFiles(repo, pull).map((change) => ({
          filename: change.filename,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
          sha: '',
        })),
      };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePullRest(repo, pull);
    return notFound();
  }

  return notFound();
}
