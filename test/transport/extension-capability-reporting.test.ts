import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const parentSource = readFileSync(
  new URL("../../extension/api/parent.js", import.meta.url),
  "utf8",
);

interface ProbeOptions {
  readonly browserVersion?: string;
  readonly geckoVersion?: string;
  readonly operatingSystem?: string;
  readonly operatingSystemVersion?: string;
  readonly xpcomAbi?: string;
  readonly drawSnapshot?: boolean;
  readonly upload?: boolean;
  readonly streamingFetch?: boolean;
  readonly media?: boolean;
}

function reportedCapabilities(options: ProbeOptions = {}): readonly string[] {
  class Response {}
  class HTMLInputElement {}
  const responsePrototype = Response.prototype;
  const inputPrototype = HTMLInputElement.prototype;

  if (options.streamingFetch !== false) {
    Object.defineProperty(responsePrototype, "body", {
      configurable: true,
      value: null,
    });
  }

  if (options.upload !== false) {
    Object.defineProperty(inputPrototype, "mozSetFileArray", {
      configurable: true,
      value() {},
    });
  }

  const windowGlobal = {
    ...(options.drawSnapshot === false ? {} : { drawSnapshot() {} }),
  };
  const tab = {
    soundPlaying: false,
    linkedBrowser: {
      browsingContext: { currentWindowGlobal: windowGlobal },
    },
  };
  const win = {
    closed: false,
    gZenWorkspaces: {
      getWorkspaces() {
        return [];
      },
      moveTabToWorkspace() {},
      allStoredTabs: [tab],
    },
    gBrowser: {
      addTab() {},
      selectedTab: tab,
      selectedBrowser: {
        goBack() {},
        goForward() {},
      },
      tabs: [tab],
    },
  };
  const resourceProtocol = {
    hasSubstitution() {
      return false;
    },
    QueryInterface() {
      return this;
    },
    setSubstitution() {},
  };
  const hiddenDOMWindow = {
    browsingContext: { currentWindowGlobal: windowGlobal },
    File: {
      createFromFileName() {},
    },
    HTMLInputElement,
    ...(options.streamingFetch === false
      ? {}
      : {
          fetch() {},
          ReadableStream: class {},
        }),
    Response,
    ...(options.media === false
      ? {}
      : {
          HTMLMediaElement: class {},
          TextTrack: class {},
        }),
  };
  const value: unknown = runInNewContext(
    `${parentSource}
registerPageActor({
  extension: {
    manifest: { version: "test" },
    rootURI: "resource://test/"
  }
});
capabilities();`,
    {
      ChromeUtils: {
        importESModule(uri: string) {
          return uri.includes("PrivateBrowsingUtils")
            ? {
                PrivateBrowsingUtils: {
                  isWindowPrivate() {
                    return false;
                  },
                },
              }
            : {
                setTimeout,
                clearTimeout,
              };
        },
        registerWindowActor() {},
      },
      Ci: { nsISubstitutingProtocolHandler: class {} },
      ExtensionAPI: class {},
      Services: {
        appShell: { hiddenDOMWindow },
        appinfo: {
          version: options.browserVersion ?? "1.21.9b",
          platformVersion: options.geckoVersion ?? "153.0",
          OS: options.operatingSystem ?? "Darwin",
          XPCOMABI: options.xpcomAbi ?? "aarch64-gcc3",
        },
        focus: {},
        io: {
          getProtocolHandler() {
            return resourceProtocol;
          },
        },
        sysinfo: {
          getProperty(name: string) {
            if (name === "version") {
              return options.operatingSystemVersion ?? "27.0.0";
            }
            throw new Error(`Unexpected system property ${name}`);
          },
        },
        uuid: {
          generateUUID() {
            return "{00000000-0000-0000-0000-000000000000}";
          },
        },
        wm: {
          getEnumerator() {
            return [win];
          },
        },
      },
      WeakRef,
      clearTimeout,
      setTimeout,
    },
  );

  if (
    !Array.isArray(value) ||
    !value.every((capability) => typeof capability === "string")
  ) {
    throw new Error("The extension capability probe returned invalid data.");
  }

  return value;
}

describe("extension capability reporting", () => {
  it("reports each accepted page capability exactly once", () => {
    const pageCapabilities = reportedCapabilities().filter((capability) =>
      capability.startsWith("browser.pages."),
    );

    expect(new Set(pageCapabilities).size).toBe(pageCapabilities.length);
    expect(
      pageCapabilities.filter(
        (capability) => capability === "browser.pages.resource-fetch",
      ),
    ).toHaveLength(1);
  });

  it("does not advertise page capabilities on an unaccepted build", () => {
    expect(
      reportedCapabilities({ geckoVersion: "154.0" }).filter((capability) =>
        capability.startsWith("browser.pages."),
      ),
    ).toEqual([]);
  });

  it("does not advertise page capabilities outside the headed OS tuple", () => {
    expect(
      reportedCapabilities({ operatingSystemVersion: "26.0.0" }).filter(
        (capability) => capability.startsWith("browser.pages."),
      ),
    ).toEqual([]);
    expect(
      reportedCapabilities({ xpcomAbi: "x86_64-gcc3" }).filter((capability) =>
        capability.startsWith("browser.pages."),
      ),
    ).toEqual([]);
  });

  it("removes only capabilities whose required primitive is absent", () => {
    expect(reportedCapabilities({ upload: false })).not.toContain(
      "browser.pages.upload",
    );
    expect(reportedCapabilities({ drawSnapshot: false })).not.toContain(
      "browser.pages.screenshot",
    );

    const withoutMedia = reportedCapabilities({ media: false });
    expect(withoutMedia).not.toContain("browser.pages.media");
    expect(withoutMedia).toContain("browser.pages.resource-fetch");

    const withoutStreaming = reportedCapabilities({
      streamingFetch: false,
    });
    expect(withoutStreaming).not.toContain("browser.pages.media");
    expect(withoutStreaming).not.toContain("browser.pages.resource-fetch");
    expect(withoutStreaming).toContain("browser.pages.snapshot");
  });
});
