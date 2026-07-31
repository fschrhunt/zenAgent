import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runtimeRoots = ["src", "extension", "native"].map((path) =>
  join(repositoryRoot, path),
);
const sourceExtensions = new Set([".ts", ".js", ".mjs", ".swift"]);
const prohibited = [
  {
    label: "browsing-context activation",
    pattern: /\bbrowsingContext\.activate\s*\(/u,
  },
  {
    label: "foreground WebExtension tab selection",
    pattern: /\btabs\.update\s*\([^)]*\bactive\s*:\s*true/su,
  },
  {
    label: "foreground WebExtension window focus",
    pattern: /\bwindows\.update\s*\([^)]*\bfocused\s*:\s*true/su,
  },
  {
    label: "CoreGraphics native input injection",
    pattern: /\b(?:CGEventPost|CGEventTapCreate|CGWarpMouseCursorPosition)\b/u,
  },
  {
    label: "macOS accessibility UI automation",
    pattern: /\bAXUIElement(?:Create|PerformAction|SetAttributeValue)\b/u,
  },
  {
    label: "AppKit application activation",
    pattern:
      /\b(?:NSRunningApplication|NSApplication)\b[\s\S]{0,160}\bactivate\s*\(/u,
  },
  {
    label: "native file picker",
    pattern: /\b(?:NSOpenPanel|NSSavePanel|UIDocumentPickerViewController)\b/u,
  },
  {
    label: "native notification creation",
    pattern: /\b(?:UNUserNotificationCenter|NSUserNotificationCenter)\b/u,
  },
  {
    label: "AppleScript UI automation",
    pattern: /\b(?:osascript|System Events)\b/u,
  },
  {
    label: "Firefox native input synthesis",
    pattern: /\b(?:synthesizeMouse|synthesizeKey|sendNativeMouseEvent)\s*\(/u,
  },
  {
    label: "trusted user-activation override",
    pattern: /\bsetHandlingUserInput\s*\(/u,
  },
  {
    label: "WebExtension notification creation",
    pattern:
      /\b(?:browser\.)?notifications\.(?:create|update)\s*\(|\bnew\s+Notification\s*\(|\bNotification\.requestPermission\s*\(/u,
  },
  {
    label: "WebExtension permission request",
    pattern: /\bbrowser\.permissions\.request\s*\(/u,
  },
  {
    label: "WebExtension-managed download",
    pattern:
      /\bbrowser\.downloads\.(?:download|open|show|showDefaultFolder)\s*\(/u,
  },
  {
    label: "browser action badge",
    pattern: /\bbrowser\.action\.setBadgeText\s*\(/u,
  },
  {
    label: "MCP progress notification",
    pattern: /\b(?:sendNotification|sendProgressNotification)\s*\(/u,
  },
];

function sourceFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

const violations = [];

for (const root of runtimeRoots) {
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf8");

    for (const rule of prohibited) {
      if (rule.pattern.test(source)) {
        violations.push(
          `${relative(repositoryRoot, path)}: ${rule.label} is prohibited`,
        );
      }
    }
  }
}

const manifestPath = join(repositoryRoot, "extension", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const forbiddenPermissions = new Set([
  "<all_urls>",
  "activeTab",
  "downloads",
  "notifications",
  "tabs",
]);
const permissions = [
  ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
  ...(Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions
    : []),
];

for (const permission of permissions) {
  if (forbiddenPermissions.has(permission)) {
    violations.push(
      `extension/manifest.json: '${permission}' permission is prohibited`,
    );
  }
}

if (violations.length > 0) {
  throw new Error(
    `Background-safety check failed:\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`,
  );
}

process.stdout.write(
  "Verified runtime sources contain no prohibited foreground or native-input paths.\n",
);
