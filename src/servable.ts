import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  CLI_SPECS,
  discoverCliBinary,
  opencodeModelId,
} from "./backends/cli.ts";
import { runCli } from "./backends/spawn.ts";
import { relayDataDir } from "./paths.ts";

/**
 * Installed ≠ servable for multi-provider CLIs: an opencode with OpenAI +
 * Abacus credentials but no zen billing can be on PATH while most
 * zen-mapped fallbacks fail at runtime. This probe asks the CLI what it can
 * actually serve, caches the answer for 24h, and lets routing filter tier
 * candidates through it.
 *
 * FAIL-OPEN by design: any probe error returns null and routing behaves
 * exactly as before — the probe only ever removes candidates when it
 * succeeded and returned a definitive list. Cache reads degrade to empty,
 * never throw (same discipline as the host transcript readers).
 */

const SERVABLE_TTL_MS = 24 * 60 * 60 * 1000;

const ModelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]*\/\S+$/);
const ServableCacheSchema = z.record(
  z.string(),
  z.object({
    binary: z.string().min(1),
    ts: z.number().finite(),
    models: z.array(ModelIdSchema).min(1),
  }),
);
type ServableCache = z.infer<typeof ServableCacheSchema>;

function cachePath(): string {
  return join(relayDataDir(), "servable.json");
}

function loadServableCache(): ServableCache {
  try {
    const parsed = ServableCacheSchema.safeParse(
      JSON.parse(readFileSync(cachePath(), "utf8")),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function saveServableCache(cache: ServableCache): void {
  const path = cachePath();
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(cache, null, 2), "utf8");
    renameSync(temp, path);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // cache cleanup is best-effort too
    }
  }
}

export function invalidateServableCache(backend?: string): void {
  const cache = loadServableCache();
  if (backend) {
    for (const key of Object.keys(cache)) {
      if (key.startsWith(`${backend}::`)) delete cache[key];
    }
  }
  saveServableCache(backend ? cache : {});
}

function cacheKey(backend: string, cwd: string): string {
  return `${backend}::${resolve(cwd)}`;
}

/** `opencode models` output: provider/model ids, one per line, amid ANSI decoration. */
function parseModelsList(stdout: string): string[] {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  return clean
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-z0-9][a-z0-9.-]*\/\S+$/.test(l));
}

/**
 * The set of `provider/model` ids `backend` can serve, or null when there is
 * no probe for the backend, the binary is missing, or the probe failed.
 * A valid in-TTL cache hit wins unless opts.fresh; stale data is never used as
 * a deny-list because a failed refresh must leave routing fail-open.
 */
export async function servableModels(
  backend: string,
  opts: { fresh?: boolean; cwd?: string } = {},
): Promise<Set<string> | null> {
  if (backend !== "opencode") return null;
  const spec = CLI_SPECS[backend];
  const bin = spec ? discoverCliBinary(spec) : null;
  if (!bin) return null;

  const cwd = opts.cwd ?? process.cwd();
  const key = cacheKey(backend, cwd);
  const cache = loadServableCache();
  const hit = cache[key];
  const age = hit ? Date.now() - hit.ts : Number.POSITIVE_INFINITY;
  if (
    !opts.fresh &&
    hit &&
    hit.binary === bin &&
    age >= 0 &&
    age < SERVABLE_TTL_MS
  ) {
    return new Set(hit.models);
  }

  let models: string[] = [];
  try {
    const r = await runCli([bin, "models"], {
      cwd,
      timeoutMs: 20_000,
    });
    if (r.exitCode === 0) models = parseModelsList(r.stdout);
  } catch {
    // spawn-level failure — same as any other probe failure
  }
  if (models.length === 0) return null;

  const latest = loadServableCache();
  latest[key] = { binary: bin, ts: Date.now(), models };
  saveServableCache(latest);
  return new Set(models);
}

/**
 * Turn a probe result into a resolveTier filter. Null set → allow-all
 * (fail-open); non-opencode backends are never filtered. opencode candidates
 * are checked through opencodeModelId, so mapped ids match their
 * `opencode/<zen-id>` form while user-pinned passthrough ids
 * (`openai/gpt-5.6-sol`) are checked verbatim.
 */
export function servablePredicate(
  servable: Set<string> | null,
): (backend: string, model: string) => boolean {
  return (backend, model) => {
    if (!servable) return true;
    if (backend !== "opencode") return true;
    return servable.has(opencodeModelId(model));
  };
}
