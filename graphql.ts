// The GraphQL v4 surface at /api/graphql: a small hand-rolled parser and executor covering exactly
// the documents the suite sends (the github-mcp-server / gh shapes): viewer, repository lookups,
// node(id:), issues and pullRequests connections with cursors, the five mutations the checks use,
// __type introspection, and field-error reporting that names unknown fields the way GitHub does.
//
// Everything resolves against the same store as REST, and global ids are store.ts's base64url
// `Type:key` tokens, so an id read here is the id REST's node_id carries and vice versa.

import {
  VIEWER,
  branchTip,
  findRepo,
  globalId,
  parseGlobalId,
  repos,
  repoKey,
  tickIso,
  allocEntityId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { mergePull, pullFiles, pullMergeable } from './rest.ts';

// ------------------------------------------------------------------ syntax tree

type Value =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly values: readonly Value[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ name: string; value: Value }> };

interface FieldNode {
  readonly name: string;
  readonly alias?: string;
  readonly args: ReadonlyArray<{ name: string; value: Value }>;
  readonly selections: readonly Selection[];
}

type Selection =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'inline'; readonly typeCondition: string; readonly selections: readonly Selection[] }
  | { readonly kind: 'spread'; readonly name: string };

interface Operation {
  readonly type: 'query' | 'mutation';
  readonly name?: string;
  readonly selections: readonly Selection[];
}

interface Document {
  readonly operations: readonly Operation[];
  readonly fragments: ReadonlyMap<string, { typeCondition: string; selections: readonly Selection[] }>;
}

// ------------------------------------------------------------------ lexer

interface Token {
  readonly kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  readonly value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '.') {
      if (source.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      throw new Error(`unexpected '.' at ${i}`);
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (esc in escapes) {
            out += escapes[esc];
            j += 2;
          } else {
            throw new Error(`bad escape \\${esc}`);
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', got '${token.value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got '${token.value}'`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: readonly Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token '${token.value}' at document level`);
      }
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { name, alias, args, selections } };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

// ------------------------------------------------------------------ values

type Variables = Readonly<Record<string, unknown>>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argOf(field: FieldNode, name: string, variables: Variables): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, variables);
}

function stringArg(field: FieldNode, name: string, variables: Variables): string | undefined {
  const value = argOf(field, name, variables);
  return typeof value === 'string' ? value : undefined;
}

function intArg(field: FieldNode, name: string, variables: Variables): number | undefined {
  const value = argOf(field, name, variables);
  return typeof value === 'number' ? value : undefined;
}

// ------------------------------------------------------------------ schema (for introspection and field validation)

interface TypeInfo {
  readonly kind: 'OBJECT' | 'ENUM';
  readonly fields?: readonly string[];
  readonly enumValues?: readonly string[];
}

const SCHEMA: Readonly<Record<string, TypeInfo>> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description',
      'createdAt', 'updatedAt', 'url',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'headRefOid', 'baseRefOid', 'mergeCommit', 'files', 'url', 'author', 'repository', 'createdAt', 'updatedAt',
    ],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'type', 'args'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'type'] },
  __Schema: { kind: 'OBJECT', fields: ['queryType', 'mutationType', 'types'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  MergePullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'REBASE', 'SQUASH'] },
};

// ------------------------------------------------------------------ execution

interface Ctx {
  readonly variables: Variables;
  readonly fragments: Document['fragments'];
  readonly errors: Array<{ message: string }>;
}

/** A resolved node: its GraphQL type plus the record it wraps. */
interface Node {
  readonly type: string;
  readonly repo?: Repo;
  readonly issue?: Issue;
  readonly pull?: Pull;
  readonly comment?: { id: number; body: string; createdAt: string; updatedAt: string };
  readonly raw?: unknown;
}

