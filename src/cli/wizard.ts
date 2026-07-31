import type { BrowserSpaceId } from "../browser/model.js";
import type { ZenAgentConfig } from "../config/schema.js";
import type {
  NativeHostInstallation,
  NativeHostInstallResult,
  NativeHostUninstallResult,
} from "../native/install.js";
import type { WizardOption, WizardUi } from "./wizard-ui.js";

export interface WizardStatus {
  readonly state: string;
  readonly profileId: string | null;
  readonly spaces: number;
  readonly tabs: number;
}

export interface WizardSpace {
  readonly id: BrowserSpaceId;
  readonly name: string;
}

export interface WizardMappingSelection {
  readonly personal?: BrowserSpaceId;
  readonly work?: BrowserSpaceId;
}

export interface WizardMappingResult {
  readonly path: string;
  readonly profile: string;
}

export interface SetupWizardServices {
  readonly inspectNativeHost: () => NativeHostInstallation;
  readonly installNativeHost: () => NativeHostInstallResult;
  readonly uninstallNativeHost: () => NativeHostUninstallResult;
  readonly status: () => Promise<WizardStatus>;
  readonly spaces: () => Promise<readonly WizardSpace[]>;
  readonly readConfig: () => Promise<ZenAgentConfig | undefined>;
  readonly mapSpaces: (
    selection: WizardMappingSelection,
  ) => Promise<WizardMappingResult>;
  readonly speechLocales?: () => Promise<
    Readonly<{
      supportedLocales: readonly string[];
      installedLocales: readonly string[];
    }>
  >;
  readonly installSpeechLocale?: (
    locale: string,
  ) => Promise<Readonly<{ locale: string }>>;
}

export interface SetupWizardOptions {
  readonly version: string;
  readonly extensionManifestPath: string;
  readonly services: SetupWizardServices;
  readonly ui: WizardUi;
}

type WizardAction =
  | "quick-setup"
  | "configure-spaces"
  | "check-status"
  | "install-speech"
  | "repair-host"
  | "uninstall-host"
  | "exit";

