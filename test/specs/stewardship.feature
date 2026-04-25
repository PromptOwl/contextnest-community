Feature: Data Stewardship & Approval Workflow
  As a team using the community server
  I want data stewards to govern changes to shared knowledge
  So that published content is reviewed and trusted

  Background:
    Given a community server running in open mode
    And a nest called "Engineering Knowledge"
    And the following stewards are configured in stewards.yaml:
      | email              | scope    | target          | role     |
      | lead@acme.com      | nest     | *               | admin    |
      | jane@acme.com      | tag      | #architecture   | reviewer |
      | bob@acme.com       | folder   | nodes/api-*     | reviewer |
    And the following users exist:
      | email              | name  |
      | dev@acme.com       | Dev   |
      | jane@acme.com      | Jane  |
      | bob@acme.com       | Bob   |
      | lead@acme.com      | Lead  |

  # ── Publishing & Review ──────────────────────────────────────────────

  Scenario: Author publishes a node — it goes to draft, not live
    When Dev creates a node "API Rate Limits" with tag #architecture
    Then the node status is "draft"
    And the node is visible to Dev
    And the node is NOT included in context_resolve queries
    And the response includes the resolved stewards:
      | email              | role     | reason              |
      | jane@acme.com      | reviewer | tag: #architecture  |
      | bob@acme.com       | reviewer | folder: nodes/api-* |
      | lead@acme.com      | admin    | nest-level steward  |

  Scenario: Steward approves a node — it goes live
    Given Dev has a draft node "API Rate Limits"
    When Jane approves "API Rate Limits" with note "Looks good"
    Then the node status is "approved"
    And the node IS included in context_resolve queries
    And the approval is recorded:
      | field        | value            |
      | approved_by  | jane@acme.com    |
      | approved_at  | <timestamp>      |
      | version      | 1                |

  Scenario: Steward requests changes — author is notified
    Given Dev has a draft node "API Rate Limits"
    When Bob rejects "API Rate Limits" with note "Missing error codes section"
    Then the node status is "changes_requested"
    And the response includes the rejection reason
    And Dev can see the rejection note when reading the node

  Scenario: Non-steward cannot approve
    Given Dev has a draft node "API Rate Limits"
    When Dev tries to approve "API Rate Limits"
    Then the request is rejected with 403
    And the response says "Not a steward for this node"

  # ── Version Conflict & History ───────────────────────────────────────

  Scenario: Author updates an approved node — new draft version is created
    Given "API Rate Limits" is approved at version 1
    When Dev updates "API Rate Limits" with new content
    Then version 2 is created with status "draft"
    And version 1 remains the approved version
    And context_resolve still returns version 1 content
    And the response includes the stewards who need to review

  Scenario: Two authors edit the same node — conflict detected
    Given Dev and Bob both read "API Rate Limits" at version 1
    When Dev updates "API Rate Limits" with content "Dev's changes"
    And Bob tries to update "API Rate Limits" with content "Bob's changes"
    Then Bob's update is rejected with 409 Conflict
    And the response includes:
      | field            | value                           |
      | error            | Version conflict                |
      | your_version     | 1                               |
      | current_version  | 2                               |
      | updated_by       | dev@acme.com                    |
      | updated_at       | <timestamp>                     |
    And Bob's content is returned in the response as "rejected_content"
      so Bob does not lose their work

  Scenario: Author can access their own draft versions
    Given Dev has submitted version 2 of "API Rate Limits" (draft)
    When Dev reads "API Rate Limits"
    Then the response includes both versions:
      | version | status   | author       |
      | 1       | approved | dev@acme.com |
      | 2       | draft    | dev@acme.com |

  # ── Super Admin ──────────────────────────────────────────────────────

  Scenario: Super admin can override steward decisions
    Given "API Rate Limits" was rejected by Jane
    When Lead (nest admin) force-approves "API Rate Limits"
    Then the node status is "approved"
    And the approval records:
      | field          | value           |
      | approved_by    | lead@acme.com   |
      | override       | true            |
      | override_note  | "Emergency fix" |

  Scenario: Super admin can bypass the review requirement
    When Lead creates and publishes "Incident Postmortem" with status "approved"
    Then the node is immediately live
    And the audit trail records the bypass

  # ── Steward Resolution ──────────────────────────────────────────────

  Scenario: Steward resolution follows hierarchy
    Given a node "Brand Guidelines" with tag #marketing in folder nodes/brand/
    And stewards.yaml has:
      | scope    | target        | email             |
      | folder   | nodes/brand/* | brand@acme.com    |
      | tag      | #marketing    | marketing@acme.com|
      | nest     | *             | lead@acme.com     |
    Then the resolved stewards for "Brand Guidelines" are:
      | email              | reason                |
      | brand@acme.com     | folder: nodes/brand/* |
      | marketing@acme.com | tag: #marketing       |
      | lead@acme.com      | nest-level steward    |
    And any ONE of them can approve (not all required)