function repoNodeId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueNodeId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullNodeId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function commentNodeId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.id}:${issue.number}:${commentId}`);
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

/** Resolve a global id to the node it names, across the whole forge. */
function nodeById(id: string): Node | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const parts = parsed.key.split(':');
  if (parsed.type === 'Repository') {
    const repo = findRepoById(Number(parts[0]));
    return repo === undefined ? null : { type: 'Repository', repo };
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const repo = findRepoById(Number(parts[0]));
    if (repo === undefined) return null;
    const number = Number(parts[1]);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { type: 'Issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { type: 'PullRequest', repo, pull };
  }
  if (parsed.type === 'IssueComment') {
    const repo = findRepoById(Number(parts[0]));
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number(parts[1]));
    const comment = issue?.comments.find((candidate) => candidate.id === Number(parts[2]));
    if (issue === undefined || comment === undefined) return null;
    return { type: 'IssueComment', repo, issue, comment };
  }
  if (parsed.type === 'User') return { type: 'User' };
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Connection<T> {
  readonly nodes: readonly T[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly totalCount: number;
}

/** Slice a number-ordered list the way a `first`/`after` connection does. */
function paginateByNumber<T extends { number: number }>(
  all: readonly T[],
  first: number | undefined,
  after: string | undefined,
  descending: boolean,
): Connection<T> {
  const ordered = [...all].sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  let startIndex = 0;
  if (after !== undefined) {
    const afterNumber = numberFromCursor(after);
    const found = afterNumber === null ? -1 : ordered.findIndex((entry) => entry.number === afterNumber);
    startIndex = found >= 0 ? found + 1 : ordered.length;
  }
  const limit = first === undefined ? ordered.length : Math.max(0, first);
  const nodes = ordered.slice(startIndex, startIndex + limit);
  const last = nodes[nodes.length - 1];
  return {
    nodes,
    hasNextPage: startIndex + nodes.length < ordered.length,
    endCursor: last === undefined ? null : cursorFor(last.number),
    totalCount: ordered.length,
  };
}

function connectionJson<T>(connection: Connection<T>, field: FieldNode, ctx: Ctx, wrap: (item: T) => Node): unknown {
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind !== 'field') continue;
    const name = selection.field.name;
    const key = selection.field.alias ?? name;
    if (name === 'nodes') {
      out[key] = connection.nodes.map((item) => executeSelections(wrap(item), selection.field.selections, ctx));
    } else if (name === 'pageInfo') {
      out[key] = executeSelections(
        { type: 'PageInfo', raw: { hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: connection.endCursor, endCursor: connection.endCursor } },
        selection.field.selections,
        ctx,
      );
    } else if (name === 'totalCount') {
      out[key] = connection.totalCount;
    } else if (name === 'edges') {
      out[key] = connection.nodes.map((item) => ({ node: executeSelections(wrap(item), [], ctx), cursor: cursorFor((item as { number: number }).number) }));
    } else {
      ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Connection'` });
      out[key] = null;
    }
  }
  return out;
}

/** Execute a selection set against a node, validating field names against the schema. */
function executeSelections(node: Node, selections: readonly Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const expanded: FieldNode[] = [];
  const expand = (list: readonly Selection[], typeName: string): void => {
    for (const selection of list) {
      if (selection.kind === 'field') expanded.push(selection.field);
      else if (selection.kind === 'inline') {
        if (selection.typeCondition === typeName) expand(selection.selections, typeName);
      } else {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined && fragment.typeCondition === typeName) expand(fragment.selections, typeName);
      }
    }
  };
  expand(selections, node.type);
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    out[key] = resolveField(node, field, ctx);
  }
  return out;
}

