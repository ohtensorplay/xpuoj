import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const RELEASE_ENDPOINT = "https://api.github.com/repos/ohtensorplay/xpuoj/releases/latest";
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 1_500;

interface CachedUpdate {
  checkedAt: number;
  latestVersion: string;
}

interface ParsedVersion {
  parts: [number, number, number];
  prerelease: string[];
}

type UpdateFetch = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, "ok" | "json">>;

export interface UpdateCheckResult {
  latestVersion?: string;
  updateAvailable: boolean;
  source: "cache" | "network" | "unavailable";
}

export interface UpdateCheckOptions {
  cachePath?: string;
  fetchFn?: UpdateFetch;
  force?: boolean;
  now?: number;
}

function defaultCachePath(): string {
  const explicit = process.env.XPUOJ_UPDATE_CACHE?.trim();
  if (explicit) {
    return explicit;
  }
  const userHome = homedir();
  const cacheRoot =
    process.env.XDG_CACHE_HOME ??
    (platform() === "darwin"
      ? join(userHome, "Library/Caches")
      : process.env.LOCALAPPDATA ?? join(userHome, ".cache"));
  return join(cacheRoot, "xpuoj", "update.json");
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = value.trim().replace(/^v/, "").match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? []
  };
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) {
    return 0;
  }
  for (const index of [0, 1, 2] as const) {
    const difference = leftVersion.parts[index] - rightVersion.parts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
    return 0;
  }
  if (leftVersion.prerelease.length === 0) {
    return 1;
  }
  if (rightVersion.prerelease.length === 0) {
    return -1;
  }
  const count = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === rightPart) {
      continue;
    }
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function resultFor(currentVersion: string, latestVersion: string, source: UpdateCheckResult["source"]): UpdateCheckResult {
  return {
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    source
  };
}

async function readCache(path: string): Promise<CachedUpdate | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "checkedAt" in parsed &&
      "latestVersion" in parsed &&
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latestVersion === "string" &&
      parseVersion(parsed.latestVersion)
    ) {
      return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion };
    }
  } catch {
    // Update checks must never prevent a judge command from running.
  }
  return undefined;
}

async function writeCache(path: string, value: CachedUpdate): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  } catch {
    // A read-only home directory simply disables the update cache.
  }
}

function latestVersionFromResponse(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("tag_name" in value)) {
    return undefined;
  }
  const tagName = value.tag_name;
  return typeof tagName === "string" && parseVersion(tagName) ? tagName.replace(/^v/, "") : undefined;
}

export async function checkForUpdate(
  currentVersion: string,
  options: UpdateCheckOptions = {}
): Promise<UpdateCheckResult> {
  const cachePath = options.cachePath ?? defaultCachePath();
  const now = options.now ?? Date.now();
  const cached = await readCache(cachePath);
  if (!options.force && cached && now - cached.checkedAt >= 0 && now - cached.checkedAt < CACHE_MAX_AGE_MS) {
    return resultFor(currentVersion, cached.latestVersion, "cache");
  }
  try {
    const response = await (options.fetchFn ?? fetch)(RELEASE_ENDPOINT, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "xpuoj-cli"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { updateAvailable: false, source: "unavailable" };
    }
    const latestVersion = latestVersionFromResponse(await response.json());
    if (!latestVersion) {
      return { updateAvailable: false, source: "unavailable" };
    }
    await writeCache(cachePath, { checkedAt: now, latestVersion });
    return resultFor(currentVersion, latestVersion, "network");
  } catch {
    return { updateAvailable: false, source: "unavailable" };
  }
}
