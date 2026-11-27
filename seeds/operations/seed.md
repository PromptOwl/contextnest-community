---
id: operations
version: 1
title: Operations
description: Map how work really flows. Processes, handoffs, owners and tools, then the bottlenecks and what to automate first, every claim tied to its source.
recipe:
  name: Operations
  purpose: Map processes, handoffs and owners, then find the bottlenecks and what to automate first.
  order: 30
layers: [framework, thesis]
folders:
  - { path: processes/, purpose: processes }
  - { path: handoffs/, purpose: handoffs }
  - { path: systems/, purpose: systems }
  - { path: bottlenecks/, purpose: bottlenecks }
  - { path: automation/, purpose: automation }
  - { path: decisions/, purpose: decisions }
  - { path: method/, purpose: method }
  - { path: agents/, purpose: agents, admin_only: true }
tags:
  - { tag: process, meaning: "A recurring process: its trigger, steps and owner." }
  - { tag: handoff, meaning: "Where work passes between teams or systems." }
  - { tag: bottleneck, meaning: "Where work waits, with how bad it is and the evidence." }
  - { tag: automation, meaning: "Something worth automating, ranked by impact and effort." }
  - { tag: sop-gap, meaning: "A process people rely on that nobody has written down." }
definitions:
  - term: process
    definition: A recurring sequence of steps with a trigger, an owner and an end state, such as order to cash or onboarding a new hire.
  - term: handoff
    definition: The point where work passes from one team or system to another. Most delays live here.
  - term: RACI
    definition: Who is Responsible, Accountable, Consulted and Informed for a process step.
  - term: grounding
    definition: How a claim is known. Read (in a document or tool), documented (a person says so) or inferred (reasoned from names and titles).
thesis: seeds/operations/thesis
distill: seeds/operations/distill
boards:
  - name: Improvements
    stages: [spotted, analysed, approved, in-progress, done]
    task_stages: true
channels:
  - name: ops
    purpose: "Day-to-day operations: questions, changes to a process, who owns what."
  - name: incidents
    purpose: "Something broke or stalled. One thread per incident, ending with the cause and the fix."
hire:
  - kind: watcher
    handle: ops-watcher
    channels: [ops]
    why: "Reads #ops and points out process changes and owners that were agreed but not written down."
  - kind: key
    handle: ops-analyst
    why: "Your own agent with a key of its own. It maps processes from the documents you give it and drafts bottlenecks for review."
  - kind: hootie
    handle: hootie
    why: "Answers who owns what and how a process works, from the nest, with citations."
listener:
  propose_folders: [processes/, handoffs/, bottlenecks/, decisions/]
  domain_tags: [process, handoff, bottleneck]
  never_propose:
    - { category: compensation, terms: [salary, wage, payroll, my equity, equity grant, stock option] }
    - { category: health, terms: [medical, illness, sick leave, diagnosis] }
    - { category: performance-review, terms: [underperforming, disciplinary, improvement plan] }
    - { category: personal-life, terms: [divorce, dating someone, family problem] }
    - { category: credentials, terms: [password, api key, private key, access token] }
nodes:
  - { id: seeds/operations/instructions, target: context }
  - { id: seeds/operations/method/how-to-map-operations, target: method/how-to-map-operations }
  - { id: seeds/operations/method/source-and-privacy-rules, target: method/source-and-privacy-rules }
---
The `operations` recipe. A nest made from it has folders for processes,
handoffs, systems, bottlenecks and automation, the mapping method and its
source rules, an Improvements board, #ops and #incidents (when team chat is
on), and three agents worth hiring.