function resolveField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return node.type;
  const typeInfo = SCHEMA[node.type];
  if (typeInfo !== undefined && typeInfo.fields !== undefined && !typeInfo.fields.includes(name)) {
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${node.type}'` });
    return null;
  }
  switch (node.type) {
    case 'Query':
      return resolveQueryField(field, ctx);
    case 'Mutation':
      return resolveMutationField(field, ctx);
    case 'User':
      return resolveUserField(name);
    case 'Repository':
      return resolveRepositoryField(node, field, ctx);
    case 'Ref':
      return resolveRefField(node, name);
    case 'Issue':
      return resolveIssueField(node, field, ctx);
    case 'PullRequest':
      return resolvePullField(node, field, ctx);
    case 'IssueComment':
      return resolveCommentField(node, name);
    case 'PageInfo': {
      const raw = node.raw as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (name === 'hasNextPage') return raw.hasNextPage;
      if (name === 'hasPreviousPage') return raw.hasPreviousPage;
      if (name === 'startCursor') return raw.startCursor;
      if (name === 'endCursor') return raw.endCursor;
      return null;
    }
    case '__Type':
      return resolveTypeField(node, field, ctx);
    case '__Field': {
      const raw = node.raw as { name: string };
      if (name === 'name') return raw.name;
      if (name === 'type') return executeSelections({ type: '__Type', raw: { name: 'String', kind: 'SCALAR' } }, field.selections, ctx);
      if (name === 'args') return [];
      return null;
    }
    case '__EnumValue': {
      const raw = node.raw as { name: string };
      return name === 'name' ? raw.name : null;
    }
    case '__Schema': {
      if (name === 'queryType') return executeSelections({ type: '__Type', raw: { name: 'Query', kind: 'OBJECT' } }, field.selections, ctx);
      if (name === 'mutationType') return executeSelections({ type: '__Type', raw: { name: 'Mutation', kind: 'OBJECT' } }, field.selections, ctx);
      if (name === 'types') return [];
      return null;
    }
    default:
      if (node.raw !== undefined && typeof node.raw === 'object' && node.raw !== null && name in (node.raw as Record<string, unknown>)) {
        return (node.raw as Record<string, unknown>)[name];
      }
      return null;
  }
}

function resolveUserField(name: string): unknown {
  switch (name) {
    case 'id':
      return globalId('User', VIEWER.id);
    case 'login':
      return VIEWER.login;
    case 'name':
      return VIEWER.name;
    case 'email':
      return VIEWER.email;
    default:
      return null;
  }
}

function resolveRefField(node: Node, name: string): unknown {
  const raw = node.raw as { name: string };
  switch (name) {
    case 'id':
      return globalId('Ref', raw.name);
    case 'name':
      return raw.name;
    case 'prefix':
      return 'refs/heads/';
    default:
      return null;
  }
}

function resolveCommentField(node: Node, name: string): unknown {
  const comment = node.comment as { id: number; body: string; createdAt: string; updatedAt: string };
  switch (name) {
    case 'id':
      return commentNodeId(node.repo as Repo, node.issue as Issue, comment.id);
    case 'databaseId':
      return comment.id;
    case 'body':
      return comment.body;
    case 'author':
      return { login: VIEWER.login };
    case 'createdAt':
      return comment.createdAt;
    case 'updatedAt':
      return comment.updatedAt;
    default:
      return null;
  }
}

function resolveIssueField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const repo = node.repo as Repo;
  const issue = node.issue as Issue;
  switch (field.name) {
    case 'id':
      return issueNodeId(repo, issue);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'body':
      return issue.body;
    case 'url':
      return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'author':
      return executeSelections({ type: 'User' }, field.selections, ctx);
    case 'repository':
      return executeSelections({ type: 'Repository', repo }, field.selections, ctx);
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    default:
      return null;
  }
}

