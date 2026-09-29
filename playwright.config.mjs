import { defineConfig } from "@playwright/test";

const webServer =
  process.env
    .BIZNORYX_SKIP_PLAYWRIGHT_WEBSERVER
    ? undefined
    : {
        command:
          "node scripts/app-server.mjs",

        url:
          "http://127.0.0.1:4186",

        env: {
          PORT:
            "4186",
        },

        reuseExistingServer:
          true,
      };

export default defineConfig({
  testDir: "./tests/browser",

  timeout: 45_000,

  workers: 1,

  use: {
    baseURL: "http://127.0.0.1:4186",

    browserName: "chromium",

    screenshot: "only-on-failure",

    trace: "retain-on-failure",
  },

  webServer,
});
