---
id: generic-team
version: 1
title: Generic team
description: A starting shape for any team. Decisions, people, projects, customers and how the team works, plus an admin-only folder for agents.
layers: [org_mirror, framework, thesis]
folders:
  - { path: decisions/, purpose: decisions }
  - { path: people/, purpose: people }
  - { path: projects/, purpose: areas }
  - { path: customers/, purpose: customers }
  - { path: how-we-work/, purpose: process }
  - { path: agents/, purpose: agents, admin_only: true }
tags:
  - { tag: decision, meaning: An agreed choice the team made. }
  - { tag: customer, meaning: About a customer or prospect. }
  - { tag: process, meaning: How the team works. }
definitions:
  - term: decision
    definition: An agreed choice, with who made it and when. Another participant agreed, or the decider's authority is clear.
  - term: owner
    definition: The one person accountable for a piece of work or an area. Every project and every commitment has exactly one.
  - term: customer
    definition: An organisation that pays us, or is in a buying conversation with us.
  - term: renewal
    definition: The point where a customer's contract is extended for another term, and the terms it is extended on.
thesis: seeds/generic-team/thesis
listener:
  propose_folders: [decisions/, people/, projects/, customers/, how-we-work/]
  domain_tags: [decision, customer, process]
  # Categories the listener must never propose, with plain-word synonyms the
  # deterministic filter also checks (plurals and simple inflections match).
  # Every term also blocks the seed's own folders, so business words that double
  # as private ones ("customer relationship", "equity round") are phrases here.
  never_propose:
    - { category: compensation, terms: [salary, wage, payroll, paycheck, pay rise, pay cut, my equity, equity grant, stock option] }
    - { category: health, terms: [medical, illness, off sick, sick leave, diagnosis, pregnancy, in therapy, therapist] }
    - { category: performance-review, terms: [underperforming, disciplinary, warning letter, improvement plan] }
    - { category: personal-life, terms: [divorce, dating someone, romantic relationship, relationship problems, religion, family problem] }
    - { category: gossip, terms: [rumour, rumor, between us, off the record] }
    - { category: credentials, terms: [password, api key, private key, access token] }
nodes:
  - { id: seeds/generic-team/instructions, target: context }
  - { id: seeds/generic-team/thesis, target: thesis }
---
The `generic-team` seed. Applying it gives a nest its folders, four glossary
definitions, the CONTEXT.md below and a one-page thesis to edit.
