import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestions } from "./history/normalizeQuestions";

describe("normalizeQuestions", () => {
  test("a well-formed question comes back unchanged", () => {
    const q = {
      question: "Which style?",
      header: "Style",
      options: [{ label: "A", description: "first" }, { label: "B", description: "second" }],
      answer: ["B"],
      outputId: "plan_1",
    };
    assert.deepEqual(normalizeQuestions([q]), [q]);
  });

  test("an answer written as a plain string (early plugin versions) becomes a one-item array", () => {
    const [q] = normalizeQuestions([{ question: "What?", header: "h", options: [], answer: "Bug fix", outputId: "plan_0" }]);
    assert.deepEqual(q.answer, ["Bug fix"]);
  });

  test("a missing answer becomes an empty array, and non-string items are stringified", () => {
    assert.deepEqual(normalizeQuestions([{ question: "q", outputId: "o" }])[0].answer, []);
    assert.deepEqual(normalizeQuestions([{ question: "q", answer: null, outputId: "o" }])[0].answer, []);
    assert.deepEqual(normalizeQuestions([{ question: "q", answer: [1, "x"], outputId: "o" }])[0].answer, ["1", "x"]);
  });

  test("missing fields get safe defaults so later readers never crash", () => {
    assert.deepEqual(normalizeQuestions([{}]), [{ question: "", header: "", options: [], answer: [], outputId: "" }]);
  });

  test("malformed options are dropped or defaulted", () => {
    const [q] = normalizeQuestions([{ question: "q", options: [{ label: "A" }, null, "oops", { description: "d" }], answer: [], outputId: "o" }]);
    assert.deepEqual(q.options, [{ label: "A", description: "" }, { label: "", description: "d" }]);
  });

  test("entries that aren't objects are skipped, and a non-array input gives an empty list", () => {
    assert.deepEqual(normalizeQuestions([null, "x", 3, { question: "kept", outputId: "o" }]).map(q => q.question), ["kept"]);
    assert.deepEqual(normalizeQuestions(undefined), []);
    assert.deepEqual(normalizeQuestions("nope"), []);
    assert.deepEqual(normalizeQuestions({ question: "x" }), []);
  });
});
