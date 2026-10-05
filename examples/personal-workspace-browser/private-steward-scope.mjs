import {resolve} from "node:path";
import {outputDir} from "./fixture.mjs";
import {openWorkspacePage} from "./scenario-context.mjs";

export const privateStewardScopeScenario = {
  id: "private-steward-scope",
  async run({browser, collectCoverage, url}) {
    const writes = [];
    const row = {binding_id: "synthetic-steward", app_ref: "mew", context_kind: "steward",
      project_ref: "synthetic-workspace", project_title: "Personal workspace", context_available: true,
      executor_endpoint_id: "codex", grant: "portfolio_read", goal_count: 1, goal_scope: "selected",
      listener_status: "listening", pending_count: 0, recovery_count: 0};
    const context = await openWorkspacePage(browser, url, {collectCoverage,
      beforeGoto: async (_api, page) => {
        await page.route("**/api/chat/projects", route => route.fulfill({json: {ok: true,
          projects: [{project_ref: row.project_ref, title: row.project_title, grant: "workspace_write"}]}}));
        await page.route("**/api/chat/lark/private-conversations", async route => {
          if (route.request().method() === "POST") {
            const body = route.request().postDataJSON();
            if (body.app_ref !== row.app_ref || body.project_ref !== row.project_ref
                || body.context_kind !== "steward" || body.goal_scope !== "all_registered") {
              throw new Error("Scope upgrade did not retain its target and select all registered work");
            }
            writes.push(body);
            Object.assign(row, {goal_scope: "all_registered", goal_count: 150});
          }
          await route.fulfill({json: {ok: true, revision: writes.length + 1, connections: [row]}});
        });
      },
    });
    const {page} = context;
    try {
      async function settings() {
        await page.getByRole("button", {name: "设置", exact: true}).click();
        await page.locator(".personal-settings-tabs").getByRole("button", {name: "Lark", exact: true}).click();
      }
      await settings();
      const panel = page.getByRole("region", {name: "本人飞书私聊"});
      await panel.getByText("LoopX 管家 · 已选范围 · 1 个 Goal", {exact: true}).waitFor();
      const upgrade = panel.getByRole("button", {name: "授权全部已注册工作", exact: true});
      await upgrade.scrollIntoViewIfNeeded();
      await page.screenshot({path: resolve(outputDir, "private-steward-scope-before.png"), animations: "disabled"});
      await upgrade.focus();
      await page.keyboard.press("Enter");
      await panel.getByText("LoopX 管家 · 全部已注册工作 · 150 个 Goal", {exact: true}).waitFor();
      if (writes.length !== 1 || await upgrade.count()) throw new Error("Upgrade must read back once without another form");
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({path: resolve(outputDir, "private-steward-scope-after.png"), animations: "disabled"});
      await page.reload();
      await page.getByTestId("personal-goal-home").waitFor();
      await settings();
      await panel.getByText("LoopX 管家 · 全部已注册工作 · 150 个 Goal", {exact: true}).waitFor();
      await page.setViewportSize({width: 390, height: 844});
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({path: resolve(outputDir, "private-steward-scope-mobile.png"), animations: "disabled"});
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Scope readback overflows");
      if (context.errors.length) throw new Error(context.errors.join(" | "));
      return {coverageEntries: await context.close(), note: "Existing selected steward upgrades in place with one keyboard action and survives reload; desktop/mobile, synthetic API paired with native backend scope regressions"};
    } catch (error) {await context.close(); throw error;}
  },
};
