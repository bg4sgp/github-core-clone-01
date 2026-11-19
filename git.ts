// Git smart HTTP, implemented in-process on node:zlib and node:crypto — no git binary anywhere.
// upload-pack speaks protocol v2 when the client asks (Git-Protocol: version=2) and v0 otherwise;
// receive-pack is v0. Objects live in store.ts's content-addressed map; this module owns the wire:
// pkt-lines, packfiles (read with delta resolution, written plain), ref advertisements, ls-refs,
// fetch planning (haves, shallow, deepen) and push validation (fast-forward only).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  collectReachable,
  getObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  peelToCommit,
  putObject,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

// ------------------------------------------------------------------ pkt-lines

const PKT_MAX_PAYLOAD = 65520 - 4;

/** Encode one data packet: 4 hex length digits (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload too large: ${data.length}`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode a whole buffer into packets; throws on a malformed or truncated frame. */
export function decodePackets(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a packfile holding the given objects, plain (no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = (TYPE_CODE[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes: number[] = [];
    if (size > 0) {
      headerBytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        headerBytes.push(byte);
      }
    } else {
      headerBytes.push(first);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate the zlib stream starting at `offset`; answers its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten || result.engine.bytesWritten <= 0) throw new Error(`bad zlib stream at ${offset}`);
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and store every object it carries, resolving OFS_DELTA and REF_DELTA (a thin
 * pack's base may come from the store). Throws on any structural problem; stores nothing on failure
 * paths the caller treats as an unpack error... except objects already resolved, which are content
 * addressed and harmless to keep.
 */
export function readPackIntoStore(pack: Buffer): number {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, string>();
  const resolve = (entry: Raw): string => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let oid: string;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let baseType: GitObjectType;
      let baseData: Buffer;
      if (entry.typeCode === 6) {
        const base = byOffset.get(entry.baseOffset as number);
        if (base === undefined) throw new Error('ofs-delta base not in pack');
        const baseOid = resolve(base);
        const baseObject = getObject(baseOid) as GitObject;
        baseType = baseObject.type;
        baseData = baseObject.data;
      } else {
        const baseObject = getObject(entry.baseOid as string);
        if (baseObject === undefined) throw new Error('ref-delta base not available');
        baseType = baseObject.type;
        baseData = baseObject.data;
      }
      oid = putObject(baseType, applyDelta(baseData, entry.data));
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack type code ${entry.typeCode}`);
      oid = putObject(type, entry.data);
    }
    resolved.set(entry.offset, oid);
    return oid;
  };
  for (const entry of raw) resolve(entry);
  return raw.length;
}

// ------------------------------------------------------------------ refs

/** A ref as the wire shows it: name, target, and the commit an annotated tag peels to. */
export interface RefLine {
  readonly name: string;
  readonly oid: string;
  readonly peeled?: string;
}

/** Every ref of a repository in wire order: HEAD first, then the refs sorted by name. */
export function refLines(repo: Repo): { headTarget: string; headOid: string; refs: RefLine[] } {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
  const refs: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { name, oid };
    const object = getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = getObject(target);
      if (targetObject !== undefined && targetObject.type === 'commit') refs.push({ name, oid, peeled: target });
      else refs.push(line);
    } else {
      refs.push(line);
    }
  }
  return { headTarget, headOid, refs };
}

const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k ofs-delta shallow agent=makefun-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';

/** The v0 advertisement body for a service (also receive-pack's only form). */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const { headTarget, headOid, refs } = refLines(repo);
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:${headTarget}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=makefun-forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

// ------------------------------------------------------------------ ls-refs (v2)

export interface LsRefsArgs {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: readonly string[];
}

/** Answer a v2 ls-refs command for a repository. */
export function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const { headTarget, headOid, refs } = refLines(repo);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (matches('HEAD')) {
    if (headOid === ZERO_OID && args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else {
      parts.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch

export interface FetchArgs {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly shallow: readonly string[];
  readonly depth: number | null;
  /** deepen-relative: the depth counts additional generations below the client's shallow boundary. */
  readonly deepenRelative: boolean;
  readonly done: boolean;
  readonly waitForDone: boolean;
}

export interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** The tree closure (trees and blobs) of one tree object. */
function treeClosure(treeOid: string, into: Set<string>): void {
  const object = getObject(treeOid);
  if (object === undefined) return;
  for (const oid of collectReachable([treeOid])) into.add(oid);
}

/**
 * Plan a fetch: the objects the client lacks, and where the shallow boundary moves. The client is
 * credited with the full closure of its non-shallow haves, and with the shallow commits it names
 * plus those commits' trees; wants are walked generation by generation up to the depth limit.
 */
export function planFetch(args: FetchArgs): FetchPlan {
  const haveSet = new Set(args.haves);
  const shallowSet = new Set(args.shallow);
  const fullHaves = args.haves.filter((oid) => !shallowSet.has(oid));
  // What the client already holds: the closure of its haves, but bounded by its shallow list —
  // a have whose history runs into a shallow boundary proves possession only down to that
  // boundary commit (itself and its tree included), never of the boundary's parents. Crediting
  // the full closure would starve an --unshallow fetch of exactly the history it asks for.
  const excluded = new Set<string>();
  {
    const stack = [...fullHaves];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const object = getObject(oid);
      if (object === undefined) continue;
      if (object.type !== 'commit') {
        for (const reachable of collectReachable([oid])) excluded.add(reachable);
        continue;
      }
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      excluded.add(oid);
      treeClosure(parseCommit(object.data).tree, excluded);
      if (!shallowSet.has(oid)) stack.push(...parseCommit(object.data).parents);
    }
  }
  for (const oid of shallowSet) {
    const object = getObject(oid);
    if (object !== undefined && object.type === 'commit') {
      excluded.add(oid);
      treeClosure(parseCommit(object.data).tree, excluded);
    }
  }

  // Breadth-first by generation, each queue entry carrying the deepest generation its path may
  // include. An absolute depth caps every path at depth-1 (the want is level one); a relative
  // deepen leaves paths open until they cross a shallow commit the client named, then caps them
  // `depth` generations below that boundary.
  const included = new Map<string, number>();
  const extraRoots: string[] = [];
  interface QueueEntry {
    oid: string;
    gen: number;
    limit: number;
  }
  const initialLimit =
    args.depth === null || args.deepenRelative ? Number.POSITIVE_INFINITY : args.depth - 1;
  const queue: QueueEntry[] = [];
  for (const want of args.wants) {
    const object = getObject(want);
    if (object === undefined) continue;
    if (object.type === 'commit') queue.push({ oid: want, gen: 0, limit: initialLimit });
    else extraRoots.push(want);
  }
  // The walk is deliberately not pruned at haves: a want that is also a have (every deepen and
  // unshallow request) must still be walked through, down to the shallow boundary and below.
  // What the client already holds is subtracted afterwards, through `excluded`.
  const processedAt = new Map<string, number>();
  while (queue.length > 0) {
    const entry = queue.shift() as QueueEntry;
    const { oid, gen } = entry;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    let limit = entry.limit;
    if (args.depth !== null && args.deepenRelative && shallowSet.has(oid)) {
      // Crossing the client's shallow boundary closes the path's open limit: below the boundary
      // at generation g, exactly `depth` further generations may be included. A second, deeper
      // boundary crossing can only extend a limit that is already finite.
      limit = Number.isFinite(limit) ? Math.max(limit, gen + args.depth) : gen + args.depth;
    }
    const previous = processedAt.get(oid);
    if (previous !== undefined && previous >= limit) continue;
    processedAt.set(oid, limit);
    if (!included.has(oid)) included.set(oid, gen);
    if (gen >= limit) continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, gen: gen + 1, limit });
    }
  }

  const boundary: string[] = [];
  for (const oid of included.keys()) {
    const commit = parseCommit((getObject(oid) as GitObject).data);
    const cut = commit.parents.some(
      (parent) => getObject(parent) !== undefined && !included.has(parent) && !haveSet.has(parent),
    );
    if (cut) boundary.push(oid);
  }
  const unshallow = args.shallow.filter((oid) => included.has(oid) && !boundary.includes(oid));

  const wanted = new Set<string>();
  for (const oid of included.keys()) {
    wanted.add(oid);
    treeClosure(parseCommit((getObject(oid) as GitObject).data).tree, wanted);
  }
  for (const oid of collectReachable(extraRoots)) wanted.add(oid);
  const sendable: Array<{ oid: string; object: GitObject }> = [];
  for (const oid of wanted) {
    if (excluded.has(oid)) continue;
    const object = getObject(oid);
    if (object !== undefined) sendable.push({ oid, object });
  }
  sendable.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return { objects: sendable.map((entry) => entry.object), shallow: boundary, unshallow };
}

/** Wrap pack bytes in sideband band-1 packets (progress bands are left out: no-progress was asked). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

/** The v2 fetch response for a planned fetch. */
export function fetchResponseV2(plan: FetchPlan, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of args.haves) {
      if (getObject(have) !== undefined) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    // The acknowledgments always end in `ready` once negotiation settles (real upload-pack does
    // this with or without wait-for-done): a client that sees another section after the acks
    // without a `ready` first treats the response as malformed.
    parts.push(pktLine('ready\n'));
    if (args.waitForDone) {
      // With wait-for-done negotiated, the exchange stops here: the client sends its `done` in a
      // second request and only then may the packfile sections follow.
      parts.push(pktDelim(), pktFlush());
      return Buffer.concat(parts);
    }
    // Without wait-for-done, a request carrying no `done` is still complete: real git sends its
    // deepen negotiations this way and expects the packfile sections in the same response.
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch response for a planned fetch. */
export function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse the argument lines of a v2 command (after the delim) or a v0 fetch (both sections). */
export function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  let done = false;
  let waitForDone = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7));
      if (Number.isFinite(value) && value > 0) depth = value;
    } else if (line === 'deepen-relative') {
      deepenRelative = true;
    } else if (line === 'done') {
      done = true;
    } else if (line === 'wait-for-done') {
      waitForDone = true;
    }
  }
  return { wants, haves, shallow, depth, deepenRelative, done, waitForDone };
}

// ------------------------------------------------------------------ receive-pack

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface PushOutcome {
  readonly unpackOk: boolean;
  readonly unpackDetail: string;
  readonly results: ReadonlyArray<{ ref: string; ok: boolean; reason: string }>;
  readonly sideband: boolean;
  readonly reportStatus: boolean;
}

/** Whether `update` may fast-forward `current` (both peeled to commits where they are tags). */
function fastForwardOk(current: string, update: string): boolean {
  if (current === update) return true;
  const from = getObject(current);
  const to = getObject(update);
  if (from === undefined || to === undefined) return false;
  const fromCommit = from.type === 'commit' ? current : from.type === 'tag' ? peelToCommit(current) : null;
  const toCommit = to.type === 'commit' ? update : to.type === 'tag' ? peelToCommit(update) : null;
  if (fromCommit === null || toCommit === null) return true;
  return isAncestor(fromCommit, toCommit);
}

/**
 * Run one receive-pack request: unpack the pack into the store, then apply each command in order,
 * fast-forward only, and answer the report-status outcome the HTTP layer frames.
 */
export function receivePack(repo: Repo, packets: readonly Packet[], packBytes: Buffer): PushOutcome {
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') break;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0] as string));
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      readPackIntoStore(packBytes);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    results.push({ ref: command.ref, ...applyCommand(repo, command) });
  }
  return {
    unpackOk,
    unpackDetail,
    results,
    sideband: capabilities.has('side-band-64k'),
    reportStatus: capabilities.has('report-status') || capabilities.has('report-status-v2'),
  };
}

/** Validate and apply one push command; answers the per-ref verdict. */
function applyCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return { ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return { ok: false, reason: 'stale info' };
  if (newOid === ZERO_OID) {
    // Deletes need no request capability: advertising delete-refs is the server's promise, and
    // clients simply send the zero-new-id command. Only the checked-out branch is protected.
    if (ref === `refs/heads/${repo.defaultBranch}`) return { ok: false, reason: 'deletion of the current branch prohibited' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const object = getObject(newOid);
  if (object === undefined) return { ok: false, reason: 'invalid object' };
  if (oldOid !== ZERO_OID && !fastForwardOk(current, newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

/** Frame a push outcome as the receive-pack result body (report-status, sideband when negotiated). */
export function pushReportBody(outcome: PushOutcome): Buffer {
  if (!outcome.reportStatus) return Buffer.alloc(0);
  const lines: string[] = [`unpack ${outcome.unpackOk ? 'ok' : outcome.unpackDetail}\n`];
  for (const result of outcome.results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  if (!outcome.sideband) return report;
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Split a receive-pack request body into its command packets and the raw pack that follows. */
export function splitReceiveBody(body: Buffer): { packets: Packet[]; pack: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, pack: body.subarray(offset) };
    }
    if (length === 1 || length === 2) {
      packets.push({ kind: length === 1 ? 'delim' : 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520 || offset + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, pack: Buffer.alloc(0) };
}
