/**
 * Winston Logger Configuration
 *
 * Provides centralized logging for test execution with console and file transports.
 * Errors are logged to tests/test-results/error.log for debugging.
 */

import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const { createLogger, format, transports } = winston;
const { combine, timestamp, printf, colorize } = format;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Custom log format with timestamp and level
 */
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

/**
 * Winston logger instance
 *
 * Features:
 * - Console output with colors
 * - File output for errors (tests/test-results/error.log)
 * - Timestamp formatting
 */
const logger = createLogger({
  level: 'info',
  format: combine(
    colorize(),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console transport for all logs
    new transports.Console(),

    // File transport for error logs only
    new transports.File({
      filename: path.resolve(__dirname, '../../../test-results/error.log'),
      level: 'error',
    }),
  ],
});

/**
 * Log levels:
 * - error: Error messages (written to file and console)
 * - warn: Warning messages (console only)
 * - info: Informational messages (console only)
 * - debug: Debug messages (console only)
 *
 * Usage:
 * import logger from '../helper/logger/logger.js';
 * logger.info('Test started');
 * logger.error(`Test failed: ${error.message}`);
 */

export default logger;
