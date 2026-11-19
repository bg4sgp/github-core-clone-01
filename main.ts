// forge-entry: the process lifecycle that connects this forge to the trial env.
//
// The env is the process that grades a trial. It waits for this entry to announce itself, drives
// the forge over HTTP for as long as the suite runs, and then says the trial is over. So the whole
// life of this process is four steps, in order:
//
//   1. Read the env's origin from MAKEFUN_ENV_URL. With no origin there is nobody to announce to,
//      so the entry reports that on stderr and exits 1 before opening any socket.
//   2. Build the forge server (app.ts) and listen on port 0, letting the kernel choose a free
//      port. Port 8080 belongs to the env and is never requested.
//   3. POST {"port": N} to the env's /register. A 200 means the env wrote down this process's
//      address; a 409 means an earlier registration already won and is equally final. A 400 or 405
//      is the env rejecting the shape of the request, which retrying cannot fix, so it ends the
//      process. Anything else — a refused connection while the env is still starting, a 5xx, a
//      timeout — is retried with a growing pause.
//   4. Poll the env's /done until its JSON body says the trial is done, then close the server and
//      exit 0. The env answers every poll immediately, so polling is a loop with the same growing
//      pause, and no failure of a single poll is ever a reason to leave early.
//
// The file's only import is the forge's own server factory: no packages, no Node built-ins.

import { createApp as buildForgeServer } from './app.ts';

/** One call to the env may hang at most this long before it counts as failed and is retried. */
const CALL_TIMEOUT_MS = 30_000;
/** The pause after a first failure; each later failure doubles it, up to the ceiling. */
const PAUSE_FLOOR_MS = 250;
const PAUSE_CEILING_MS = 2_000;

/** Report a fatal problem on stderr and end the process with status 1. */
function fail(message: string): never {
  process.stderr.write(`forge-entry: ${message}\n`);
  return process.exit(1);
}

/** How long to wait after `failures` failures in a row: 250, 500, 1000, then 2000 for good. */
function pauseFor(failures: number): number {
  const doubled = PAUSE_FLOOR_MS * 2 ** Math.min(failures, 3);
  return doubled > PAUSE_CEILING_MS ? PAUSE_CEILING_MS : doubled;
}

/** A promise that settles after `ms` milliseconds; the only waiting this file ever does. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What one registration attempt came to: taken, worth another try, or a fatal refusal. */
type AnnounceOutcome = 'accepted' | 'retry' | Error;

/** The entry's conversation with one env: announce the port, then wait to be dismissed. */
class EnvSession {
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  /** POST the bound port until the env takes it; a fatal refusal propagates as an Error. */
  async announce(port: number): Promise<void> {
    let failures = 0;
    for (;;) {
      const outcome = await this.tryAnnounce(port);
      if (outcome === 'accepted') return;
      if (outcome !== 'retry') throw outcome;
      await delay(pauseFor(failures));
      failures += 1;
    }
  }

  /** A single registration attempt, classified instead of thrown so the loop above stays flat. */
  private async tryAnnounce(port: number): Promise<AnnounceOutcome> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    };
    let reply: Response;
    try {
      reply = await fetch(`${this.origin}/register`, init);
    } catch {
      return 'retry';
    }
    if (reply.status === 200 || reply.status === 409) return 'accepted';
    if (reply.status === 400 || reply.status === 405) {
      const detail = await reply.text().catch(() => '');
      const suffix = detail === '' ? '' : `: ${detail}`;
      return new Error(`the env refused the registration, HTTP ${reply.status}${suffix}`);
    }
    return 'retry';
  }

  /** Poll /done until the env ends the trial; individual poll failures only slow the loop. */
  async waitUntilFinished(): Promise<void> {
    let failures = 0;
    for (;;) {
      if (await this.envSaysDone()) return;
      await delay(pauseFor(failures));
      failures += 1;
    }
  }

  /** One /done poll: true only for a 200 whose JSON body carries done set to true. */
  private async envSaysDone(): Promise<boolean> {
    try {
      const reply = await fetch(`${this.origin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!reply.ok) return false;
      const payload = (await reply.json()) as { done?: unknown };
      return payload.done === true;
    } catch {
      return false;
    }
  }
}

/** Bind the forge, announce its port to the env, serve until dismissed, then shut down. */
async function boot(): Promise<void> {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/*$/, '');
  if (origin === '') fail('MAKEFUN_ENV_URL is not set, so there is no env to register with');
  const env = new EnvSession(origin);
  const server = buildForgeServer();
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the forge server did not bind an ephemeral TCP port'));
      } else {
        resolve(bound.port);
      }
    });
  });
  process.stdout.write(`forge-entry: the forge is listening on port ${port}\n`);
  await env.announce(port);
  process.stdout.write('forge-entry: registered; the forge serves until the env ends the trial\n');
  await env.waitUntilFinished();
  server.close(() => undefined);
  process.stdout.write('forge-entry: the env says done, so the forge is closing\n');
}

boot().then(
  () => {
    process.exit(0);
  },
  (fault: unknown) => {
    const message = fault instanceof Error ? fault.message : String(fault);
    process.stderr.write(`forge-entry: ${message}\n`);
    process.exit(1);
  },
);