function resolvePullField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const repo = node.repo as Repo;
  const pull = node.pull as Pull;
  switch (field.name) {
    case 'id':
      return pullNodeId(repo, pull);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid':
      return branchTip(repo, pull.headRef) ?? null;
    case 'baseRefOid':
      return branchTip(repo, pull.baseRef) ?? null;
    case 'mergeCommit':
      return pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha };
    case 'files': {
      const files = pullFilesList(repo, pull);
      const first = intArg(field, 'first', ctx.variables);
      const sliced = first === undefined ? files : files.slice(0, Math.max(0, first));
      const connection: Connection<{ path: string; additions: number; deletions: number }> = {
        nodes: sliced,
        hasNextPage: sliced.length < files.length,
        endCursor: null,
        totalCount: files.length,
      };
      return connectionJson(connection, field, ctx, (file) => ({ type: 'PullRequestChangedFile', raw: file }));
    }
    case 'url':
      return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'author':
      return executeSelections({ type: 'User' }, field.selections, ctx);
    case 'repository':
      return executeSelections({ type: 'Repository', repo }, field.selections, ctx);
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    default:
      return null;
  }
}

function pullFilesList(repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number }> {
  return pullFiles(repo, pull).map((change) => ({ path: change.filename, additions: change.additions, deletions: change.deletions }));
}

function resolveRepositoryField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const repo = node.repo as Repo;
  switch (field.name) {
    case 'id':
      return repoNodeId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repoKey(repo.owner, repo.name);
    case 'owner':
      return executeSelections({ type: 'User' }, field.selections, ctx);
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === undefined) return null;
      return executeSelections({ type: 'Ref', raw: { name: repo.defaultBranch } }, field.selections, ctx);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'isPrivate':
      return repo.isPrivate;
    case 'description':
      return repo.description;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'url':
      return `https://forge.invalid/${repo.owner}/${repo.name}`;
    case 'issue': {
      const number = intArg(field, 'number', ctx.variables);
      const issue = number === undefined ? undefined : repo.issues.get(number);
      return issue === undefined ? null : executeSelections({ type: 'Issue', repo, issue }, field.selections, ctx);
    }
    case 'issues': {
      const states = argOf(field, 'states', ctx.variables);
      let issues = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = argOf(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
      const descending = orderBy?.direction === 'DESC';
      const connection = paginateByNumber(issues, intArg(field, 'first', ctx.variables), stringArg(field, 'after', ctx.variables), descending);
      return connectionJson(connection, field, ctx, (issue) => ({ type: 'Issue', repo, issue }));
    }
    case 'pullRequest': {
      const number = intArg(field, 'number', ctx.variables);
      const pull = number === undefined ? undefined : repo.pulls.get(number);
      return pull === undefined ? null : executeSelections({ type: 'PullRequest', repo, pull }, field.selections, ctx);
    }
    case 'pullRequests': {
      const states = argOf(field, 'states', ctx.variables);
      let pulls = [...repo.pulls.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state)));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const connection = paginateByNumber(pulls, intArg(field, 'first', ctx.variables), stringArg(field, 'after', ctx.variables), false);
      return connectionJson(connection, field, ctx, (pull) => ({ type: 'PullRequest', repo, pull }));
    }
    default:
      return null;
  }
}

function resolveQueryField(field: FieldNode, ctx: Ctx): unknown {
  switch (field.name) {
    case 'viewer':
      return executeSelections({ type: 'User' }, field.selections, ctx);
    case 'repository': {
      const owner = stringArg(field, 'owner', ctx.variables);
      const name = stringArg(field, 'name', ctx.variables);
      if (owner === undefined || name === undefined) return null;
      const repo = findRepo(owner, name);
      return repo === undefined ? null : executeSelections({ type: 'Repository', repo }, field.selections, ctx);
    }
    case 'node': {
      const id = stringArg(field, 'id', ctx.variables);
      if (id === undefined) return null;
      const node = nodeById(id);
      return node === null ? null : executeSelections(node, field.selections, ctx);
    }
    case '__type': {
      const name = stringArg(field, 'name', ctx.variables);
      if (name === undefined || !(name in SCHEMA)) return null;
      return executeSelections({ type: '__Type', raw: { name, kind: (SCHEMA[name] as TypeInfo).kind } }, field.selections, ctx);
    }
    case '__schema':
      return executeSelections({ type: '__Schema' }, field.selections, ctx);
    default:
      return null;
  }
}

