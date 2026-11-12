/**
 * Base Test Fixtures
 *
 * Extends Playwright's base test with custom fixtures for:
 * - Page object instances (global fixtures)
 * - Role-based authenticated sessions
 * - Logger integration
 * - Common utilities
 *
 * Usage:
 * import { test, expect } from '../../src/lib/base_test.js';
 *
 * test('my test', async ({ primary_user }) => {
 *   await primary_user.initialize();
 *   const nestsPage = primary_user.nestsPage;
 *   // Test continues...
 * });
 */

import { test as baseTest, expect } from '@playwright/test';
import { samples as roles } from './roles.js';
import CommonFunction from '../helper/utility/utility.js';
import logger from '../helper/logger/logger.js';

// Import page objects
import LoginPage from '../page_factory/auth/login_page.js';
import AppShellPage from '../page_factory/app/app_shell_page.js';
import NestsPage from '../page_factory/app/nests_page.js';
import MyWorkPage from '../page_factory/app/my_work_page.js';
import MyDraftsPage from '../page_factory/app/my_drafts_page.js';
import TeamsPage from '../page_factory/app/teams_page.js';
import ApiKeysPage from '../page_factory/app/api_keys_page.js';
import TeammatesPage from '../page_factory/app/teammates_page.js';
import ServerSettingsPage from '../page_factory/app/server_settings_page.js';
import ActivityTracePage from '../page_factory/app/activity_trace_page.js';
import MessageLogPage from '../page_factory/app/message_log_page.js';
import HowItWorksPage from '../page_factory/app/how_it_works_page.js';
import AccountPage from '../page_factory/app/account_page.js';
import SidebarRailPage from '../page_factory/app/sidebar_rail_page.js';
import ImportFolderPage from '../page_factory/app/import_folder_page.js';
import NestArchivePage from '../page_factory/app/nest_archive_page.js';
import NewDocumentPage from '../page_factory/app/new_document_page.js';
import NewFolderPage from '../page_factory/app/new_folder_page.js';
import NestImportPage from '../page_factory/app/nest_import_page.js';
import NestOverviewPage from '../page_factory/app/nest_overview_page.js';
import NestDocumentsPage from '../page_factory/app/nest_documents_page.js';
import ReviewQueuePage from '../page_factory/app/review_queue_page.js';
import CollaboratorsPage from '../page_factory/app/collaborators_page.js';
import FieldsPage from '../page_factory/app/fields_page.js';

// REST helper used to arrange dashboard preconditions (nests, pins, sharing)
import DashboardApi from './dashboard_api.js';

// REST helper used to arrange My Work preconditions (reviews, requests)
import MyWorkApi from './my_work_api.js';

// REST helper used to arrange My Drafts preconditions (drafts, rejections)
import MyDraftsApi from './my_drafts_api.js';

// REST helper used to arrange Teams preconditions (teams, members)
import TeamsApi from './teams_api.js';

// REST helper used to arrange API keys preconditions (keys, scoped nests)
import ApiKeysApi from './api_keys_api.js';

// REST helper used to read Teammates state (directory, super admins)
import TeammatesApi from './teammates_api.js';

// REST helper used to read and remove what an Import Folder run created
import ImportFolderApi from './import_folder_api.js';

// REST helper used to arrange Nest archive preconditions (nests, links, requests)
import NestArchiveApi from './nest_archive_api.js';

// REST helper used to arrange New Document preconditions (nests, folders, governance)
import NewDocumentApi from './new_document_api.js';

// REST helper used to arrange New Folder preconditions (nests, shares, archive)
import NewFolderApi from './new_folder_api.js';

// REST helper used to arrange Nest Import preconditions (nests, documents, shares)
import NestImportApi from './nest_import_api.js';

// REST helper used to arrange Nest Overview preconditions (folders, typed documents, edits)
import NestOverviewApi from './nest_overview_api.js';

// REST helper used to arrange Nest Documents preconditions (tagged documents, shares, governance)
import NestDocumentsApi from './nest_documents_api.js';

// REST helper used to arrange Review Queue preconditions (stewards, submissions, comments)
import ReviewQueueApi from './review_queue_api.js';

