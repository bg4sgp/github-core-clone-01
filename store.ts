// The forge's state: one object store for every git object, and one record per repository holding
// its refs, labels, issues, pull requests and comments. Everything lives in memory; a trial starts
// the process fresh and the suite seeds what it needs through the API.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from a logical
// clock seeded by MAKEFUN_TRIAL_NOW (the instance's opening time) and advanced by hand, and every
// id comes from a counter, so two runs of the same trial see byte-identical answers.

import { createHash } from 'node:crypto';

/** The one account the token names: the trial scenario's viewer (wire.ts's seeded scenario). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** The four git object types. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** Every object the forge holds, by id; content-addressed, so repositories share it safely. */
export const objects = new Map<string, GitObject>();

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object (or find it already stored) and answer its id. */
export function putObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

export const ZERO_OID = '0'.repeat(40);
export const isOid = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

// ------------------------------------------------------------------ logical clock

/** The clock's current reading in milliseconds; seeded once, then advanced by `tick`. */
let clockMs = ((): number => {
  const trialNow = process.env.MAKEFUN_TRIAL_NOW;
  if (trialNow !== undefined && trialNow !== '') {
    const parsed = Date.parse(trialNow);
    if (Number.isFinite(parsed)) return parsed;
    const seconds = Number(trialNow);
    if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds) * 1000;
  }
  return Date.UTC(2026, 0, 1, 0, 0, 0);
})();

/** Advance the logical clock by one second and answer the new reading as an ISO string. */
export function tickIso(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

/** Advance the logical clock by one second and answer the new reading in epoch seconds. */
export function tickSeconds(): number {
  clockMs += 1000;
  return Math.floor(clockMs / 1000);
}

// ------------------------------------------------------------------ id counters

let nextRepoId = 1;
let nextEntityId = 1;
let nextRequestId = 1;

export function allocRepoId(): number {
  const id = nextRepoId;
  nextRepoId += 1;
  return id;
}

/** The global numeric id REST gives issues, pull requests and comments (stable across reads). */
export function allocEntityId(): number {
  const id = nextEntityId;
  nextEntityId += 1;
  return id;
}

/** A non-empty, unique-per-process request id for the X-GitHub-Request-Id header. */
export function allocRequestId(): string {
  const id = nextRequestId;
  nextRequestId += 1;
  return `forge-${id.toString(16).padStart(8, '0')}`;
}

// ------------------------------------------------------------------ commits and trees

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** The author's epoch-second timestamp, 0 when the line carries none. */
  readonly timestamp: number;
}

/** Parse a commit object; throws on a malformed header layout. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  const stamp = / (\d+) [+-]\d{4}$/.exec(author);
  return { tree, parents, author, committer, message, timestamp: stamp === null ? 0 : Number(stamp[1]) };
}

/** Parse a tag object into its target and type. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '' };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build and store a tree object from its entries; answers the tree's id. */
export function buildTree(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject('tree', Buffer.concat(parts));
}

/** Flatten a tree (recursively) into path -> blob entry. Gitlinks are skipped, as git does. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = getObject(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build and store a tree from a flat path -> blob id map; answers the root tree's id. */
export function treeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return buildTree(entries);
  };
  return build(root);
}

/** The identity REST- and merge-created commits carry: the viewer's, at the logical clock. */
export function viewerIdentityLine(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/** Build and store a commit object; the message is stored verbatim. Answers the commit's id. */
export function createCommit(fields: { tree: string; parents: readonly string[]; message: string }): string {
  const stamp = tickSeconds();
  const who = `${viewerIdentityLine()} ${stamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return putObject('commit', Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8'));
}

/** Follow a tag chain to the commit it names, or null when it does not end at a commit. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = getObject(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Every ancestor commit of `tip`, tip included (breadth-first, tip first). */
export function ancestorCommits(tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorCommits(descendant).includes(ancestor);
}

/** The best common ancestor of two commits, or null when they share none. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfA = new Set(ancestorCommits(a));
  for (const candidate of ancestorCommits(b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

/** Every object reachable from the given tips (commits, their trees and parents; tags peeled). */
export function collectReachable(tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      queue.push(...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ------------------------------------------------------------------ global (Relay) ids

/** An opaque, stable global id for a node: base64url of `<Type>:<key>`, never the plain number. */
export function globalId(type: string, key: string | number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id back into its type and key, or null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  return { type: text.slice(0, colon), key: text.slice(colon + 1) };
}

// ------------------------------------------------------------------ repositories

export interface Label {
  readonly id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  readonly id: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly createdAt: string;
  updatedAt: string;
  /** Creation order within the repository (issues and pulls share one sequence). */
  readonly seq: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name (refs/heads/...) -> object id. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  /** The number the next issue or pull request takes (GitHub numbers them from one sequence). */
  nextNumber: number;
  /** Monotonic creation sequence shared by issues and pulls. */
  nextSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

/** Every repository, keyed by `owner/name`. */
export const repos = new Map<string, Repo>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** The repository the token's owner holds under `name`, or undefined (any other owner is a 404). */
export function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}

export function createRepoRecord(fields: { name: string; description: string; isPrivate: boolean; defaultBranch: string }): Repo {
  const now = tickIso();
  const repo: Repo = {
    id: allocRepoId(),
    owner: VIEWER.login,
    name: fields.name,
    description: fields.description,
    isPrivate: fields.isPrivate,
    defaultBranch: fields.defaultBranch,
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextSeq: 1,
    createdAt: now,
    updatedAt: now,
  };
  repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

/** The commit a branch ref names, or undefined when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** The tree of a commit, or undefined. */
export function commitTree(oid: string): string | undefined {
  const object = getObject(oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.data).tree;
}
