import { mkdirSync } from 'fs';
import { join } from 'path';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const logsBasePath = process.env.LOGS_BASE_PATH || '/efs/logs';
const logsDirectory = join(
	logsBasePath,
	process.env.MICROSERVICE_NAME_FOR_LOGS || 'app'
);

mkdirSync(logsDirectory, { recursive: true });

const infoTransport: DailyRotateFile = new DailyRotateFile({
	filename: join(logsDirectory, 'app-info-%DATE%.log'),
	datePattern: 'YYYY-MM-DD',
	zippedArchive: true,
	maxFiles: process.env.MAX_DAYS_FOR_LOGS + 'd',
	level: 'info'
});

const errorTransport: DailyRotateFile = new DailyRotateFile({
	filename: join(logsDirectory, 'app-error-%DATE%.log'),
	datePattern: 'YYYY-MM-DD',
	zippedArchive: true,
	maxFiles: process.env.MAX_DAYS_FOR_LOGS + 'd',
	level: 'error'
});

const debugTransport: DailyRotateFile = new DailyRotateFile({
	filename: join(logsDirectory, 'app-debug-%DATE%.log'),
	datePattern: 'YYYY-MM-DD',
	zippedArchive: true,
	maxFiles: process.env.MAX_DAYS_FOR_LOGS + 'd',
	level: 'debug'
});

const logger = winston.createLogger({
	transports: [
		infoTransport,
		debugTransport,
		errorTransport
	]
});

export const logHttpRequest = (url: string) => {
	logger.info({
		logOf: 'incoming_http_request',
		timestamp: new Date().toISOString(),
		message: url,
	})
}

export const logToErrorFile = (exception, source: string) => {
	logger.error({
		logOf: 'error',
		timestamp: new Date().toISOString(),
		message: exception?.message,
		status: exception?.status,
		stack: exception?.stack,
		source,
	})
}

export const logElkError = (exception, request, functionName) => {
	logger.error({
		logOf: 'elkError',
		timestamp: new Date().toISOString(),
		functionName,
		exception,
		request,
	})
}

export const stringifiedErrorLog = (error, origin: string) => {
	logger.error({
		logOf: 'stringifiedErrorLog',
		timestamp: new Date().toISOString(),
		error: JSON.stringify(error),
		origin
	})
}