// REST helper used to arrange Collaborators preconditions (shares, teams, visibility, keys)
import CollaboratorsApi from './collaborators_api.js';

// REST helper used to arrange Fields preconditions (fields, task rules, tasks, shares)
import FieldsApi from './fields_api.js';
// Assign Steward page (Stewards tab, Assign / Edit / Remove dialogs, review controls)
import StewardsPage from '../page_factory/app/stewards_page.js';
// REST helper used to arrange Assign Steward preconditions (stewards, pending documents)
import StewardsApi from './stewards_api.js';

/**
 * Global fixtures available to all tests
 * These don't require authentication
 */
const globalFixtures = {
  /**
   * Common utility functions
   * Available in all tests as { commonFunction }
   */
  commonFunction: async ({}, use) => {
    const commonFunction = new CommonFunction();
    await use(commonFunction);
  },

  /**
   * Logger instance
   * Available in all tests as { testLogger }
   */
  testLogger: async ({}, use) => {
    await use(logger);
  },
};

/**
 * Standalone page object fixtures
 * These use the default Playwright page (no authentication)
 * Useful for testing login flows, public pages, etc.
 *
 * Usage:
 * test('my test', async ({ loginPage, nestsPage }) => {
 *   await loginPage.goto();
 * });
 */
const pageFixtures = {
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  appShellPage: async ({ page }, use) => {
    await use(new AppShellPage(page));
  },

  nestsPage: async ({ page }, use) => {
    await use(new NestsPage(page));
  },
};

/**
 * Create role-based fixtures
 * Each role gets its own fixture with lazy initialization
 *
 * Role fixtures provide:
 * - Authenticated browser context (loaded from cookies_storage)
 * - Page object instances (loginPage, nestsPage, etc.)
 * - Common utilities
 * - Error logging
 */
// Always register the standard aliases so spec files referencing them load
// even when no credentials are configured (their tests skip via
// `test.skip(!primaryRole, …)` before touching the fixture). Configured
// roles from the environment are merged on top.
const DEFAULT_ALIASES = ['primary_user', 'secondary_user'];
const roleAliases = [...new Set([...DEFAULT_ALIASES, ...Object.keys(roles)])];

