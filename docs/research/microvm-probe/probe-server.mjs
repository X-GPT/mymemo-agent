// Minimal in-VM server for probe #646. Two jobs:
//  1) Answer the AWS MicroVM lifecycle hooks so the VM boots/suspends/resumes cleanly.
//  2) On GET /probe, run probe.sh and stream its RESULT lines back (item 7: SSE through
//     the authenticated per-VM endpoint). GET /stream is a pure SSE smoke.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 8080;
const HOOK = "/aws/lambda-microvms/runtime/v1"; // run|resume|suspend|terminate

createServer((req, res) => {
  const { url, method } = req;

  // Lifecycle hooks: 200 = proceed. /run gates traffic; /suspend runs before snapshot
  // (where a real image would checkpoint ~/.claude + workspace to S3).
  if (url.startsWith(HOOK)) {
    res.writeHead(200).end("ok");
    return;
  }

  if (url === "/healthz") { res.writeHead(200).end("ok"); return; }

  if (url === "/stream") { // item 7: does SSE survive the proxy + egress lockdown?
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let n = 0;
    const t = setInterval(() => { res.write(`data: chunk ${++n}\n\n`); if (n >= 5) { clearInterval(t); res.end(); } }, 300);
    req.on("close", () => clearInterval(t));
    return;
  }

  if (url.startsWith("/probe")) { // run measurements, stream RESULT lines
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-cache" });
    const phase = new URL(url, "http://x").searchParams.get("phase") || "plant";
    const p = spawn("bash", ["/opt/probe/probe.sh"], { env: { ...process.env, MARKER_PHASE: phase } });
    p.stdout.pipe(res); p.stderr.pipe(res);
    p.on("close", (code) => res.end(`\nEXIT ${code}\n`));
    return;
  }

  res.writeHead(404).end("not found");
}).listen(PORT, () => console.log(`probe-server on :${PORT}`));
