---
id: product-factory
version: 1
title: Product factory
description: Take an idea through eight reviewed stages to a shipped, tested feature. Each stage reads only what it needs, and two capped review loops keep design and build honest.
recipe:
  name: Product factory
  purpose: Take an idea through eight reviewed stages, from intent to a shipped and tested feature.
  order: 10
layers: [framework, thesis]
folders:
  - { path: specs/, purpose: specs }
  - { path: standards/, purpose: standards }
  - { path: decisions/, purpose: decisions }
  - { path: retros/, purpose: retros }
  - { path: agents/, purpose: agents, admin_only: true }
tags:
  - { tag: spec, meaning: "A goal, need, design review, PRD or evaluation for one feature." }
  - { tag: standard, meaning: "A rulebook a stage follows." }
  - { tag: decision, meaning: "An agreed choice, with who made it and why." }
  - { tag: retro, meaning: "What a run taught us, and the change it makes." }
definitions:
  - term: stage
    definition: One step of the pipeline, with one standard, declared inputs and one output. Intent, red team, design, design review, PRD, build, smoke and eval, retro.
  - term: gate
    definition: A reviewer's verdict that lets work move on. Design review says DESIGN_APPROVED yes or no; eval says OBJECTIVES_MET yes or no.
  - term: loop
    definition: A reviewer handing concrete fixes back to the stage before it. Capped at two rounds; a third means the goal needs rework.
  - term: isolation
    definition: Each stage sees only the goal, its own standard and the artifacts handed to it, never the whole nest.
thesis: seeds/product-factory/thesis
distill: seeds/product-factory/distill
boards:
  - name: Build pipeline
    stages: [intent, red-team, design, design-review, prd, build, smoke-eval, retro, shipped]
    task_stages: true
channels:
  - name: builds
    purpose: "One thread per feature. Each stage posts its output here, and gates are approved here."
  - name: releases
    purpose: "What shipped, when, and what to watch after release."
hire:
  - kind: key
    handle: builder
    why: "Your coding agent (Claude Code, Cursor or opencode) with a key of its own. It picks up the threads that tag it and posts each stage's output."
  - kind: watcher
    handle: builds-watcher
    channels: [builds]
    why: "Reads #builds and points out decisions and tasks that were agreed but not written down."
  - kind: hootie
    handle: hootie
    why: "Answers questions about specs and standards from the nest, with citations."
listener:
  propose_folders: [specs/, decisions/, retros/]
  domain_tags: [spec, decision, retro]
  never_propose:
    - { category: compensation, terms: [salary, wage, payroll, my equity, equity grant, stock option] }
    - { category: health, terms: [medical, illness, sick leave, diagnosis] }
    - { category: performance-review, terms: [underperforming, disciplinary, improvement plan] }
    - { category: personal-life, terms: [divorce, dating someone, family problem] }
    - { category: credentials, terms: [password, api key, private key, access token] }
nodes:
  - { id: seeds/product-factory/instructions, target: context }
  - { id: seeds/product-factory/runbook, target: runbook }
  - { id: seeds/product-factory/standards/product-brief, target: standards/product-brief }
  - { id: seeds/product-factory/standards/design-review, target: standards/design-review }
  - { id: seeds/product-factory/standards/prd, target: standards/prd }
  - { id: seeds/product-factory/standards/code-and-tests, target: standards/code-and-tests }
  - { id: seeds/product-factory/standards/evaluation, target: standards/evaluation }
---
The `product-factory` recipe. A nest made from it has the pipeline's
folders, five standards, a runbook to start from, a Build pipeline board with
one column per stage, #builds and #releases (when team chat is on), and three
agents worth hiring.
