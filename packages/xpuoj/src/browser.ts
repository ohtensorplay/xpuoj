import { spawn } from "node:child_process";

import { XpuojError } from "./core.js";

export const DEFAULT_SITE_URL = "https://xpuoj.com/";

interface BrowserCommand {
  command: string;
  args: string[];
}

function browserCommands(url: string): BrowserCommand[] {
  if (process.platform === "darwin") {
    return [{ command: "open", args: [url] }];
  }
  if (process.platform === "win32") {
    return [
      { command: "explorer.exe", args: [url] },
      {
        command: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", url]
      }
    ];
  }
  return [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] },
    { command: "sensible-browser", args: [url] }
  ];
}

export function normalizeSiteUrl(value = DEFAULT_SITE_URL): URL {
  let site: URL;
  try {
    site = new URL(value);
  } catch (error) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "The XPUOJ website URL is invalid.",
      { cause: error }
    );
  }
  if (site.protocol !== "https:") {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "The XPUOJ website must use HTTPS."
    );
  }
  site.username = "";
  site.password = "";
  site.hash = "";
  return site;
}

export function normalizeXpuojPage(value: string, siteUrl: URL): URL {
  let page: URL;
  try {
    page = new URL(value, siteUrl);
  } catch (error) {
    throw new XpuojError("INVALID_ARGUMENT", "The XPUOJ page URL is invalid.", {
      cause: error
    });
  }
  if (page.protocol !== "https:" || page.origin !== siteUrl.origin) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      `The page must stay on ${siteUrl.origin}.`
    );
  }
  page.username = "";
  page.password = "";
  return page;
}

export async function launchBrowser(url: string): Promise<boolean> {
  for (const candidate of browserCommands(url)) {
    const started = await new Promise<boolean>((resolve) => {
      const child = spawn(candidate.command, candidate.args, {
        detached: true,
        stdio: "ignore"
      });
      child.once("error", () => {
        resolve(false);
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
    if (started) {
      return true;
    }
  }
  return false;
}
