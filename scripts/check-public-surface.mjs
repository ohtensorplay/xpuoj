import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const publicFiles = [
  "README.md",
  "packages/xpuoj/README.md",
  "plugins/xpuoj/.codex-plugin/plugin.json",
  "plugins/xpuoj/.mcp.json",
  "plugins/xpuoj/skills/submit-xpuoj-solution/SKILL.md"
];

const forbidden = [
  { label: "infrastructure hostname", pattern: /workers\.dev/i },
  { label: "removed worker package", pattern: /@xpuoj\/mcp-worker/i },
  { label: "removed remote proxy", pattern: /\bmcp-remote\b/i },
  { label: "removed deployment command", pattern: /\bworker:deploy\b/i },
  { label: "upstream gateway", pattern: /apigateway/i },
  { label: "server override", pattern: /--server-url/i },
  { label: "internal API setting", pattern: /XPUOJ_(?:API_BASE|MCP_URL)/i },
  { label: "internal project name", pattern: /\bInfra\b/ }
];

const surfaces = await Promise.all(
  publicFiles.map(async (file) => ({
    label: file,
    text: await readFile(new URL(`../${file}`, import.meta.url), "utf8")
  }))
);

surfaces.push({
  label: "xpuoj --help",
  text: execFileSync(
    process.execPath,
    [new URL("../packages/xpuoj/dist/cli.js", import.meta.url).pathname, "--help"],
    { encoding: "utf8" }
  )
});

const violations = surfaces.flatMap(({ label, text }) =>
  forbidden
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label: reason }) => `${label}: ${reason}`)
);

for (const removedPath of ["worker", "web", "browser-extension"]) {
  try {
    await access(new URL(`../${removedPath}/package.json`, import.meta.url));
    violations.push(`${removedPath}: removed workspace still exists`);
  } catch {
    // Expected: the removed workspace has no package.
  }
}

if (violations.length > 0) {
  console.error(`Public-surface gate failed:\n${violations.join("\n")}`);
  process.exitCode = 1;
}
