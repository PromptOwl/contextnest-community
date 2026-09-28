// @ts-check

/**
 * Custom Playwright reporter.
 * Pass  →  green ✓  +  test title
 * Fail  →  red   ✗  +  test title  +  error message only
 * All console.log / console.info / console.error from tests are suppressed.
 */

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

class CleanReporter {
  constructor() {
    this._passed = 0;
    this._failed = 0;
    this._skipped = 0;
  }

  onBegin(_config, suite) {
    const total = suite.allTests().length;
    process.stdout.write(`\nRunning ${total} test(s)...\n\n`);
  }

  onTestBegin(test) {
    const title = test.titlePath().slice(1).join(' > ');
    process.stdout.write(`${YELLOW}  ⟳${RESET}  ${DIM}${title}${RESET}\n`);
  }

  // Suppress all stdout from tests (console.log, console.info, etc.)
  onStdOut() {}

  // Suppress all stderr from tests (console.error, etc.)
  onStdErr() {}

  onTestEnd(test, result) {
    const title = test.titlePath().slice(1).join(' > ');

    if (result.status === 'passed') {
      this._passed++;
      process.stdout.write(`${GREEN}  ✓${RESET}  ${title}\n`);
    } else if (result.status === 'skipped') {
      this._skipped++;
      process.stdout.write(`${DIM}  -  ${title}${RESET}\n`);
    } else {
      this._failed++;
      process.stdout.write(`${RED}  ✗${RESET}  ${title}\n`);

      // Print only the error message, no stack trace noise
      const error = result.errors?.[0];
      if (error) {
        const lines = (error.message || '').split('\n');
        const truncated = lines.length > 15;
        const message =
          lines.slice(0, 15).join('\n') + (truncated ? '\n     ... (see HTML report for full error)' : '');
        process.stdout.write(`${RED}     ${message.replace(/\n/g, '\n     ')}${RESET}\n`);
      }
      process.stdout.write('\n');
    }
  }

  onEnd(result) {
    process.stdout.write('\n');
    process.stdout.write(`${GREEN}  Passed:  ${this._passed}${RESET}\n`);
    if (this._failed > 0) {
      process.stdout.write(`${RED}  Failed:  ${this._failed}${RESET}\n`);
    }
    if (this._skipped > 0) {
      process.stdout.write(`${DIM}  Skipped: ${this._skipped}${RESET}\n`);
    }
    process.stdout.write(`\n  Duration: ${(result.duration / 1000).toFixed(1)}s\n\n`);
  }
}

export default CleanReporter;