function resolveTypeField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const raw = node.raw as { name: string; kind: string };
  const info = SCHEMA[raw.name];
  switch (field.name) {
    case 'name':
      return raw.name;
    case 'kind':
      return raw.kind;
    case 'fields':
      return (info?.fields ?? []).map((fieldName) =>
        executeSelections({ type: '__Field', raw: { name: fieldName } }, field.selections, ctx),
      );
    case 'enumValues':
      return (info?.enumValues ?? []).map((value) =>
        executeSelections({ type: '__EnumValue', raw: { name: value } }, field.selections, ctx),
      );
    case 'possibleTypes':
      return [];
    default:
      return null;
  }
}

// ------------------------------------------------------------------ mutations

function inputOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const input = argOf(field, 'input', ctx.variables);
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function repoFromId(idValue: unknown, ctx: Ctx): Repo | undefined {
  if (typeof idValue !== 'string') {
    ctx.errors.push({ message: 'repositoryId is required' });
    return undefined;
  }
  const node = nodeById(idValue);
  if (node === null || node.type !== 'Repository' || node.repo === undefined) {
    ctx.errors.push({ message: `Could not resolve to a Repository with the id '${idValue}'` });
    return undefined;
  }
  return node.repo;
}

function payloadWith(
  payloadType: string,
  innerType: string,
  inner: Node | null,
  innerKey: string,
  field: FieldNode,
  ctx: Ctx,
): unknown {
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.field.alias ?? selection.field.name;
    if (selection.field.name === innerKey) {
      out[key] = inner === null ? null : executeSelections(inner, selection.field.selections, ctx);
    } else if (selection.field.name === 'clientMutationId') {
      out[key] = null;
    } else if (selection.field.name === 'commentEdge' && inner !== null) {
      out[key] = executeSelections(inner, selection.field.selections, ctx);
    } else {
      ctx.errors.push({ message: `Field '${selection.field.name}' doesn't exist on type '${payloadType}'` });
      out[key] = null;
    }
  }
  void innerType;
  return out;
}

