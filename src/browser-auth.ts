import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isRecord, XpuojError } from "./core.js";

export interface ResolvedToken {
  token: string;
  source: "environment" | "firefox" | "chromium" | "safari";
}

interface LocalStorageRow {
  value: Uint8Array;
  compressionType: number;
}

const XPUOJ_STORAGE_KEYS = ["appState", "session-swr"] as const;

function safeDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function newestFirst(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function firefoxRoots(): string[] {
  const userHome = homedir();
  const roots = [
    join(userHome, "snap/firefox/common/.mozilla/firefox"),
    join(userHome, ".mozilla/firefox"),
    join(userHome, ".var/app/org.mozilla.firefox/.mozilla/firefox"),
    join(userHome, "Library/Application Support/Firefox/Profiles")
  ];
  const appData = process.env.APPDATA;
  if (appData) {
    roots.push(join(appData, "Mozilla/Firefox/Profiles"));
  }
  return roots;
}

export function discoverFirefoxDatabases(): string[] {
  const candidates: string[] = [];
  for (const root of firefoxRoots()) {
    for (const profile of safeDirectories(root)) {
      const storageRoot = join(profile, "storage/default");
      for (const origin of safeDirectories(storageRoot)) {
        const name = origin.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
        if (!name.startsWith("https+++") || !name.endsWith("xpuoj.com")) {
          continue;
        }
        const database = join(origin, "ls/data.sqlite");
        if (existsSync(database)) {
          candidates.push(database);
        }
      }
    }
  }
  return newestFirst(candidates);
}

export function decodeSnappyBlock(source: Uint8Array): Uint8Array {
  let position = 0;
  let expected = 0;
  let shift = 0;
  while (true) {
    const value = source[position];
    if (value === undefined || shift > 49) {
      throw new XpuojError("INVALID_RESPONSE", "invalid Firefox local storage data");
    }
    position += 1;
    expected += (value & 0x7f) * 2 ** shift;
    if (value < 0x80) {
      break;
    }
    shift += 7;
  }

  const output: number[] = [];
  while (position < source.length) {
    const tag = source[position];
    if (tag === undefined) {
      throw new XpuojError("INVALID_RESPONSE", "truncated Firefox local storage data");
    }
    position += 1;
    const kind = tag & 0x03;
    if (kind === 0) {
      const lengthCode = tag >> 2;
      let length = lengthCode + 1;
      if (lengthCode >= 60) {
        const width = lengthCode - 59;
        if (position + width > source.length) {
          throw new XpuojError("INVALID_RESPONSE", "truncated Firefox local storage data");
        }
        let encoded = 0;
        for (let index = 0; index < width; index += 1) {
          encoded += (source[position + index] ?? 0) * 2 ** (8 * index);
        }
        length = encoded + 1;
        position += width;
      }
      if (position + length > source.length) {
        throw new XpuojError("INVALID_RESPONSE", "truncated Firefox local storage data");
      }
      output.push(...source.slice(position, position + length));
      position += length;
      continue;
    }

    let length: number;
    let offset: number;
    if (kind === 1) {
      length = 4 + ((tag >> 2) & 0x07);
      const next = source[position];
      if (next === undefined) {
        throw new XpuojError("INVALID_RESPONSE", "truncated Firefox local storage data");
      }
      offset = ((tag & 0xe0) << 3) | next;
      position += 1;
    } else if (kind === 2) {
      length = 1 + (tag >> 2);
      const first = source[position];
      const second = source[position + 1];
      if (first === undefined || second === undefined) {
        throw new XpuojError("INVALID_RESPONSE", "truncated Firefox local storage data");
      }
      offset = first | (second << 8);
      position += 2;
    } else {
      length = 1 + (tag >> 2);
      if (position + 4 > source.length) {
        throw new XpuojError("INVALID_RESPONSE", "truncated Firefox local storage data");
      }
      offset = 0;
      for (let index = 0; index < 4; index += 1) {
        offset += (source[position + index] ?? 0) * 2 ** (8 * index);
      }
      position += 4;
    }
    if (offset <= 0 || offset > output.length) {
      throw new XpuojError("INVALID_RESPONSE", "invalid Firefox local storage data");
    }
    for (let index = 0; index < length; index += 1) {
      const byte = output[output.length - offset];
      if (byte === undefined) {
        throw new XpuojError("INVALID_RESPONSE", "invalid Firefox local storage data");
      }
      output.push(byte);
    }
  }
  if (output.length !== expected) {
    throw new XpuojError("INVALID_RESPONSE", "invalid Firefox local storage data");
  }
  return Uint8Array.from(output);
}

function tokenFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return tokenFromValue(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const token = value.token;
  return typeof token === "string" && token.trim() ? token : undefined;
}

function asFirefoxRow(value: unknown): LocalStorageRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawValue = value.value;
  const bytes = rawValue instanceof Uint8Array ? rawValue : undefined;
  const compressionType = value.compression_type;
  return bytes && typeof compressionType === "number"
    ? { value: bytes, compressionType }
    : undefined;
}

function readFirefoxValue(database: DatabaseSync, key: string): unknown {
  const row = asFirefoxRow(
    database
      .prepare("SELECT value, compression_type FROM data WHERE key = ?")
      .get(key)
  );
  if (!row) {
    return undefined;
  }
  const bytes =
    row.compressionType === 0
      ? row.value
      : row.compressionType === 1
        ? decodeSnappyBlock(row.value)
        : undefined;
  if (!bytes) {
    return undefined;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function tokenFromFirefoxDatabase(path: string): string | undefined {
  let database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1_000 });
  try {
    for (const key of XPUOJ_STORAGE_KEYS) {
      const token = tokenFromValue(readFirefoxValue(database, key));
      if (token) {
        return token;
      }
    }
  } catch {
    database.close();
    database = new DatabaseSync(":memory:", { allowExtension: false });
    const deserialize = Reflect.get(database, "deserialize");
    if (typeof deserialize !== "function") {
      return undefined;
    }
    Reflect.apply(deserialize, database, [readFileSync(path)]);
    for (const key of XPUOJ_STORAGE_KEYS) {
      const token = tokenFromValue(readFirefoxValue(database, key));
      if (token) {
        return token;
      }
    }
  } finally {
    if (database.isOpen) {
      database.close();
    }
  }
  return undefined;
}