const MAIN_ACTIONS: readonly WizardOption<WizardAction>[] = [
  {
    value: "quick-setup",
    label: "Set up this Mac",
    hint: "host, Zen requirements, and Spaces",
  },
  {
    value: "configure-spaces",
    label: "Configure Spaces",
    hint: "map Personal and Work",
  },
  {
    value: "check-status",
    label: "Check connection",
    hint: "sanitized diagnostics",
  },
  {
    value: "install-speech",
    label: "Install speech model",
    hint: "explicit on-device locale download",
  },
  {
    value: "repair-host",
    label: "Repair native host",
    hint: "refresh installed paths",
  },
  {
    value: "uninstall-host",
    label: "Remove native host",
    hint: "preserves browser and configuration",
  },
  { value: "exit", label: "Exit" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown setup failure.";
}

async function showStatus(
  services: SetupWizardServices,
  ui: WizardUi,
): Promise<boolean> {
  try {
    const status = await services.status();
    ui.success(
      `Daemon ${status.state} · ${String(status.spaces)} Spaces · ${String(status.tabs)} tabs`,
    );
    ui.info(`Profile: ${status.profileId ?? "not reported"}`);
    return status.state === "connected";
  } catch (error) {
    ui.warning(`Daemon unavailable: ${errorMessage(error)}`);
    return false;
  }
}

function showZenRequirements(
  ui: WizardUi,
  extensionManifestPath: string,
): void {
  ui.note("Finish setup in the intended Zen profile", [
    "Set extensions.experiments.enabled = true.",
    "For a persistent unsigned XPI, set xpinstall.signatures.required = false.",
    "Or temporarily load the extension from about:debugging after each restart.",
    `Temporary extension manifest: ${extensionManifestPath}`,
    "Zen Agent needs no Zen command-line flags or remote-debugging preferences.",
  ]);
}

function installHost(services: SetupWizardServices, ui: WizardUi): boolean {
  let installation: NativeHostInstallation;

  try {
    installation = services.inspectNativeHost();
  } catch (error) {
    ui.error(errorMessage(error));
    return false;
  }

  if (installation.status === "invalid") {
    ui.error(
      "The native-host installation is partial or not owned by Zen Agent.",
    );
    ui.note("Nothing was changed", [
      installation.launcherPath,
      installation.manifestPath,
      "Inspect these files before repairing them manually.",
    ]);
    return false;
  }

  try {
    const result = services.installNativeHost();
    ui.success(
      installation.status === "installed"
        ? "Native Messaging host refreshed."
        : "Native Messaging host installed.",
    );
    ui.info(`Launcher: ${result.launcherPath}`);
    return true;
  } catch (error) {
    ui.error(`Native-host installation failed: ${errorMessage(error)}`);
    return false;
  }
}

function spaceOptions(
  spaces: readonly WizardSpace[],
  omitLabel: string,
): readonly WizardOption<string>[] {
  return [
    ...spaces.map((space, index) => ({
      value: `space:${String(index)}`,
      label: space.name,
      hint: space.id.transportId,
    })),
    { value: "skip", label: omitLabel },
  ];
}

function selectedSpace(
  value: string | undefined,
  spaces: readonly WizardSpace[],
): WizardSpace | undefined {
  if (value === undefined || value === "skip") {
    return undefined;
  }

  const index = Number(value.slice("space:".length));
  return Number.isInteger(index) ? spaces[index] : undefined;
}

function configuredInitialValue(
  configuredId: string | undefined,
  spaces: readonly WizardSpace[],
): string {
  const index = spaces.findIndex(
    (space) => space.id.transportId === configuredId,
  );
  return index === -1 ? "skip" : `space:${String(index)}`;
}

async function configureSpaces(
  services: SetupWizardServices,
  ui: WizardUi,
): Promise<void> {
  let spaces: readonly WizardSpace[];
  let config: ZenAgentConfig | undefined;

  try {
    [spaces, config] = await Promise.all([
      services.spaces(),
      services.readConfig(),
    ]);
  } catch (error) {
    ui.error(`Space discovery failed: ${errorMessage(error)}`);
    return;
  }

  if (spaces.length === 0) {
    ui.warning("The connected Zen profile did not report any Spaces.");
    return;
  }

  const personalValue = await ui.select(
    "Which Space is Personal?",
    spaceOptions(
      spaces,
      config?.spaces.personal === undefined
        ? "Leave Personal unmapped"
        : "Keep current Personal mapping",
    ),
    configuredInitialValue(config?.spaces.personal, spaces),
  );
  if (personalValue === undefined) {
    return;
  }

  const workValue = await ui.select(
    "Which Space is Work?",
    spaceOptions(
      spaces,
      config?.spaces.work === undefined
        ? "Leave Work unmapped"
        : "Keep current Work mapping",
    ),
    configuredInitialValue(config?.spaces.work, spaces),
  );
  if (workValue === undefined) {
    return;
  }

  const personal = selectedSpace(personalValue, spaces);
  const work = selectedSpace(workValue, spaces);

  if (personal === undefined && work === undefined) {
    ui.warning("No Space mappings were changed.");
    return;
  }

  try {
    const result = await services.mapSpaces({
      ...(personal === undefined ? {} : { personal: personal.id }),
      ...(work === undefined ? {} : { work: work.id }),
    });
    ui.success(`Space configuration saved for ${result.profile}.`);
    ui.info(`Configuration: ${result.path}`);
  } catch (error) {
    ui.error(`Space configuration failed: ${errorMessage(error)}`);
  }
}

async function quickSetup(
  services: SetupWizardServices,
  ui: WizardUi,
  extensionManifestPath: string,
): Promise<void> {
  if (!installHost(services, ui)) {
    return;
  }

  showZenRequirements(ui, extensionManifestPath);
  const connected = await showStatus(services, ui);

  if (!connected) {
    ui.info(
      "Complete the Zen profile steps, then choose Check connection or Configure Spaces.",
    );
    return;
  }

  const next = await ui.select(
    "The daemon is ready. Configure Spaces now?",
    [
      {
        value: "configure",
        label: "Configure Spaces",
        hint: "recommended",
      },
      { value: "later", label: "Do this later" },
    ],
    "configure",
  );

  if (next === "configure") {
    await configureSpaces(services, ui);
  }
}

async function uninstallHost(
  services: SetupWizardServices,
  ui: WizardUi,
): Promise<void> {
  const confirmation = await ui.select(
    "Remove the Zen Agent Native Messaging host?",
    [
      {
        value: "keep",
        label: "Keep it installed",
        hint: "recommended",
      },
      {
        value: "remove",
        label: "Remove native host",
        hint: "configuration and extension stay in place",
      },
    ],
    "keep",
  );

  if (confirmation !== "remove") {
    ui.info("Native host kept in place.");
    return;
  }

  try {
    const result = services.uninstallNativeHost();
    if (result.removed) {
      ui.success("Native Messaging host removed.");
    } else {
      ui.info("Native Messaging host is not installed.");
    }
  } catch (error) {
    ui.error(`Native-host removal failed: ${errorMessage(error)}`);
  }
}

async function installSpeechModel(
  services: SetupWizardServices,
  ui: WizardUi,
): Promise<void> {
  if (
    services.speechLocales === undefined ||
    services.installSpeechLocale === undefined
  ) {
    ui.warning(
      "The on-device speech helper is unavailable on this installation.",
    );
    return;
  }
  try {
    const inventory = await services.speechLocales();
    if (inventory.supportedLocales.length === 0) {
      ui.warning("SpeechTranscriber did not report any supported locales.");
      return;
    }
    const selection = await ui.select(
      "Which on-device speech model should setup install?",
      [
        ...inventory.supportedLocales.map((locale, index) => ({
          value: `locale:${String(index)}`,
          label: locale,
          hint: inventory.installedLocales.includes(locale)
            ? "already installed"
            : "downloads an Apple model asset",
        })),
        { value: "cancel", label: "Cancel" },
      ],
      "cancel",
    );
    if (selection === undefined || selection === "cancel") {
      return;
    }
    const locale =
      inventory.supportedLocales[Number(selection.slice("locale:".length))];
    if (locale === undefined) {
      ui.error("The selected speech locale is no longer available.");
      return;
    }
    const result = await services.installSpeechLocale(locale);
    ui.success(`On-device speech model installed for ${result.locale}.`);
  } catch (error) {
    ui.error(`Speech model installation failed: ${errorMessage(error)}`);
  }
}

export async function runSetupWizard(
  options: SetupWizardOptions,
): Promise<void> {
  const { services, ui } = options;
  ui.header(options.version);
  ui.info("Use the arrow keys and Enter. Press Esc at any prompt to leave.");

  for (;;) {
    const action = await ui.select(
      "What would you like to do?",
      MAIN_ACTIONS,
      "quick-setup",
    );

    if (action === undefined || action === "exit") {
      ui.finish("Setup closed.");
      return;
    }

    switch (action) {
      case "quick-setup":
        await quickSetup(services, ui, options.extensionManifestPath);
        break;
      case "configure-spaces":
        await configureSpaces(services, ui);
        break;
      case "check-status":
        await showStatus(services, ui);
        break;
      case "install-speech":
        await installSpeechModel(services, ui);
        break;
      case "repair-host":
        installHost(services, ui);
        break;
      case "uninstall-host":
        await uninstallHost(services, ui);
        break;
    }
  }
}
