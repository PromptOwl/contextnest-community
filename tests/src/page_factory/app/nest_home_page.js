/**
 * Nest Documents home (po-1213) — the nest page after Overview merged into
 * Documents: the summary line, the "Recently edited" feed, the rows' last
 * edit, and the header's ⋯ menu that now holds Fields, Reader mode and the
 * list/grid switch (ui/src/components/nest/DocumentsHome.tsx, NestView.tsx).
 */
class NestHomePage {
  constructor(page) {
    this.page = page;
    this.home = page.getByTestId('documents-home');
    this.facts = page.getByTestId('nest-home-facts');
    this.feed = page.getByTestId('nest-recent-feed');
    this.moreActions = page.locator('button[title="More actions"]').first();
    this.fieldsDialog = page.getByTestId('nest-fields-dialog');
  }

  /** Open a nest (optionally with a ?tab=) and wait for the Documents home. */
  async gotoNest(nestId, tab) {
    await this.page.goto(`/nest/${nestId}${tab ? `?tab=${tab}` : ''}`);
    await this.home.waitFor({ state: 'visible', timeout: 60_000 });
  }

  tab(name) {
    return this.page.getByRole('tab', { name, exact: true });
  }

  feedItem(nodeId) {
    return this.page.getByTestId(`recent-item-${nodeId}`);
  }

  rowLastEdit(nodeId) {
    return this.page.getByTestId(`last-edit-${nodeId}`);
  }

  async openMenu() {
    await this.moreActions.click();
  }

  menuItem(testId) {
    return this.page.getByTestId(testId);
  }
}

export default NestHomePage;
