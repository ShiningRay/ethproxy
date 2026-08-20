import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export interface IndexPageMeta {
  cacheBackend: string;
}

/**
 * Static HTML shell for the landing page. Live data (chain head, upstream
 * states) is fetched client-side from /status every few seconds.
 */
export function renderIndexPage(meta: IndexPageMeta): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ethproxy</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0d1117; color: #c9d1d9; padding: 2rem 1rem;
  }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; color: #58a6ff; }
  h1 span { color: #8b949e; font-size: 0.9rem; font-weight: normal; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.5rem 0; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 0.9rem 1.2rem; min-width: 10rem; flex: 1;
  }
  .card .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.3rem; margin-top: 0.3rem; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.6rem 0.9rem; font-size: 0.85rem; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: normal; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; }
  tr:last-child td { border-bottom: none; }
  .ok { color: #3fb950; } .bad { color: #f85149; }
  .muted { color: #8b949e; }
  footer { margin-top: 1.5rem; font-size: 0.8rem; color: #8b949e; line-height: 1.7; }
  code { background: #161b22; border: 1px solid #30363d; border-radius: 4px; padding: 0.1rem 0.4rem; }
  #error { color: #f85149; margin-top: 1rem; display: none; }
</style>
</head>
<body>
<main>
  <h1>ethproxy <span>v${version} · Ethereum JSON-RPC reverse proxy</span></h1>
  <div class="cards">
    <div class="card"><div class="label">Chain ID</div><div class="value" id="chainId">–</div></div>
    <div class="card"><div class="label">Chain Head</div><div class="value" id="chainHead">–</div></div>
    <div class="card"><div class="label">Healthy Upstreams</div><div class="value" id="healthy">–</div></div>
    <div class="card"><div class="label">Cache Backend</div><div class="value">${meta.cacheBackend}</div></div>
  </div>
  <table>
    <thead><tr>
      <th>Upstream</th><th>Status</th><th>Block</th><th>Chain ID</th><th>Syncing</th><th>Failures</th>
    </tr></thead>
    <tbody id="upstreams"><tr><td colspan="6" class="muted">loading…</td></tr></tbody>
  </table>
  <div id="error"></div>
  <footer>
    <div>HTTP JSON-RPC: <code>POST /</code> · WebSocket: <code>ws(s)://&lt;host&gt;/</code></div>
    <div>Machine-readable status: <code>GET /status</code> · Health check: <code>GET /healthz</code></div>
    <div class="muted">auto-refreshes every 5s</div>
  </footer>
</main>
<script>
async function refresh() {
  try {
    const res = await fetch("/status");
    const s = await res.json();
    document.getElementById("error").style.display = "none";
    document.getElementById("chainId").textContent = s.chainId ?? "–";
    document.getElementById("chainHead").textContent =
      s.chainHead === null ? "–" : s.chainHead.toLocaleString();
    const healthy = s.upstreams.filter(u => u.healthy && !u.syncing).length;
    document.getElementById("healthy").textContent = healthy + " / " + s.upstreams.length;
    document.getElementById("upstreams").innerHTML = s.upstreams.map(u => {
      const ok = u.healthy && !u.syncing;
      return "<tr><td>" + u.name + ' <span class="muted">' + u.url + "</span></td>" +
        '<td class="' + (ok ? "ok" : "bad") + '">' + (ok ? "● healthy" : "● down") + "</td>" +
        "<td>" + (u.blockNumber === null ? "–" : u.blockNumber.toLocaleString()) + "</td>" +
        "<td>" + (u.chainId ?? "–") + "</td>" +
        "<td>" + (u.syncing ? "yes" : "no") + "</td>" +
        "<td>" + u.consecutiveFailures + "</td></tr>";
    }).join("");
  } catch (err) {
    const el = document.getElementById("error");
    el.style.display = "block";
    el.textContent = "failed to fetch /status: " + err;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
