---
id: ideation
version: 1
title: Ideation
description: Collect ideas in one place, score them the same way every time, and review the best ones together each week.
recipe:
  name: Ideation
  purpose: Collect ideas, score them the same way every time, and review the best each week.
  order: 40
layers: [framework, thesis]
folders:
  - { path: ideas/, purpose: ideas }
  - { path: reviews/, purpose: reviews }
  - { path: decisions/, purpose: decisions }
tags:
  - { tag: idea, meaning: "An idea, in one page, with its score." }
  - { tag: review, meaning: "Notes from a weekly review: what was promoted, parked or dropped." }
definitions:
  - term: score
    definition: The total from the scoring rubric, out of 25. Ideas are compared by score, then discussed.
  - term: promoted
    definition: An idea the weekly review agreed to act on. It leaves ideation and becomes work somewhere else.
  - term: parked
    definition: An idea kept for later, with the reason and the date to look again.
thesis: seeds/ideation/thesis
boards:
  - name: Idea intake
    stages: [new, scoring, shortlisted, parked, promoted]
    task_stages: true
channels:
  - name: weekly-review
    purpose: "One thread per week: the shortlist, the discussion and what was promoted or parked."
hire:
  - kind: hootie
    handle: hootie
    why: "Finds similar ideas already in the nest before a new one is scored, with citations."
  - kind: watcher
    handle: review-watcher
    channels: [weekly-review]
    why: "Reads #weekly-review and points out decisions that were made but not recorded."
listener:
  propose_folders: [ideas/, decisions/]
  domain_tags: [idea]
  never_propose:
    - { category: compensation, terms: [salary, wage, payroll, my equity, equity grant, stock option] }
    - { category: health, terms: [medical, illness, sick leave, diagnosis] }
    - { category: personal-life, terms: [divorce, dating someone, family problem] }
    - { category: credentials, terms: [password, api key, private key, access token] }
nodes:
  - { id: seeds/ideation/instructions, target: context }
  - { id: seeds/ideation/scoring-rubric, target: scoring-rubric }
---
The `ideation` recipe. A nest made from it has folders for ideas and reviews,
a scoring rubric, an Idea intake board, #weekly-review (when team chat is on),
and two agents worth hiring.
