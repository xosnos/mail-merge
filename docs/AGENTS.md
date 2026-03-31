<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-26 | Updated: 2026-03-26 -->

# docs

## Purpose
Project documentation covering product requirements, technical roadmap, deployment procedures, and feature comparisons. These documents provide context for design decisions and implementation priorities.

## Key Files

| File | Description |
|------|-------------|
| `ARCHITECTURE.md` | Technical overview of the decoupled Apps Script deployments, state management, and MIME engine |
| `UX_DESIGN.md` | User journey, constraints of CardService, and interface logic |
| `PRD.md` | Product Requirements Document — objectives, user personas, functional requirements, technical architecture |
| `ROADMAP.md` | Technical roadmap across 6 phases from project setup through UI polish |
| `DEPLOYMENT.md` | Step-by-step deployment guide — GCP setup, OAuth consent, CLASP config, Marketplace publishing |
| `CENTRAL_TRACKING_SETUP.md` | Setup guide for the centralized open tracking pixel system (service account, domain-wide delegation) |
| `YAMM_FEATURE_COMPARISON.md` | Feature comparison matrix with Yet Another Mail Merge (YAMM) |

## For AI Agents

### Working In This Directory
- These are reference documents — read them for context on design decisions and feature scope
- `PRD.md` is the source of truth for feature requirements and user workflows
- `ROADMAP.md` tracks implementation phases — check current phase before proposing new work
- `DEPLOYMENT.md` is user-facing — keep instructions precise and tested
- Update docs when implementing features that change documented behavior

### Testing Requirements
- Verify Markdown renders correctly (links, tables, code blocks)
- Ensure deployment steps in `DEPLOYMENT.md` remain accurate after infrastructure changes

### Common Patterns
- Documents use standard Markdown with tables and code blocks
- Cross-references between docs use relative links

## Dependencies

### Internal
- References `src/` file structure and function names
- References `central-tracker/` deployment for tracking setup

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
