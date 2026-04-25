Feature: Access Control via Config
  As an admin deploying the community server
  I want to control who can access the server via config files
  So that I don't have to manage permissions through API calls

  # ── Config-Based Access ──────────────────────────────────────────────

  Scenario: Admin restricts access to specific emails
    Given the server config access.yaml contains:
      """
      mode: restricted
      allowed_users:
        - alice@acme.com
        - bob@acme.com
        - "*.acme.com"        # wildcard: any @acme.com email
      """
    When charlie@gmail.com tries to register
    Then registration is rejected with "Email not in allowed list"
    When alice@acme.com registers
    Then registration succeeds
    When newdev@acme.com registers
    Then registration succeeds (matches wildcard)

  Scenario: Admin defines groups in config
    Given access.yaml contains:
      """
      groups:
        engineering:
          members:
            - alice@acme.com
            - bob@acme.com
          default_permission: write
        leadership:
          members:
            - lead@acme.com
          default_permission: admin
        contractors:
          members:
            - ext1@vendor.com
          default_permission: read
      """
    When a nest is created
    Then engineering group members automatically get write access
    And leadership group members automatically get admin access
    And contractors automatically get read access

  Scenario: Admin restricts access by group on a nest
    Given access.yaml has groups "engineering" and "contractors"
    And the nest stewards.yaml contains:
      """
      access:
        - group: engineering
          permission: write
        - group: contractors
          permission: read
      """
    When a contractor tries to create a node
    Then the request is rejected with 403
    When an engineer creates a node
    Then the node is created successfully

  # ── Open Mode with Config Overrides ──────────────────────────────────

  Scenario: Open mode still respects stewards.yaml
    Given AUTH_MODE=open
    And the nest has a stewards.yaml
    When anyone creates a node
    Then the node is created as "draft"
    And the response identifies the stewards
    And the node only goes live when a steward approves

  Scenario: Open mode without stewards.yaml — everything is live
    Given AUTH_MODE=open
    And the nest has NO stewards.yaml
    When anyone creates a node
    Then the node status is "approved" (auto-approved)
    And the node is immediately available in context_resolve

  # ── Super Admin in Config ────────────────────────────────────────────

  Scenario: Config defines super admins
    Given access.yaml contains:
      """
      super_admins:
        - lead@acme.com
        - cto@acme.com
      """
    Then lead@acme.com can:
      - Approve any node in any nest
      - Override steward rejections
      - Delete any node
      - Manage all nests
    And regular users cannot do any of the above
