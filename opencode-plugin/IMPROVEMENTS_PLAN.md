# Opencode Plugin - Implementation Plan for Improvements

## Overview

This document outlines the areas of improvement identified in the Tracybot opencode plugin and provides a phased implementation plan to address them.

---

## Identified Areas of Improvement

### Code Quality & Type Safety
1. Excessive use of `any` types - `event: any`, `input: any` lack proper typing from the SDK
2. Magic strings - `"build"`, `"plan"`, `"user"`, `"assistant"` should be constants
3. Missing return types - Functions like `getRepoRoot()`, `saveTasklet()`, `createTasklet()` lack explicit return types

### Architecture & State
4. Mutable module-level state - `messages`, `currentSessionId`, `taskletCounter` can cause issues with hot-reload
5. Incomplete session cleanup - `messages.clear()` in `session.created` but no handler for `session.ended`
6. No tasklet querying - No API to retrieve or list saved tasklets

### Robustness
7. No path validation - File paths aren't validated to be within repo bounds before git operations
8. Unprofessional error messages - "skill issue" error messages (lines 205, 240, 255, 281)
9. Git not installed handling - `getRepoRoot()` doesn't check if git CLI exists
10. Silent failures - `createTasklet` returns early without logging if `buildUserMsg` not found

### Performance
11. File I/O inefficiency - `saveTasklet` reads/writes entire JSON file on every save (O(n) writes)
12. Synchronous file operations - Using `fs.writeFileSync` in an async plugin context

### Security
13. Unsanitized paths - No validation that commit paths are within the repository
14. Commit message injection - Path directly interpolated into commit message without escaping

---

## Implementation Plan

### Phase 1: Type Safety & Constants (High Priority)

#### 1.1 Define Typed Event Handlers
```
src/types.ts - Create proper type definitions
  - EventType union: "session.created" | "message.part.updated" | "message.updated"
  - MessagePartEvent interface
  - MessageUpdatedEvent interface
  - Replace `any` with proper types in event handler
```

#### 1.2 Extract Magic Strings to Constants
```
src/constants.ts
  - AGENTS: { PLAN: "plan", BUILD: "build" }
  - ROLES: { USER: "user", ASSISTANT: "assistant" }
  - EDIT_TOOLS: ["edit", "write"]
  - FINISH_REASONS: { STOP: "stop", ... }
```

#### 1.3 Add Explicit Return Types
- `getRepoRoot(): Promise<string | null>`
- `saveTasklet(tasklet: Tasklet): void`
- `createTasklet(...): void`

---

### Phase 2: State Management Refactoring (High Priority)

#### 2.1 Create PluginState Class
```
src/state.ts - encapsulate all mutable state
  - messages: Map<string, MessageState>
  - currentSessionId: string
  - taskletCounter: number
  - Methods: clear(), setMessage(), getMessages(), etc.
```

#### 2.2 Add Session Lifecycle Handlers
- Handle `session.created` (already exists)
- Handle `session.ended` - cleanup state, persist any pending tasklets

#### 2.3 Add Tasklet Retrieval API
- Export function to query stored tasklets
- Return filtered list by sessionId, date range

---

### Phase 3: Error Handling (Medium Priority)

#### 3.1 Professional Error Messages
Replace "skill issue" with descriptive messages:
- "Missing file path in before hook" → "Failed to extract file path from tool arguments"
- Log structured error data for debugging

#### 3.2 Git CLI Availability Check
```
getRepoRoot() - check if git is installed first
  - Try `git --version` before relying on git commands
  - Clear error message if git unavailable
```

#### 3.3 Graceful Handling of Missing Data
```
createTasklet() - when buildUserMsg not found:
  - Log warning instead of silent return
  - Consider partial tasklet creation
```

---

### Phase 4: File I/O Optimization (Medium Priority)

#### 4.1 Switch to Bun.file() for Async Operations
Replace `fs.writeFileSync` with Bun's file API for better async handling.

#### 4.2 Consider Append-Only Log
Instead of reading/writing entire JSON:
- Append new tasklets to a line-delimited JSON (JSONL) file
- Or use SQLite via `bun:sqlite` for indexed queries

---

### Phase 5: Security Improvements (Medium Priority)

#### 5.1 Path Validation
```
validatePath(path: string, repoRoot: string): boolean
  - Resolve to absolute path
  - Ensure path is within repoRoot (prevent directory traversal)
```

#### 5.2 Sanitize Commit Messages
- Escape/validate path in commit messages
- Use `--allow-empty` or validate before commit

---

## Suggested Implementation Order

| Priority | Task | Est. Effort |
|----------|------|-------------|
| 1 | Types & Constants | 1-2 hrs |
| 2 | State Management | 2-3 hrs |
| 3 | Error Handling | 1 hr |
| 4 | File I/O | 1-2 hrs |
| 5 | Security | 1 hr |

**Total: ~6-9 hours**

---

## Current Code Issues Reference

Located in: `/home/danism/Dokument/school/SEM/bachelorsProj/tracybot/opencode-plugin/src/index.ts`

| Line | Issue |
|------|-------|
| 135 | `event: any` - missing type |
| 205 | "skill issue" - unprofessional |
| 240 | "skill issue" - unprofessional |
| 255 | "skill issue" - unprofessional |
| 281 | "skill issue" - unprofessional |
| 53-55 | Module-level mutable state |
| 57-79 | Synchronous file I/O with fs.writeFileSync |
| 105 | Silent return without logging |
| 199, 249 | No path validation before git operations |
| 265 | Path interpolated directly into commit message |

---

Generated: April 2026
Project: Tracybot Opencode Plugin