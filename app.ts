// The HTTP surface of the forge: one server, four protocols. app.ts owns framing only — bearer
// auth against $MAKEFUN_SHOP_TOKEN, body reading, JSON in and out, the request-id header — and
// hands each route to the module that speaks it: git.ts for smart HTTP, rest.ts for REST v3,
// graphql.ts for GraphQL v4, mcp.ts for the MCP endpoint. All state lives in store.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { allocRequestId, findRepo } from './store.ts';
import {
  decodePackets,
  fetchResponseV0,
  fetchResponseV2,
  lsRefs,
  parseFetchArgs,
  planFetch,
  pushReportBody,
  receivePack,
  splitReceiveBody,
  v0Advertisement,
  v2Advertisement,
  type Packet,
} from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Read a whole request body, rejecting anything past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a path into percent-decoded segments; null when an escape is malformed. */
function segmentsOf(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

// ------------------------------------------------------------------ git smart HTTP

interface GitRoute {
  readonly owner: string;
  readonly repoName: string;
  readonly action: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

/** Match /{owner}/{repo}.git/<action>; repo names may themselves contain dots. */
function gitRoute(pathname: string): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  try {
    return {
      owner: decodeURIComponent(match[1] as string),
      repoName: decodeURIComponent(match[2] as string),
      action: match[3] as GitRoute['action'],
    };
  } catch {
    return null;
  }
}

async function handleGit(req: IncomingMessage, res: ServerResponse, route: GitRoute, url: URL): Promise<void> {
  const repo = findRepo(route.owner, route.repoName);
  if (repo === undefined) {
    sendBytes(res, 404, Buffer.from('repository not found\n'), 'text/plain; charset=utf-8');
    return;
  }
  const method = req.method ?? 'GET';

  if (route.action === 'info/refs') {
    if (method !== 'GET') {
      sendBytes(res, 405, Buffer.from('method not allowed\n'), 'text/plain; charset=utf-8');
      return;
    }
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBytes(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendBytes(res, 400, Buffer.from('missing or unknown service\n'), 'text/plain; charset=utf-8');
    return;
  }

  if (method !== 'POST') {
    sendBytes(res, 405, Buffer.from('method not allowed\n'), 'text/plain; charset=utf-8');
    return;
  }
  const body = await readBody(req);

  if (route.action === 'git-upload-pack') {
    let packets: Packet[];
    try {
      packets = decodePackets(body);
    } catch {
      sendBytes(res, 400, Buffer.from('malformed pkt-line stream\n'), 'text/plain; charset=utf-8');
      return;
    }
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    const first = lines[0] ?? '';
    if (first.startsWith('command=')) {
      // Protocol v2: a command line, arguments after the delim packet.
      const command = first.trim().slice('command='.length);
      const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
      const argLines: string[] = [];
      const start = delimIndex >= 0 ? delimIndex + 1 : 1;
      for (let index = start; index < packets.length; index += 1) {
        const packet = packets[index] as Packet;
        if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8'));
      }
      if (command === 'ls-refs') {
        const prefixes: string[] = [];
        let peel = false;
        let symrefs = false;
        let unborn = false;
        for (const raw of argLines) {
          const line = raw.replace(/\n$/, '');
          if (line === 'peel') peel = true;
          else if (line === 'symrefs') symrefs = true;
          else if (line === 'unborn') unborn = true;
          else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
        }
        sendBytes(res, 200, lsRefs(repo, { peel, symrefs, unborn, prefixes }), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        const args = parseFetchArgs(argLines);
        const plan = planFetch(args);
        sendBytes(res, 200, fetchResponseV2(plan, args), 'application/x-git-upload-pack-result');
        return;
      }
      sendBytes(res, 400, Buffer.from(`unknown command ${command}\n`), 'text/plain; charset=utf-8');
      return;
    }
    // Protocol v0: want lines, a flush, have lines, done.
    const args = parseFetchArgs(lines);
    const plan = planFetch(args);
    sendBytes(res, 200, fetchResponseV0(plan), 'application/x-git-upload-pack-result');
    return;
  }

  // git-receive-pack: the command stream must at least start as pkt-lines.
  if (body.length > 0 && !/^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('ascii'))) {
    sendBytes(res, 400, Buffer.from('malformed pkt-line stream\n'), 'text/plain; charset=utf-8');
    return;
  }
  const { packets, pack } = splitReceiveBody(body);
  const outcome = receivePack(repo, packets, pack);
  sendBytes(res, 200, pushReportBody(outcome), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ the server

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const requestId = allocRequestId();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check: no auth, always the same answer.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Everything else speaks for the token's account only.
        if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
          sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = segmentsOf(path.slice('/api/v3'.length));
          if (segments === null) {
            sendJson(res, 400, { message: 'Bad Request' }, { 'x-github-request-id': requestId });
            return;
          }
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
                return;
              }
            }
          }
          const host = req.headers.host ?? 'entry';
          const reply = handleRest({ method, segments, query: url.searchParams, body, base: `http://${host}` });
          const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(reply.headers ?? {}) };
          if (reply.status === 204 || reply.body === undefined) {
            res.writeHead(reply.status, headers);
            res.end();
          } else {
            sendJson(res, reply.status, reply.body, headers);
          }
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, { 'x-github-request-id': requestId });
            return;
          }
          const runOne = (entry: unknown): unknown => {
            if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid request' }] };
            const record = entry as Record<string, unknown>;
            const query = typeof record.query === 'string' ? record.query : '';
            const variables =
              typeof record.variables === 'object' && record.variables !== null
                ? (record.variables as Record<string, unknown>)
                : {};
            const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
            return executeGraphQL(query, variables, operationName);
          };
          sendJson(res, 200, Array.isArray(parsed) ? parsed.map(runOne) : runOne(parsed), {
            'x-github-request-id': requestId,
          });
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
            return;
          }
          const raw = await readBody(req);
          const outcome = handleMcp(raw.toString('utf8'));
          if (outcome.body === undefined) {
            res.writeHead(outcome.status);
            res.end();
          } else {
            sendJson(res, outcome.status, outcome.body);
          }
          return;
        }

        const route = gitRoute(path);
        if (route !== null) {
          await handleGit(req, res, route, url);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId });
        } else {
          res.end();
        }
      }
    })();
  });
}
