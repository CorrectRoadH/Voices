import interaction from "./e2e.interaction.config";
export default {
  ...interaction,
  tests: "tests/openai-stt.browser.ts",
  output: ".e2e/openai-stt",
};
