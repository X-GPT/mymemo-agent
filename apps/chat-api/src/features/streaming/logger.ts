import type { PinoLogger } from "hono-pino";

export class RequestLogger {
	constructor(
		private logger: PinoLogger,
		private memberCode: string,
	) {}

	info(message: Record<string, unknown>) {
		this.logger.info({
			memberCode: this.memberCode,
			...message,
		});
	}

	warn(message: Record<string, unknown>) {
		this.logger.warn({
			memberCode: this.memberCode,
			...message,
		});
	}

	error(message: Record<string, unknown>) {
		this.logger.error({
			memberCode: this.memberCode,
			...message,
		});
	}
}
