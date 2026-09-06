import { BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand, StopCodeInterpreterSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
const CI_ID = "mymemo_ci_sandbox_probe-hJpoWWrNdE"; const ci = new BedrockAgentCoreClient({ region: "us-west-2" });
const s = await ci.send(new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, name: "sbx-c", sessionTimeoutSeconds: 300, clientToken: crypto.randomUUID() })); const sid = s.sessionId!;
const inv = async (name: string, args: Record<string, unknown>) => { try { const out = await ci.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid, name, arguments: args as never })); let r: any = null; for await (const ev of (out.stream ?? []) as AsyncIterable<any>) if (ev.result) r = ev.result; return `ok=${!r?.isError}`; } catch (e) { return `ERR ${(e as Error).message}`; } };
await inv("executeCommand", { command: "mkdir -p ws && head -c 40M /dev/urandom > ws/r40.bin && head -c 35M ws/r40.bin > ws/r35.bin" });
for (const mb of [35, 40]) console.log(`readFiles ${mb} MB: ${await inv("readFiles", { paths: [`ws/r${mb}.bin`] })}`);
await ci.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid }));
