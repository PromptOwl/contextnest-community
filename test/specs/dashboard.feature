Feature: Lightweight Admin Dashboard
  As an admin of the community server
  I want a simple web dashboard
  So that I can manage nests, users, and review queues without API calls

  # ── Dashboard Access ─────────────────────────────────────────────────

  Scenario: Dashboard served at root
    When I open http://localhost:3838 in a browser
    Then I see the ContextNest Community dashboard
    And it shows:
      - Server status (ok / suspended / unlicensed)
      - Number of nests
      - Number of nodes across all nests
      - Number of pending reviews
      - Auth mode (open / key)

  Scenario: Dashboard in open mode — no login needed
    Given AUTH_MODE=open
    When I open the dashboard
    Then I see everything immediately
    And I can manage nests and nodes directly

  Scenario: Dashboard in key mode — login required
    Given AUTH_MODE=key
    When I open the dashboard
    Then I see a login form
    And I can login with email/password or PromptOwl

  # ── Nest Management ──────────────────────────────────────────────────

  Scenario: View all nests
    When I navigate to the Nests page
    Then I see a list of all nests with:
      | column      | example              |
      | Name        | Engineering Knowledge|
      | Nodes       | 42                   |
      | Visibility  | private              |
      | Created     | 2026-04-13           |
    And I can click to view a nest

  Scenario: View nest detail
    When I click on "Engineering Knowledge"
    Then I see:
      - List of all nodes with title, type, status, tags
      - CONTEXT.md content
      - Collaborators list
      - Stewards (from stewards.yaml)
    And I can create, edit, delete nodes inline

  # ── Review Queue ─────────────────────────────────────────────────────

  Scenario: Steward sees their review queue
    When Jane opens the dashboard
    Then she sees a "Pending Reviews" section
    And it lists all nodes awaiting her approval:
      | node             | author       | submitted   |
      | API Rate Limits  | dev@acme.com | 2 hours ago |
    And she can approve or request changes from the dashboard

  Scenario: Approve from dashboard
    When Jane clicks "Approve" on "API Rate Limits"
    And optionally enters a note
    Then the node becomes approved
    And the review queue updates

  # ── Config Editor ────────────────────────────────────────────────────

  Scenario: View and edit stewards.yaml from dashboard
    When I navigate to the nest settings
    Then I see the current stewards.yaml rendered as a table
    And I can edit it inline or switch to raw YAML view
    And changes are saved to the file on disk

  Scenario: View and edit access.yaml from dashboard
    When I navigate to server settings
    Then I see:
      - Allowed users / wildcards
      - Groups and their members
      - Super admins
    And I can edit inline

  # ── Dashboard is Optional ────────────────────────────────────────────

  Scenario: Server works without dashboard
    Given the server is running
    When I only use the REST API and MCP endpoints
    Then everything works the same as with the dashboard
    And the dashboard is just a static HTML frontend to the same API
