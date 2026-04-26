import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProjectSchema,
  listProjectsSchema,
  getProjectSchema,
  projectBriefSchema,
  setActiveProjectSchema,
  updateProjectStatusSchema,
  linkToProjectSchema,
} from "../tools/projects.js";

// ---------------------------------------------------------------------------
// projects tool-schema contract
//
// Projects scope writes to a per-role L1 brain (Bedrock-aware recall via
// migration 060). The slug pattern mirrors the DB CHECK in migration 045 —
// drift here means orphan rows that recall queries silently miss.
// ---------------------------------------------------------------------------

const VALID_SLUG = "research-lighting";
const VALID_UUID = "11111111-2222-3333-4444-555555555555";

test("createProjectSchema requires slug and name", () => {
  assert.ok(createProjectSchema.safeParse({ slug: VALID_SLUG, name: "Research" }).success);
  assert.ok(!createProjectSchema.safeParse({ slug: VALID_SLUG }).success);
  assert.ok(!createProjectSchema.safeParse({ name: "Research" }).success);
});

test("createProjectSchema slug pattern is lowercase kebab-case, 2–64 chars", () => {
  // Mirror of the DB CHECK in migration 045 + the regex in slugSchema.
  const ok = ["x1", "ai", "research-lighting", "ai-2026", "abc-def-ghi"];
  const bad = [
    "",
    "a",                  // 1 char (must be ≥ 2)
    "Research",           // uppercase
    "with_underscore",
    "with space",
    "ÄÖÜ",
    "-leading",
    "trailing-",
    "a".repeat(65),       // > 64 chars
  ];
  for (const s of ok) {
    assert.ok(createProjectSchema.safeParse({ slug: s, name: "n" }).success, `'${s}' should pass`);
  }
  for (const s of bad) {
    assert.ok(!createProjectSchema.safeParse({ slug: s, name: "n" }).success, `'${s}' should fail`);
  }
});

test("listProjectsSchema.status enum covers the 4 lifecycle values + omission", () => {
  const ok = ["active", "paused", "completed", "archived"];
  for (const s of ok) {
    assert.ok(listProjectsSchema.safeParse({ status: s }).success);
  }
  assert.ok(listProjectsSchema.safeParse({}).success, "omitting status must list all");
  assert.ok(!listProjectsSchema.safeParse({ status: "draft" }).success);
});

test("setActiveProjectSchema requires a valid slug; agent defaults to 'main'", () => {
  const parsed = setActiveProjectSchema.parse({ slug: VALID_SLUG });
  assert.equal(parsed.agent, "main");
  assert.ok(setActiveProjectSchema.safeParse({ slug: VALID_SLUG, agent: "lab01" }).success);
  assert.ok(!setActiveProjectSchema.safeParse({ slug: "Bad Slug" }).success);
  assert.ok(!setActiveProjectSchema.safeParse({}).success);
});

test("updateProjectStatusSchema enforces the 4-state machine", () => {
  for (const s of ["active", "paused", "completed", "archived"]) {
    assert.ok(updateProjectStatusSchema.safeParse({ slug: VALID_SLUG, status: s }).success);
  }
  assert.ok(!updateProjectStatusSchema.safeParse({ slug: VALID_SLUG, status: "draft" }).success);
});

test("linkToProjectSchema requires (table, row_id) and accepts slug=null to detach", () => {
  for (const t of ["memories", "experiences", "intentions", "lessons"]) {
    assert.ok(
      linkToProjectSchema.safeParse({ table: t, row_id: VALID_UUID, slug: VALID_SLUG }).success
    );
    assert.ok(
      linkToProjectSchema.safeParse({ table: t, row_id: VALID_UUID, slug: null }).success,
      `slug=null detach should work for ${t}`
    );
  }
  assert.ok(
    !linkToProjectSchema.safeParse({ table: "agents", row_id: VALID_UUID, slug: VALID_SLUG }).success,
    "non-scoped table must be rejected"
  );
});

test("projectBriefSchema and getProjectSchema require a valid slug", () => {
  assert.ok(getProjectSchema.safeParse({ slug: VALID_SLUG }).success);
  assert.ok(projectBriefSchema.safeParse({ slug: VALID_SLUG }).success);
  assert.ok(!getProjectSchema.safeParse({ slug: "" }).success);
  assert.ok(!projectBriefSchema.safeParse({ slug: "Has Spaces" }).success);
});
