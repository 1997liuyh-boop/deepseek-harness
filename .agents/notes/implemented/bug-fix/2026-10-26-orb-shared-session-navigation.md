# Agent Note: Shared session navigation for the desktop Orb

Status: implemented

English | [中文](2026-10-26-orb-shared-session-navigation.zh.md)

## Problem

The Orb's workspace-specific history includes old conversations and excludes ordinary main-window conversations. Independent selection prevents users from seeing the turn currently running in the main window.

## Decision

The main client publishes its visible session catalog and selected session. Archived sessions, subagents and unselected blank sessions are excluded; titles and running state come from the same client session summaries. Orb history navigation requests the main client's existing navigation service. Both clients retain the selected session and render its existing event stream; transcript records are not copied.

Desktop IPC carries the catalog and navigation between the main window and Orb shell. Only those windows' main frames can publish or request navigation. The main client validates requested IDs against its visible catalog. The browser channel remains available for environments sharing a storage partition. Desktop startup waits for the shared catalog before submitting, so a loading main window cannot create another Orb conversation.

## Alternatives considered

**Keep a separate Orb history.** This preserves the mismatch and requires users to locate an ordinary conversation again.

**Use only BroadcastChannel.** Chromium partitions the app iframe under the shell's top-level origin separately from the main app, so messages do not reach the desktop iframe despite matching app origins.

**Copy conversation messages.** This introduces another transcript owner and can diverge during streaming, cancellation or tool calls.

## Consequences

The main window owns selection and must remain available. Opening history in the Orb also changes the main selection. Existing conversation models and permissions remain owned by the session. Studio mentions identify enabled plugins and use the existing studio tool; they do not create another project conversation.

Verification covers catalog filtering, title and running state, two-way selection, native sender checks, startup before catalog readiness, shared blank-session reuse, mention completion and disposal. Windows desktop verification exercises real model replies in both directions, partial text while running, and a studio tool call from the Orb. No session persistence format changes.
