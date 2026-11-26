import { describe, it, expect } from "vitest";
import { formOf, tuningFromForm } from "./ListenerSettings";

const blank = { name: "", avatar: "", folders: null, max_turns: "", max_items: "", model: "", max_output_tokens: "", temperature: "", timeout_seconds: "" };
const NONE = { name: null, avatar: null, folders: null, max_turns: null, max_items: null };
describe("tuningFromForm", () => {
  it("blank fields are the defaults", () => {
    expect(tuningFromForm(blank)).toEqual({ tuning: { ...NONE, model: null, max_output_tokens: null, temperature: null, timeout_seconds: null } });
  });
  it("typed values are numbers, and 0 temperature is kept", () => {
    expect(tuningFromForm({ ...blank, name: " General ", folders: ["decisions/"], max_turns: "6", max_items: "1", model: " gpt-5 ", max_output_tokens: "4000", temperature: "0", timeout_seconds: "200" })).toEqual({
      tuning: { ...NONE, name: "General", folders: ["decisions/"], max_turns: 6, max_items: 1, model: "gpt-5", max_output_tokens: 4000, temperature: 0, timeout_seconds: 200 },
    });
  });
  it("opens with the values in use, and saving them unchanged keeps every default unset", () => {
    const defaults = { name: "general nest agent a1", avatar: null, folders: null, max_turns: 4, max_items: 3, model: "openai/gpt-5", max_output_tokens: 1500, temperature: 0, timeout_seconds: 120 };
    const unset = { ...NONE, model: null, max_output_tokens: null, temperature: null, timeout_seconds: null };
    const form = formOf(unset, defaults);
    expect(form).toMatchObject({ name: "general nest agent a1", avatar: "", model: "openai/gpt-5", max_output_tokens: "1500", temperature: "0", timeout_seconds: "120", max_turns: "4", max_items: "3" });
    expect(tuningFromForm(form, defaults)).toEqual({ tuning: unset });
    const own = formOf({ ...unset, max_output_tokens: 4000 }, defaults);
    expect(own.max_output_tokens).toBe("4000");
    expect(tuningFromForm(own, defaults)).toEqual({ tuning: { ...unset, max_output_tokens: 4000 } });
  });
  it("out of range or not a number names the field", () => {
    expect(tuningFromForm({ ...blank, max_output_tokens: "9000" })).toEqual({ problem: "Max output tokens must be from 500 to 8000." });
    expect(tuningFromForm({ ...blank, temperature: "warm" })).toEqual({ problem: "Temperature must be from 0 to 1." });
    expect(tuningFromForm({ ...blank, folders: [] })).toEqual({ problem: "Choose at least one folder." });
    expect(tuningFromForm({ ...blank, timeout_seconds: "90.5" })).toHaveProperty("problem");
  });
});