function chromiumRoots(): string[] {
  const userHome = homedir();
  const roots = [
    join(userHome, ".config/google-chrome"),
    join(userHome, ".config/chromium"),
    join(userHome, ".config/microsoft-edge"),
    join(userHome, ".config/BraveSoftware/Brave-Browser"),
    join(userHome, "snap/chromium/common/chromium"),
    join(userHome, "Library/Application Support/Google/Chrome"),
    join(userHome, "Library/Application Support/Chromium"),
    join(userHome, "Library/Application Support/Microsoft Edge"),
    join(userHome, "Library/Application Support/BraveSoftware/Brave-Browser")
  ];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    roots.push(
      join(localAppData, "Google/Chrome/User Data"),
      join(localAppData, "Chromium/User Data"),
      join(localAppData, "Microsoft/Edge/User Data"),
      join(localAppData, "BraveSoftware/Brave-Browser/User Data")
    );
  }
  return roots;
}

export function discoverChromiumLevelDbs(): string[] {
  const candidates: string[] = [];
  for (const root of chromiumRoots()) {
    for (const profile of safeDirectories(root)) {
      const name = profile.split(/[\\/]/).at(-1) ?? "";
      if (name !== "Default" && !name.startsWith("Profile ")) {
        continue;
      }
      const levelDb = join(profile, "Local Storage/leveldb");
      if (existsSync(levelDb)) {
        candidates.push(levelDb);
      }
    }
  }
  return newestFirst(candidates);
}

export function resolveChromiumTokenFromDirectory(path: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(path)
      .filter((entry) => entry.endsWith(".ldb") || entry.endsWith(".log"))
      .map((entry) => join(path, entry));
  } catch {
    return undefined;
  }
  for (const entry of newestFirst(entries)) {
    let content: string;
    try {
      const bytes = readFileSync(entry);
      if (bytes.byteLength > 32 * 1024 * 1024) {
        continue;
      }
      content = new TextDecoder().decode(bytes);
    } catch {
      continue;
    }
    let offset = 0;
    while (offset < content.length) {
      const origin = content.indexOf("_https://xpuoj.com\u0000", offset);
      if (origin < 0) {
        break;
      }
      const segment = content.slice(origin, origin + 32 * 1024);
      for (const key of XPUOJ_STORAGE_KEYS) {
        const keyOffset = segment.indexOf(`\u0000${key}`);
        if (keyOffset < 0) {
          continue;
        }
        const value = segment.slice(keyOffset + key.length + 1);
        const tokenMatch = value.match(/"token"\s*:\s*("(?:[^"\\]|\\.)*")/);
        if (!tokenMatch?.[1]) {
          continue;
        }
        const token = tokenFromValue(`{"token":${tokenMatch[1]}}`);
        if (token) {
          return token;
        }
      }
      offset = origin + 1;
    }
  }
  return undefined;
}

function safariRoots(): string[] {
  const userHome = homedir();
  return [
    join(userHome, "Library/Safari/LocalStorage"),
    join(userHome, "Library/Containers/com.apple.Safari/Data/Library/Safari/LocalStorage")
  ];
}

export function resolveSafariTokenFromDatabase(path: string): string | undefined {
  try {
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1_000 });
    try {
      for (const key of XPUOJ_STORAGE_KEYS) {
        const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
        const rawValue = isRecord(row) ? row.value : undefined;
        const decoded = rawValue instanceof Uint8Array ? new TextDecoder().decode(rawValue) : rawValue;
        const token = tokenFromValue(decoded);
        if (token) {
          return token;
        }
      }
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function discoverSafariDatabases(): string[] {
  const candidates: string[] = [];
  for (const root of safariRoots()) {
    try {
      for (const entry of readdirSync(root)) {
        if (entry.toLowerCase().includes("xpuoj.com") && entry.endsWith(".localstorage")) {
          candidates.push(join(root, entry));
        }
      }
    } catch {
      // Browser not installed or no matching storage yet.
    }
  }
  return newestFirst(candidates);
}

export async function resolveToken(): Promise<ResolvedToken> {
  const explicit = process.env.XPUOJ_TOKEN?.trim();
  if (explicit) {
    return { token: explicit, source: "environment" };
  }
  for (const database of discoverFirefoxDatabases()) {
    try {
      const token = tokenFromFirefoxDatabase(database);
      if (token) {
        return { token, source: "firefox" };
      }
    } catch {
      // A live browser can update a profile while it is being inspected.
    }
  }
  for (const database of discoverChromiumLevelDbs()) {
    const token = resolveChromiumTokenFromDirectory(database);
    if (token) {
      return { token, source: "chromium" };
    }
  }
  for (const database of discoverSafariDatabases()) {
    const token = resolveSafariTokenFromDatabase(database);
    if (token) {
      return { token, source: "safari" };
    }
  }
  throw new XpuojError(
    "AUTH_REQUIRED",
    "No active XPUOJ sign-in was found in Firefox, Chrome, Chromium, Edge, Brave, or Safari. Sign in to XPUOJ in any supported browser and retry."
  );
}
