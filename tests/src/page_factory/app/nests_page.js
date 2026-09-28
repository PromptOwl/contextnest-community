/**
 * Nests Dashboard Page Object Model
 *
 * Page location: ui/src/pages/app/nests/page.tsx
 * Route: / (default authenticated landing page)
 *
 * The nests dashboard lists owned, shared and discovered nests with
 * filter/sort/scope controls and an archived-nests section.
 */

import logger from '../../helper/logger/logger.js';

class NestsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} roleAlias - Optional role alias for logging
   */
  constructor(page, roleAlias = null) {
    this.page = page;
    this.roleAlias = roleAlias;

    // Always-present page heading (ui/src/components/ui/page-title.tsx)
    this.pageTitle = page.getByTestId('page-title');

    // Filter / sort controls (ui/src/pages/app/nests/page.tsx).
    // NOTE: the filter bar only renders once the account has more than 5
    // nests — use pageTitle as the loaded-landmark, not these.
    this.filterInput = page.getByTestId('nest-filter-input');
    this.scopeSelect = page.getByTestId('nest-scope-select');
    this.sortSelect = page.getByTestId('nest-sort-select');
    this.clearFilters = page.getByTestId('nest-clear-filters');

    // Archived section
    this.archivedSwitch = page.getByTestId('nest-archived-switch');
    this.archivedSection = page.getByTestId('archived-nests');
    this.archivedFilterInput = page.getByTestId('archived-filter-input');

    // Misc
    this.browseDiscovered = page.getByTestId('nest-browse-discovered');
    this.showMore = page.getByTestId('nest-show-more');
  }

  /**
   * Navigate to the nests dashboard (authenticated root)
   */
  async goto() {
    logger.info(`${this.roleAlias ? `[${this.roleAlias}] ` : ''}Navigating to nests dashboard`);
    await this.page.goto('/');
    await this.pageTitle.waitFor({ state: 'visible' });
    logger.info('Nests dashboard loaded');
  }

  /**
   * Filter the nest list by name
   * @param {string} text - Filter text
   */
  async filterByName(text) {
    logger.info(`Filtering nests by: ${text}`);
    await this.filterInput.fill(text);
  }

  /**
   * Open a nest by its visible name (navigates to /nest/<id>/…)
   * @param {string} name - Nest name as rendered in the list
   */
  async openNest(name) {
    logger.info(`Opening nest: ${name}`);
    await this.page.getByRole('link', { name }).first().click();
  }

  /**
   * Whether the dashboard has rendered
   * @returns {Promise<boolean>}
   */
  async isLoaded() {
    try {
      return await this.pageTitle.isVisible({ timeout: 5000 });
    } catch (_) {
      return false;
    }
  }
}

export default NestsPage;
