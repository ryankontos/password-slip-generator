const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8775", viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: ".venv/bin/python tests/serve_studio_fixture.py",
    url: "http://127.0.0.1:8775",
    reuseExistingServer: false,
  },
});