const roleFixtures = roleAliases.reduce((acc, roleName) => {
  acc[roleName] = async ({ browser }, use) => {
    const role = roles[roleName];

    // Unconfigured alias: provide a stub that fails loudly if a test ever
    // initializes it instead of skipping.
    if (!role) {
      await use({
        async initialize() {
          throw new Error(
            `Role ${roleName} is not configured. Set the TEST_ACCOUNT*_ variables in tests/.env/ (see tests/env.template).`
          );
        },
      });
      return;
    }

    // Create a role instance with lazy initialization
    const roleInstance = {
      _initialized: false,
      _context: null,
      _page: null,

      /**
       * Initialize context and page with stored authentication
       * Only called when first accessing the role in a test
       */
      async initialize() {
        if (!this._initialized) {
          logger.info(`Initializing role: ${role.alias}`);

          // Load authentication state from cookies_storage
          this._context = await browser.newContext({ storageState: role.path });
          this._page = await this._context.newPage();

          // Add error listener for debugging
          this._page.on('pageerror', (error) => {
            logger.error(`Page error [${role.alias}]: ${error.message}`);
          });

          // Add console listener for debugging
          this._page.on('console', (msg) => {
            if (msg.type() === 'error') {
              logger.error(`Console error [${role.alias}]: ${msg.text()}`);
            }
          });

          this._initialized = true;
          logger.info(`Role initialized: ${role.alias}`);
        }
        return this;
      },

      /**
       * Get the page object
       * Throws if not initialized
       */
      get page() {
        if (!this._initialized) {
          throw new Error(`Role ${roleName} not initialized. Call await ${roleName}.initialize() first.`);
        }
        return this._page;
      },

      /**
       * Get the browser context
       * Throws if not initialized
       */
      get context() {
        if (!this._initialized) {
          throw new Error(`Role ${roleName} not initialized. Call await ${roleName}.initialize() first.`);
        }
        return this._context;
      },

      /**
       * Page object getters
       * Returns page object instances with the current page and role
       */

      // Auth page objects
      get loginPage() {
        return new LoginPage(this.page, role.alias);
      },

      // App shell (header, sidebar, user menu)
      get appShellPage() {
        return new AppShellPage(this.page, role.alias);
      },

      // Nests dashboard
      get nestsPage() {
        return new NestsPage(this.page, role.alias);
      },

      /**
       * REST helper bound to this role's authenticated session — used to
       * arrange test data (nests, archive state, pins, sharing) without
       * driving the UI for setup.
       */
      get dashboardApi() {
        return new DashboardApi(this.page);
      },

      // My Work inbox
      get myWorkPage() {
        return new MyWorkPage(this.page, role.alias);
      },

      /**
       * REST helper for the My Work suite — documents, reviews and deletion
       * requests raised as this role.
       */
      get myWorkApi() {
        return new MyWorkApi(this.page);
      },

      // My Drafts list
      get myDraftsPage() {
        return new MyDraftsPage(this.page, role.alias);
      },

      /**
       * REST helper for the My Drafts suite — drafts, rejected drafts and
       * drafts over an approved version, written as this role.
       */
      get myDraftsApi() {
        return new MyDraftsApi(this.page);
      },

      // Workspace → Teams
      get teamsPage() {
        return new TeamsPage(this.page, role.alias);
      },

      /**
       * REST helper for the Teams suite. One instance per role and test, so
       * the teams it remembers for cleanup belong to that test alone.
       */
      get teamsApi() {
        if (!this._teamsApi) this._teamsApi = new TeamsApi(this.page);
        return this._teamsApi;
      },

      // Workspace → API keys
      get apiKeysPage() {
        return new ApiKeysPage(this.page, role.alias);
      },

      /** REST helper for the API keys suite — keys and scoped nests. */
      get apiKeysApi() {
        return new ApiKeysApi(this.page);
      },

      // Admin → Teammates
      get teammatesPage() {
        return new TeammatesPage(this.page, role.alias);
      },

      /** REST helper for the Teammates suite — read-only directory lookups. */
      get teammatesApi() {
        return new TeammatesApi(this.page);
      },

      // Admin → Server settings
      get serverSettingsPage() {
        return new ServerSettingsPage(this.page, role.alias);
      },

      // Admin → Activity trace
      get activityTracePage() {
        return new ActivityTracePage(this.page, role.alias);
      },

      // Admin → Message log
      get messageLogPage() {
        return new MessageLogPage(this.page, role.alias);
      },

      // Help → How it works
      get howItWorksPage() {
        return new HowItWorksPage(this.page, role.alias);
      },

      // User menu → Account
      get accountPage() {
        return new AccountPage(this.page, role.alias);
      },

      // Sidebar rail
      get sidebarRailPage() {
        return new SidebarRailPage(this.page, role.alias);
      },

      // Nests → Import Folder dialog
      get importFolderPage() {
        return new ImportFolderPage(this.page, role.alias);
      },

      /**
       * REST helper for the Import Folder suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get importFolderApi() {
        if (!this._importFolderApi) this._importFolderApi = new ImportFolderApi(this.page);
        return this._importFolderApi;
      },

      // Nest page → archive, read-only archived nest, archive requests
      get nestArchivePage() {
        return new NestArchivePage(this.page, role.alias);
      },

      /**
       * REST helper for the Nest archive suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get nestArchiveApi() {
        if (!this._nestArchiveApi) this._nestArchiveApi = new NestArchiveApi(this.page);
        return this._nestArchiveApi;
      },

      // Nest page → New Document editor
      get newDocumentPage() {
        return new NewDocumentPage(this.page, role.alias);
      },

      /**
       * REST helper for the New Document suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get newDocumentApi() {
        if (!this._newDocumentApi) this._newDocumentApi = new NewDocumentApi(this.page);
        return this._newDocumentApi;
      },

      // Nest page → New Folder dialog, Contents tree
      get newFolderPage() {
        return new NewFolderPage(this.page, role.alias);
      },

      /**
       * REST helper for the New Folder suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get newFolderApi() {
        if (!this._newFolderApi) this._newFolderApi = new NewFolderApi(this.page);
        return this._newFolderApi;
      },

      // Nest page → Import dialog (Files, Upload PDF, Whole vault)
      get nestImportPage() {
        return new NestImportPage(this.page, role.alias);
      },

      /**
       * REST helper for the Nest Import suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get nestImportApi() {
        if (!this._nestImportApi) this._nestImportApi = new NestImportApi(this.page);
        return this._nestImportApi;
      },

      // Nest page → Overview tab (facts, Contents tree, Recently edited, empty nest)
      get nestOverviewPage() {
        return new NestOverviewPage(this.page, role.alias);
      },

      /**
       * REST helper for the Nest Overview suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get nestOverviewApi() {
        if (!this._nestOverviewApi) this._nestOverviewApi = new NestOverviewApi(this.page);
        return this._nestOverviewApi;
      },

      // Nest page → Documents tab (search, filters, folders, row and bulk actions)
      get nestDocumentsPage() {
        return new NestDocumentsPage(this.page, role.alias);
      },

      /**
       * REST helper for the Nest Documents suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get nestDocumentsApi() {
        if (!this._nestDocumentsApi) this._nestDocumentsApi = new NestDocumentsApi(this.page);
        return this._nestDocumentsApi;
      },

      // Nest page → Review Queue tab (queue, chips, review pane, bulk, deletions)
      get reviewQueuePage() {
        return new ReviewQueuePage(this.page, role.alias);
      },

      /**
       * REST helper for the Review Queue suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get reviewQueueApi() {
        if (!this._reviewQueueApi) this._reviewQueueApi = new ReviewQueueApi(this.page);
        return this._reviewQueueApi;
      },

      // Nest page → Collaborators tab (roster, roles, teams, visibility, API-only keys)
      get collaboratorsPage() {
        return new CollaboratorsPage(this.page, role.alias);
      },

      /**
       * REST helper for the Collaborators suite. One instance per role and
       * test, so the nests and teams it remembers for cleanup belong to that
       * test alone.
       */
      get collaboratorsApi() {
        if (!this._collaboratorsApi) this._collaboratorsApi = new CollaboratorsApi(this.page);
        return this._collaboratorsApi;
      },

      // Nest page → Fields tab (custom fields, task numbering, surfaces, stages)
      get fieldsPage() {
        return new FieldsPage(this.page, role.alias);
      },

      /**
       * REST helper for the Fields suite. One instance per role and test, so
       * the nests it remembers for cleanup belong to that test alone.
       */
      get fieldsApi() {
        if (!this._fieldsApi) this._fieldsApi = new FieldsApi(this.page);
        return this._fieldsApi;
      },

      // Nest page → Assign Steward (Stewards tab and dialogs, what a steward can do)
      get stewardsPage() {
        return new StewardsPage(this.page, role.alias);
      },

      /**
       * REST helper for the Assign Steward suite. One instance per role and
       * test, so the nests it remembers for cleanup belong to that test alone.
       */
      get stewardsApi() {
        if (!this._stewardsApi) this._stewardsApi = new StewardsApi(this.page);
        return this._stewardsApi;
      },

      /**
       * Utility instances
       */
      get commonFunction() {
        return new CommonFunction(this.page, role.alias);
      },

      /**
       * Role information
       */
      get roleInfo() {
        return {
          alias: role.alias,
          email: role.email,
        };
      },

      /**
       * Cleanup method
       * Closes context and resets initialization flag
       */
      async close() {
        if (this._context) {
          await this._context.close();
          logger.info(`Role context closed: ${role.alias}`);
        }
        this._initialized = false;
      },
    };

    // Pass the role instance to the test
    await use(roleInstance);

    // Cleanup after the test
    await roleInstance.close();
  };
  return acc;
}, {});

/**
 * Extended test with all fixtures
 * Combines global, page, and role-based fixtures
 */
const test = baseTest.extend({
  ...globalFixtures,
  ...pageFixtures,
  ...roleFixtures,
});

/**
 * Export test and expect
 *
 * Usage in test files:
 * import { test, expect } from '../../src/lib/base_test.js';
 *
 * test('test with primary user', async ({ primary_user, commonFunction }) => {
 *   await primary_user.initialize();
 *   // Use primary_user.page, primary_user.nestsPage, etc.
 * });
 */
export { test, expect };
