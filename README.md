# XPUOJ plugin

XPUOJ lets Codex fetch problems and submit authorized source through the official XPUOJ API. It
runs locally and uses your existing XPUOJ browser sign-in; no browser extension or page connection
is required.

## Install

```bash
codex plugin marketplace add ohtensorplay/xpuoj
codex plugin add xpuoj --marketplace tensorplay-xpuoj
```

Sign in to XPUOJ in Firefox, Chrome, Chromium, Edge, Brave, or Safari, then call
`xpuoj_connection_status`. The plugin reads the active local sign-in without displaying or storing
credentials. Queries do not need a browser tab open. Submissions remain explicit external writes
and require the exact source SHA-256 plus confirmation.

## npm package

```bash
npm install --global @tensorplay/xpuoj
xpuoj mcp
```
