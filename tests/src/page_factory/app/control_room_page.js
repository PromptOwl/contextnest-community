/**
 * Control Room Page Object Model
 *
 * Page location: ui/src/pages/app/control-room/ (page.tsx, SetupWizard.tsx, HowItWorks.tsx)
 * Route: /control-room (rail → Workspace → Control room; server admins while Surfaces is on)
 *
 * Tabs: Overview, Decision ledger, Agents, Setup, How it works. Setup is a
 * five-step wizard; each step pane carries data-testid="setup-step-<n>".
 */

class ControlRoomPage {
  /** @param {import('@playwright/test').Page} page */
  constructor(page) {
    this.page = page;
    this.railItem = page.getByTestId('document-sidebar-dashboard-control-room');
    this.root = page.getByTestId('control-room-page');
    this.tab = (name) => page.getByRole('tab', { name, exact: false });
    this.wizard = page.getByTestId('setup-wizard');
    this.steps = page.getByTestId('setup-steps').getByRole('button');
    this.progress = page.getByTestId('setup-progress');
    this.willNever = page.getByTestId('setup-will-never');
    this.stepPane = (n) => page.getByTestId(`setup-step-${n}`);
    this.button = (name) => page.locator('main').getByRole('button', { name, exact: true });
  }

  async goto(tab = 'setup') {
    await this.page.goto(`/control-room?section=${tab}`);
    await this.root.waitFor();
  }

  /** The rail button for step n (1-based). */
  stepButton(n) {
    return this.steps.nth(n - 1);
  }
}

export default ControlRoomPage;
