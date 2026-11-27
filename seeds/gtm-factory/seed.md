---
id: gtm-factory
version: 1
title: GTM factory
description: Run go-to-market as a learning loop. Research becomes evidence, evidence becomes hypotheses, hypotheses become small pre-registered experiments, and the plays that win twice become standard work.
recipe:
  name: GTM factory
  purpose: Run go-to-market as a loop of evidence, small pre-registered experiments and plays that work.
  order: 20
layers: [framework, thesis]
folders:
  - { path: evidence/, purpose: evidence }
  - { path: hypotheses/, purpose: hypotheses }
  - { path: experiments/, purpose: experiments }
  - { path: learnings/, purpose: learnings }
  - { path: playbooks/, purpose: playbooks }
  - { path: decisions/, purpose: decisions }
  - { path: agents/, purpose: agents, admin_only: true }
tags:
  - { tag: evidence, meaning: "A dated observation with its source and how strong it is." }
  - { tag: hypothesis, meaning: "A claim about what moves the funnel, and why." }
  - { tag: experiment, meaning: "A test of one hypothesis, written down before it starts." }
  - { tag: learning, meaning: "What an experiment showed: won, lost or inconclusive." }
  - { tag: playbook, meaning: "A play that won twice, written as standard work." }
definitions:
  - term: funnel stage
    definition: One step a buyer takes, from first exposure to a paid pilot. Each experiment names the stage it moves.
  - term: pre-registration
    definition: Writing the hypothesis, metric, baseline, duration and decision rule before an experiment starts, so the goal cannot move mid-flight.
  - term: decision rule
    definition: The thresholds, set in advance, at which an experiment is killed, iterated or scaled.
  - term: defect
    definition: A unit of work that breaks the loop's rules, such as an experiment launched without a kill threshold or a post shipped without tracking.
thesis: seeds/gtm-factory/thesis
distill: seeds/gtm-factory/distill
boards:
  - name: Experiments
    stages: [idea, pre-registered, live, reading, verdict, playbook]
    task_stages: true
channels:
  - name: experiments
    purpose: "One thread per experiment: the plan, the readout and the verdict."
  - name: signals
    purpose: "Customer quotes, competitor moves and anything else worth keeping as evidence."
hire:
  - kind: key
    handle: researcher
    why: "Your own agent with a key of its own. It turns signals into evidence documents and drafts hypotheses for a person to approve."
  - kind: watcher
    handle: experiments-watcher
    channels: [experiments]
    why: "Reads #experiments and points out verdicts and decisions that were agreed but not recorded."
  - kind: hootie
    handle: hootie
    why: "Answers questions about past experiments and evidence from the nest, with citations."
listener:
  propose_folders: [evidence/, hypotheses/, learnings/, decisions/]
  domain_tags: [evidence, hypothesis, learning]
  never_propose:
    - { category: compensation, terms: [salary, wage, payroll, my equity, equity grant, stock option] }
    - { category: health, terms: [medical, illness, sick leave, diagnosis] }
    - { category: performance-review, terms: [underperforming, disciplinary, improvement plan] }
    - { category: personal-life, terms: [divorce, dating someone, family problem] }
    - { category: credentials, terms: [password, api key, private key, access token] }
nodes:
  - { id: seeds/gtm-factory/instructions, target: context }
  - { id: seeds/gtm-factory/playbooks/experiment-rules, target: playbooks/experiment-rules }
  - { id: seeds/gtm-factory/playbooks/hypothesis-template, target: playbooks/hypothesis-template }
  - { id: seeds/gtm-factory/playbooks/defects-we-count, target: playbooks/defects-we-count }
---
The `gtm-factory` recipe. A nest made from it has folders for evidence,
hypotheses, experiments, learnings and playbooks, the experiment rules, an
Experiments board, #experiments and #signals (when team chat is on), and three
agents worth hiring.
