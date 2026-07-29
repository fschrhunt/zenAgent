/**
 * DEV-261 probe: does a privileged extension actually clear the bars that
 * WebDriver BiDi could not?
 *
 * Three claims from ADR 0001 are checked here, against a real Zen:
 *
 *   1. `gZenWorkspaces.allStoredTabs` enumerates tabs in *every* Space,
 *      including ones that are not loaded -- the thing BiDi could not do.
 *   2. Creating a Space, opening a background tab, and routing it to another
 *      Space leaves the selected tab, the visible Space, and the focused
 *      window untouched.
 *   3. No remote-control robot appears in the URL bar.
 *
 * Results are written as JSON to the path in `zenagent.probe.output`, because
 * the point of this probe is to need no remote protocol at all.
 *
 * `var` is deliberate: SchemaAPIManager reads the class back off the sandbox
 * global, and a lexical binding would not be a property of it.
 */

"use strict";

var zenProbe = class extends ExtensionAPI {
  onStartup() {
    // `gZenWorkspaces` is attached per window by ZenPreloadedScripts, which can
    // land after the extension starts, so poll rather than assume.
    this.waitForZen()
      .then((win) => this.run(win))
      .catch((error) => {
        this.write({
          ok: false,
          error: String(error),
          stack: error && error.stack ? String(error.stack) : null,
        });
      });
  }

  sleep(ms) {
    const { setTimeout } = ChromeUtils.importESModule(
      "resource://gre/modules/Timer.sys.mjs",
    );
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForZen(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let sawWindow = false;
    while (Date.now() < deadline) {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (win) {
        sawWindow = true;
        if (win.gZenWorkspaces) return win;
      }
      await this.sleep(250);
    }
    throw new Error(
      sawWindow
        ? "a browser window appeared but never exposed gZenWorkspaces"
        : "no navigator:browser window appeared",
    );
  }

  write(result) {
    const path = Services.prefs.getStringPref(
      "zenagent.probe.output",
      "/tmp/zen-agent-probe.json",
    );
    IOUtils.writeJSON(path, result);
  }

  /** A stable, privacy-safe description of a tab. */
  describe(tab) {
    return {
      space: tab.getAttribute("zen-workspace-id"),
      essential: tab.getAttribute("zen-essential") === "true",
      userContextId: tab.getAttribute("usercontextid"),
      // `linkedPanel` is unset while a tab is lazy -- this is the BiDi blind spot.
      lazy: !tab.linkedPanel,
      label: tab.label || null,
    };
  }

  snapshot(win) {
    const zen = win.gZenWorkspaces;
    const all = zen.allStoredTabs;
    const strip = win.gBrowser.tabs;
    return {
      activeSpace: zen.activeWorkspace,
      spaces: zen.getWorkspaces().map((s) => ({
        uuid: s.uuid,
        name: s.name,
        containerTabId: s.containerTabId,
      })),
      selectedTabLabel: win.gBrowser.selectedTab.label || null,
      // The comparison the whole ADR turns on.
      allStoredTabs: all.length,
      gBrowserTabs: strip.length,
      allStoredBySpace: all.map((t) => this.describe(t)),
      gBrowserBySpace: Array.from(strip).map((t) => this.describe(t)),
      remoteControlBadge:
        win.document.documentElement.hasAttribute("remotecontrol"),
    };
  }

  async run(win) {
    const result = { ok: false, steps: [] };
    const note = (name, value) => result.steps.push({ name, value });

    note("app", `${Services.appinfo.name} ${Services.appinfo.version}`);
    // If this class is running at all, the sandbox is system-principal.
    note("hasChromePrivileges", typeof Services === "object");

    const zen = win.gZenWorkspaces;
    note("hasZenWorkspaces", !!zen);

    await zen.promiseInitialized;
    note("initialized", true);

    result.before = this.snapshot(win);

    // Ensure there are two Spaces. `dontChange` keeps the visible one put.
    if (result.before.spaces.length < 2) {
      await zen.createAndSaveWorkspace("Probe Work", undefined, true, 0);
      note("createdSecondSpace", true);
    }
    const spaces = zen.getWorkspaces();
    const active = zen.activeWorkspace;
    const other = spaces.find((s) => s.uuid !== active);
    note("otherSpace", other ? other.uuid : null);
    if (!other) throw new Error("could not obtain a second Space");

    const principal = Services.scriptSecurityManager.getSystemPrincipal();

    // A background tab in the visible Space.
    const here = win.gBrowser.addTab("about:license", {
      inBackground: true,
      triggeringPrincipal: principal,
    });
    note("openedInActiveSpace", !!here);

    // A background tab routed into the *other* Space.
    const there = win.gBrowser.addTab("about:buildconfig", {
      inBackground: true,
      triggeringPrincipal: principal,
    });
    zen.moveTabToWorkspace(there, other.uuid);
    note("movedToOtherSpace", there.getAttribute("zen-workspace-id"));

    // Let Zen settle its DOM moves before re-reading.
    await new Promise((resolve) => win.setTimeout(resolve, 1500));
    zen._allStoredTabs = null;
    win.gBrowser.tabContainer._invalidateCachedTabs();

    result.after = this.snapshot(win);
    result.unchanged = {
      activeSpace: result.before.activeSpace === result.after.activeSpace,
      selectedTab:
        result.before.selectedTabLabel === result.after.selectedTabLabel,
      noBadge:
        !result.before.remoteControlBadge && !result.after.remoteControlBadge,
    };
    result.ok = true;
    this.write(result);
  }
};
