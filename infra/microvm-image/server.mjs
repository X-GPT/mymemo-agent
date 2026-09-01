// Placeholder in-VM server for the production MicroVM image (ticket #661).
// It retires the platform risk before the real In-VM server (#666) exists:
//  - answers the build and lifecycle hooks so the image build snapshots and
//    boot/suspend/resume/terminate cycle cleanly,
//  - GET /healthz answers through the platform's JWE-authenticated endpoint,
//  - GET /smoke streams the in-VM acceptance checks (bubblewrap namespaces,
//    pinned versions, root-owned managed settings).
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const PORT = process.env.PORT || 8080;
const HOOKS = "/aws/lambda-microvms/runtime/v1"; // ready|validate|run|resume|suspend|terminate

createServer((req, res) => {
	const { url } = req;

	// 200 = proceed. /ready gates the image-build snapshot; /suspend runs
	// before the platform snapshots the VM. The real server (#666/#670) turns
	// /suspend into the graceful-drain + checkpoint gate.
	if (url.startsWith(HOOKS)) {
		res.writeHead(200).end("ok");
		return;
	}

	if (url === "/healthz") {
		res.writeHead(200).end("ok");
		return;
	}

	if (url === "/smoke") {
		res.writeHead(200, {
			"content-type": "text/plain",
			"cache-control": "no-cache",
		});
		const p = spawn("bash", ["/opt/microvm/smoke.sh"]);
		p.stdout.pipe(res, { end: false });
		p.stderr.pipe(res, { end: false });
		p.on("close", (code) => res.end(`\nEXIT ${code}\n`));
		return;
	}

	res.writeHead(404).end("not found");
}).listen(PORT, () => console.log(`microvm placeholder server on :${PORT}`));
