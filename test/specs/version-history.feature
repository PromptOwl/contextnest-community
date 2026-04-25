Feature: Version History & Conflict Resolution
  As a team collaborating on shared knowledge
  I want version history and conflict detection
  So that no one's work is lost and changes are traceable

  # ── Version Tracking ─────────────────────────────────────────────────

  Scenario: Every edit creates a new version
    Given a node "Deployment Guide" at version 1
    When Dev updates the content
    Then version 2 is created
    And version 1 is preserved in history
    And the node response includes:
      | field           | value |
      | version         | 2     |
      | previous_version| 1     |

  Scenario: Version history is queryable
    Given "Deployment Guide" has 3 versions
    When I GET /nests/:id/nodes/nodes/deployment-guide/versions
    Then the response includes all 3 versions with:
      | version | status           | author       | updated_at  |
      | 1       | approved         | dev@acme.com | <timestamp> |
      | 2       | approved         | dev@acme.com | <timestamp> |
      | 3       | draft            | bob@acme.com | <timestamp> |

  Scenario: Can read a specific version
    Given "Deployment Guide" has 3 versions
    When I GET /nests/:id/nodes/nodes/deployment-guide?version=1
    Then I get the content from version 1
    And the current version is still 3

  # ── Conflict Detection ───────────────────────────────────────────────

  Scenario: Optimistic concurrency via version header
    Given "Deployment Guide" is at version 2
    When Dev sends PATCH with header X-Base-Version: 2
    Then the update succeeds and creates version 3
    When Bob sends PATCH with header X-Base-Version: 2
    Then the update fails with 409 Conflict
    And the response body includes:
      """
      {
        "error": "Version conflict",
        "your_version": 2,
        "current_version": 3,
        "updated_by": "dev@acme.com",
        "rejected_content": "<Bob's submitted content>"
      }
      """
    And Bob can retry with X-Base-Version: 3

  Scenario: No version header = no conflict check (last-write-wins)
    Given "Deployment Guide" is at version 2
    When Dev sends PATCH without X-Base-Version header
    Then the update succeeds (last-write-wins)
    And a new version is created

  # ── Approved Version Pinning ─────────────────────────────────────────

  Scenario: AI queries get the approved version, not the latest draft
    Given "Deployment Guide" version 2 is approved
    And version 3 is a draft
    When an AI tool calls context_resolve for "Deployment Guide"
    Then it receives version 2 content
    When version 3 is approved
    Then context_resolve returns version 3 content

  Scenario: Rollback to a previous version
    Given "Deployment Guide" has versions 1 (approved), 2 (approved), 3 (draft)
    When Lead rolls back to version 1
    Then version 4 is created with version 1's content
    And version 4 status is "approved"
    And the rollback is recorded in the audit trail
