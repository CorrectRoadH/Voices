import interaction from "./e2e.interaction.config";
export default {
  ...interaction,
  tests: "tests/recovery.browser.ts",
  output: ".e2e/recovery",
};