function resolveMutationField(field: FieldNode, ctx: Ctx): unknown {
  const input = inputOf(field, ctx);
  switch (field.name) {
    case 'createIssue': {
      const repo = repoFromId(input.repositoryId, ctx);
      if (repo === undefined) return payloadWith('CreateIssuePayload', 'Issue', null, 'issue', field, ctx);
      const stamp = tickIso();
      const issue: Issue = {
        id: allocEntityId(),
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
      return payloadWith('CreateIssuePayload', 'Issue', { type: 'Issue', repo, issue }, 'issue', field, ctx);
    }
    case 'closeIssue': {
      const issueNode = typeof input.issueId === 'string' ? nodeById(input.issueId) : null;
      if (issueNode === null || issueNode.issue === undefined || issueNode.repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue' });
        return payloadWith('CloseIssuePayload', 'Issue', null, 'issue', field, ctx);
      }
      issueNode.issue.state = 'closed';
      issueNode.issue.updatedAt = tickIso();
      return payloadWith('CloseIssuePayload', 'Issue', issueNode, 'issue', field, ctx);
    }
    case 'createPullRequest': {
      const repo = repoFromId(input.repositoryId, ctx);
      if (repo === undefined) return payloadWith('CreatePullRequestPayload', 'PullRequest', null, 'pullRequest', field, ctx);
      const head = typeof input.headRefName === 'string' ? input.headRefName.replace(/^refs\/heads\//, '') : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName.replace(/^refs\/heads\//, '') : '';
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        ctx.errors.push({ message: 'Head or base ref does not exist' });
        return payloadWith('CreatePullRequestPayload', 'PullRequest', null, 'pullRequest', field, ctx);
      }
      const stamp = tickIso();
      const pull: Pull = {
        id: allocEntityId(),
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
      return payloadWith('CreatePullRequestPayload', 'PullRequest', { type: 'PullRequest', repo, pull }, 'pullRequest', field, ctx);
    }
    case 'mergePullRequest': {
      const pullNode = typeof input.pullRequestId === 'string' ? nodeById(input.pullRequestId) : null;
      if (pullNode === null || pullNode.pull === undefined || pullNode.repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest' });
        return payloadWith('MergePullRequestPayload', 'PullRequest', null, 'pullRequest', field, ctx);
      }
      const outcome = mergePull(pullNode.repo, pullNode.pull);
      if (!outcome.ok) {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return payloadWith('MergePullRequestPayload', 'PullRequest', null, 'pullRequest', field, ctx);
      }
      return payloadWith('MergePullRequestPayload', 'PullRequest', pullNode, 'pullRequest', field, ctx);
    }
    case 'addComment': {
      const subject = typeof input.subjectId === 'string' ? nodeById(input.subjectId) : null;
      if (subject === null || subject.issue === undefined || subject.repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue' });
        return payloadWith('AddCommentPayload', 'IssueComment', null, 'commentEdge', field, ctx);
      }
      const stamp = tickIso();
      const comment = {
        id: allocEntityId(),
        body: typeof input.body === 'string' ? input.body : '',
        createdAt: stamp,
        updatedAt: stamp,
      };
      subject.issue.comments.push(comment);
      subject.issue.updatedAt = stamp;
      const edge: Node = {
        type: 'IssueCommentEdge',
        raw: {
          node: { type: 'IssueComment', repo: subject.repo, issue: subject.issue, comment } as Node,
          cursor: cursorFor(subject.issue.number),
        },
      };
      const out: Record<string, unknown> = {};
      for (const selection of field.selections) {
        if (selection.kind !== 'field') continue;
        const key = selection.field.alias ?? selection.field.name;
        if (selection.field.name === 'commentEdge') {
          const edgeOut: Record<string, unknown> = {};
          for (const edgeSelection of selection.field.selections) {
            if (edgeSelection.kind !== 'field') continue;
            const edgeKey = edgeSelection.field.alias ?? edgeSelection.field.name;
            if (edgeSelection.field.name === 'node') {
              edgeOut[edgeKey] = executeSelections(edge.raw !== undefined ? ((edge.raw as { node: Node }).node) : { type: 'IssueComment' }, edgeSelection.field.selections, ctx);
            } else if (edgeSelection.field.name === 'cursor') {
              edgeOut[edgeKey] = (edge.raw as { cursor: string }).cursor;
            } else {
              edgeOut[edgeKey] = null;
            }
          }
          out[key] = edgeOut;
        } else if (selection.field.name === 'clientMutationId') {
          out[key] = null;
        } else {
          out[key] = null;
        }
      }
      return out;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ entry point

export interface GraphQLResult {
  readonly data?: Record<string, unknown>;
  readonly errors?: Array<{ message: string }>;
}

/** Execute one GraphQL operation (query text plus variables) and answer its result object. */
export function executeGraphQL(query: string, variables: Variables, operationName?: string): GraphQLResult {
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation =
    document.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { variables, fragments: document.fragments, errors: [] };
  const root: Node = { type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  // Mutations resolve through the Mutation root's field dispatch, queries through Query's.
  const data: Record<string, unknown> = {};
  const expanded: FieldNode[] = [];
  for (const selection of operation.selections) {
    if (selection.kind === 'field') expanded.push(selection.field);
    else if (selection.kind === 'inline') {
      for (const inner of selection.selections) if (inner.kind === 'field') expanded.push(inner.field);
    }
  }
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    if (operation.type === 'mutation') {
      const typeInfo = SCHEMA.Mutation;
      if (typeInfo?.fields !== undefined && !typeInfo.fields.includes(field.name) && field.name !== '__typename') {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
        data[key] = null;
        continue;
      }
      data[key] = field.name === '__typename' ? 'Mutation' : resolveMutationField(field, ctx);
    } else {
      data[key] = resolveField(root, field, ctx);
    }
  }
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return result;
}
