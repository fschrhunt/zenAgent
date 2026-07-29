import { describe, expect, it, vi } from "vitest";

import type { ZenAgentConfig } from "../../src/config/schema.js";
import {
  runSetupWizard,
  type SetupWizardServices,
} from "../../src/cli/wizard.js";
import type { WizardOption, WizardUi } from "../../src/cli/wizard-ui.js";
import { browserFixture } from "../browser/fixtures.js";

interface FakeUi extends WizardUi {
  readonly events: string[];
}

function fakeUi(selections: readonly (string | undefined)[]): FakeUi {
  const pending = [...selections];
  const events: string[] = [];
  return {
    events,
    header: (version) => events.push(`header:${version}`),
    select: <T extends string>(
      message: string,
      options: readonly WizardOption<T>[],
      initialValue?: T,
    ): Promise<T | undefined> => {
      void options;
      void initialValue;
      events.push(`select:${message}`);
      return Promise.resolve(pending.shift() as T | undefined);
    },
    info: (message) => events.push(`info:${message}`),
    success: (message) => events.push(`success:${message}`),
    warning: (message) => events.push(`warning:${message}`),
    error: (message) => events.push(`error:${message}`),
    note: (title, lines) => events.push(`note:${title}:${lines.join("|")}`),
    finish: (message) => events.push(`finish:${message}`),
  };
}

function services(
  overrides: Partial<SetupWizardServices> = {},
): SetupWizardServices {
  return {
    inspectNativeHost: () => ({
      status: "missing",
      manifestPath: "/tmp/manifest.json",
      launcherPath: "/tmp/zen-agent-host",
    }),
    installNativeHost: () => ({
      manifestPath: "/tmp/manifest.json",
      launcherPath: "/tmp/zen-agent-host",
      hostModulePath: "/tmp/native-host.js",
    }),
    uninstallNativeHost: () => ({
      manifestPath: "/tmp/manifest.json",
      launcherPath: "/tmp/zen-agent-host",
      removed: true,
    }),
    status: () =>
      Promise.resolve({
        state: "connected",
        profileId: "test-profile",
        spaces: 2,
        tabs: 3,
      }),
    spaces: () => Promise.resolve([]),
    readConfig: () => Promise.resolve(undefined),
    mapSpaces: () =>
      Promise.resolve({
        path: "/tmp/config.json",
        profile: "test-profile",
      }),
    ...overrides,
  };
}

describe("setup wizard", () => {
  it("guides native-host setup and Space mapping with selections", async () => {
    const personal = browserFixture("personal");
    const work = browserFixture("work", 1, personal.profile.id.transportId);
    const installNativeHost = vi.fn(() => ({
      manifestPath: "/tmp/manifest.json",
      launcherPath: "/tmp/zen-agent-host",
      hostModulePath: "/tmp/native-host.js",
    }));
    const mapSpaces = vi.fn(() =>
      Promise.resolve({
        path: "/tmp/config.json",
        profile: personal.profile.id.transportId,
      }),
    );
    const ui = fakeUi([
      "quick-setup",
      "configure",
      "space:0",
      "space:1",
      "exit",
    ]);

    await runSetupWizard({
      version: "1.2.3",
      extensionManifestPath: "/opt/zen-agent/extension/manifest.json",
      services: services({
        installNativeHost,
        spaces: () =>
          Promise.resolve([
            { id: personal.space.id, name: "Personal" },
            { id: work.space.id, name: "Work" },
          ]),
        mapSpaces,
      }),
      ui,
    });

    expect(installNativeHost).toHaveBeenCalledOnce();
    expect(mapSpaces).toHaveBeenCalledWith({
      personal: personal.space.id,
      work: work.space.id,
    });
    expect(ui.events).toContain("header:1.2.3");
    expect(ui.events).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "note:Finish setup in the intended Zen profile",
        ),
        expect.stringContaining(
          "Temporary extension manifest: /opt/zen-agent/extension/manifest.json",
        ),
        "finish:Setup closed.",
      ]),
    );
  });

  it("fails closed when the native-host targets are not owned", async () => {
    const installNativeHost = vi.fn();
    const ui = fakeUi(["quick-setup", "exit"]);

    await runSetupWizard({
      version: "1.2.3",
      extensionManifestPath: "/opt/zen-agent/extension/manifest.json",
      services: services({
        inspectNativeHost: () => ({
          status: "invalid",
          manifestPath: "/tmp/manifest.json",
          launcherPath: "/tmp/zen-agent-host",
        }),
        installNativeHost,
      }),
      ui,
    });

    expect(installNativeHost).not.toHaveBeenCalled();
    expect(ui.events).toEqual(
      expect.arrayContaining([
        expect.stringContaining("error:The native-host installation"),
        expect.stringContaining("note:Nothing was changed"),
      ]),
    );
  });

  it("preserves existing mappings when both mapping prompts are skipped", async () => {
    const fixture = browserFixture();
    const mapSpaces = vi.fn();
    const config = {
      version: 1,
      profile: fixture.profile.id.transportId,
      spaces: {
        personal: fixture.space.id.transportId,
        aliases: {},
      },
      routing: { rules: [] },
    } satisfies ZenAgentConfig;
    const ui = fakeUi(["configure-spaces", "skip", "skip", "exit"]);

    await runSetupWizard({
      version: "1.2.3",
      extensionManifestPath: "/opt/zen-agent/extension/manifest.json",
      services: services({
        spaces: () =>
          Promise.resolve([{ id: fixture.space.id, name: "Personal" }]),
        readConfig: () => Promise.resolve(config),
        mapSpaces,
      }),
      ui,
    });

    expect(mapSpaces).not.toHaveBeenCalled();
    expect(ui.events).toContain("warning:No Space mappings were changed.");
  });

  it("treats Escape as a clean exit", async () => {
    const ui = fakeUi([undefined]);

    await runSetupWizard({
      version: "1.2.3",
      extensionManifestPath: "/opt/zen-agent/extension/manifest.json",
      services: services(),
      ui,
    });

    expect(ui.events.at(-1)).toBe("finish:Setup closed.");
  });
});
