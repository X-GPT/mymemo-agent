// #730 follow-up — what do readFiles/writeFiles/listFiles accept? (absolute /mnt/ws paths were rejected as traversal)
import { BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand, StopCodeInterpreterSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { readFileSync } from "node:fs"; import { join } from "node:path";
const env = Object.fromEntries(readFileSync(join(import.meta.dir, "probe.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const CI_ID = env.CI_ID; const ci = new BedrockAgentCoreClient({ region: "us-west-2" });
const t0 = Date.now(); const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(7)}ms]`, ...a);
const ms = (t: number) => Math.round(performance.now() - t);
async function call(sid: string, name: string, args: Record<string, unknown>, label: string) {
  const t = performance.now();
  try {
    const out = await ci.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid, name, arguments: args as never }));
    let r: Record<string, unknown> | null = null; for await (const ev of (out.stream ?? []) as AsyncIterable<Record<string, unknown>>) if (ev.result) r = ev.result as Record<string, unknown>;
    const content = ((r?.content ?? []) as Array<Record<string, unknown>>).map((c) => (c.text as string) ?? JSON.stringify(c)).join("\n");
    const sc = (r?.structuredContent ?? {}) as Record<string, unknown>;
    log(`${label} [${ms(t)} ms] isError=${r?.isError} exit=${sc.exitCode ?? "-"}\n    ${((sc.stdout as string) ?? content).trim().replace(/\n/g, "\n    ")}${sc.stderr ? "\n  ! " + String(sc.stderr).trim() : ""}`);
    return r;
  } catch (e) { log(`${label} [${ms(t)} ms] THREW ${(e as Error).name}: ${(e as Error).message}`); return null; }
}
const sh = (sid: string, c: string, l = c.slice(0, 60)) => call(sid, "executeCommand", { command: c }, `$ ${l}`);
let t = performance.now();
const s = (await ci.send(new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, name: "probe2", sessionTimeoutSeconds: 600, clientToken: crypto.randomUUID() }))).sessionId!;
log(`START probe2 (third start of this interpreter) in ${ms(t)} ms`);
await call(s, "writeFiles", { content: [{ path: "/mnt/ws/abs.txt", text: "abs" }] }, "writeFiles ABSOLUTE /mnt/ws/abs.txt");
await call(s, "writeFiles", { content: [{ path: "rel.txt", text: "rel" }] }, "writeFiles RELATIVE rel.txt");
await call(s, "listFiles", { directoryPath: "" }, "listFiles ''");
await call(s, "listFiles", { directoryPath: "/mnt/ws" }, "listFiles ABSOLUTE /mnt/ws");
await call(s, "readFiles", { paths: ["rel.txt"] }, "readFiles RELATIVE rel.txt");
await call(s, "readFiles", { paths: ["../../../../mnt/ws/marker-bash-1788645013380.txt"] }, "readFiles ../ traversal");
await sh(s, "ln -s /mnt/ws ws && ls -la ws/ | head -5", "symlink ws -> /mnt/ws in the workdir");
await call(s, "writeFiles", { content: [{ path: "ws/via-symlink.txt", text: "through symlink" }] }, "writeFiles ws/via-symlink.txt (symlink)");
await call(s, "readFiles", { paths: ["ws/marker-bash-1788645013380.txt"] }, "readFiles ws/marker (symlink)");
await call(s, "listFiles", { directoryPath: "ws" }, "listFiles ws (symlink)");
await sh(s, "ls -la /mnt/ws; cat /mnt/ws/via-symlink.txt 2>&1", "did the symlink write land on the mount?");
await sh(s, "mkdir -p /mnt/ws/sub && ln -s /mnt/ws/sub sub && ls -la", "second symlink + workdir listing");
await call(s, "writeFiles", { content: [{ path: "sub/nested/deep.txt", text: "deep" }] }, "writeFiles sub/nested/deep.txt (creates parents?)");
await sh(s, "find /mnt/ws -type f | sort; echo; cat > /mnt/ws/heredoc.txt <<'H'\nline1\nline2\nH\ncat /mnt/ws/heredoc.txt", "bash heredoc write + read (the fallback)");
await sh(s, "ls -la /; ls -la /opt/amazon/genesis1p-tools/ 2>&1 | head; echo; cat /proc/1/cmdline | tr '\\0' ' '; echo; env | grep -v -i -E 'token|secret|key' | sort | head -40", "sandbox layout + env");
await sh(s, "cd /mnt/ws && pwd && echo hi > cwd-test.txt && ls", "cd into the mount + relative write");
await sh(s, "time (for i in $(seq 1 100); do echo $i > /mnt/ws/perf-$i.txt; done); time cat /mnt/ws/perf-*.txt > /dev/null; time ls /mnt/ws | wc -l", "NFS small-file perf");
await sh(s, "rm -rf /mnt/ws/perf-*.txt /mnt/ws/sub /mnt/ws/cwd-test.txt /mnt/ws/heredoc.txt /mnt/ws/via-symlink.txt; ls /mnt/ws", "cleanup");
t = performance.now(); await ci.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: s })); log(`STOP in ${ms(t)} ms`);
