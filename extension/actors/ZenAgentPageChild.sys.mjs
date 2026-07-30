/**
 * Content-process half of Zen Agent's page actor.
 *
 * Each actor is scoped to one WindowGlobal (and therefore one document). It
 * owns short-lived weak element references, performs bounded semantic
 * traversal, and applies narrow DOM operations directly to an explicit
 * element. It never focuses a window or element and never uses native input.
 */

const HTTP_SCHEMES = new Set(["http:", "https:"]);
const { utils: Cu } = globalThis.Components;
const MAX_NODES_PER_FRAME = 5_000;
const MAX_TREE_DEPTH = 64;
const MAX_STRING_CHARS = 64 * 1024;
const MAX_NODE_TEXT_CHARS = 512;
const MAX_QUERY_RESULTS = 100;
const MAX_LIVE_SNAPSHOTS = 16;
const REFERENCE_TTL_MS = 60_000;
const MAX_UPLOAD_FILES = 32;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA = 100;
const MAX_CAPTION_CUES = 1_000;
const UNSAFE_HANDLER_SOURCE =
  /\b(?:window\s*\.\s*open|open\s*\(|alert\s*\(|confirm\s*\(|prompt\s*\(|requestPermission|getUserMedia|getDisplayMedia|geolocation\s*\.\s*(?:getCurrentPosition|watchPosition)|clipboard\s*\.\s*(?:read|readText|write|writeText)|showOpenFilePicker|showSaveFilePicker|showDirectoryPicker|credentials\s*\.\s*(?:create|get)|PaymentRequest|requestFullscreen|requestPointerLock)/iu;

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function bounded(value, maxChars = MAX_STRING_CHARS) {
  const string = String(value ?? "");
  return string.length <= maxChars ? string : string.slice(0, maxChars);
}

function normalized(value, maxChars = MAX_STRING_CHARS) {
  return bounded(value, maxChars).replace(/\s+/gu, " ").trim();
}

function isElement(value) {
  return value?.nodeType === 1;
}

function ownerWindow(element) {
  const win = element.ownerDocument?.defaultView;

  if (!win) {
    throw Object.assign(new Error("The element document is unavailable."), {
      code: "stale-element",
    });
  }

  return win;
}

function isVisible(element) {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    });
  }

  const style = ownerWindow(element).getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    style.opacity !== "0"
  );
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function geometryOf(element) {
  const rect = element.getBoundingClientRect();
  const viewportWidth = finiteNumber(ownerWindow(element).innerWidth);
  const viewportHeight = finiteNumber(ownerWindow(element).innerHeight);

  return {
    x: finiteNumber(rect.x),
    y: finiteNumber(rect.y),
    width: Math.max(0, finiteNumber(rect.width)),
    height: Math.max(0, finiteNumber(rect.height)),
    viewportX: Math.max(0, finiteNumber(rect.left)),
    viewportY: Math.max(0, finiteNumber(rect.top)),
    viewportWidth: Math.max(
      0,
      Math.min(finiteNumber(rect.right), viewportWidth) -
        Math.max(finiteNumber(rect.left), 0),
    ),
    viewportHeight: Math.max(
      0,
      Math.min(finiteNumber(rect.bottom), viewportHeight) -
        Math.max(finiteNumber(rect.top), 0),
    ),
  };
}

function openOrClosedShadowRoot(element) {
  try {
    return element.openOrClosedShadowRoot ?? element.shadowRoot ?? null;
  } catch {
    return element.shadowRoot ?? null;
  }
}

function shadowBoundaryOf(element) {
  const root = openOrClosedShadowRoot(element);

  if (root === null) {
    return "none";
  }

  return root.mode === "closed" ? "closed" : "open";
}

function assertStaticInteractionSafety(element, operation) {
  const target =
    element.getAttribute("formtarget") ??
    element.getAttribute("target") ??
    element.form?.getAttribute("target");

  if (target && target.toLowerCase() !== "_self") {
    throw Object.assign(
      new Error(
        `${operation} was refused because the target may open another browsing context.`,
      ),
      { code: "policy-rejection" },
    );
  }

  if (
    element.hasAttribute("download") ||
    element.closest("a[download], area[download]") !== null
  ) {
    throw Object.assign(
      new Error(
        `${operation} was refused because the target may open native download UI.`,
      ),
      { code: "policy-rejection" },
    );
  }

  for (const name of element.getAttributeNames()) {
    const value = name.startsWith("on") ? element.getAttribute(name) : null;

    if (value && UNSAFE_HANDLER_SOURCE.test(value)) {
      throw Object.assign(
        new Error(
          `${operation} was refused because an inline handler may request foreground UI or a protected permission.`,
        ),
        { code: "policy-rejection" },
      );
    }
  }
}

function eventPropagationTargets(element) {
  const targets = [];
  let target = element;

  while (target !== null) {
    targets.push(target);
    target = target.parentNode ?? target.host ?? null;
  }

  const document = element.ownerDocument;
  if (!targets.includes(document)) {
    targets.push(document);
  }

  const win = document?.defaultView;
  if (win && !targets.includes(win)) {
    targets.push(win);
  }

  return targets;
}

function refuseUnsafeHandler(operation, kind) {
  throw Object.assign(
    new Error(
      `${operation} was refused because ${kind} may request foreground UI or a protected permission.`,
    ),
    { code: "policy-rejection" },
  );
}

function assertEventInteractionSafety(element, operation, eventTypes) {
  const types = new Set(eventTypes);

  for (const target of eventPropagationTargets(element)) {
    if (isElement(target)) {
      for (const type of types) {
        const value = target.getAttribute(`on${type}`);
        if (value && UNSAFE_HANDLER_SOURCE.test(value)) {
          refuseUnsafeHandler(operation, "an inline handler");
        }
      }
    }

    for (const listener of Services.els.getListenerInfoFor(target) ?? []) {
      if (!types.has(listener.type)) {
        continue;
      }

      let listenerObject;
      try {
        listenerObject = listener.listenerObject;
      } catch {
        refuseUnsafeHandler(operation, "a registered handler");
      }

      // Native listeners implement browser default actions rather than page
      // script, and do not expose a JavaScript listener object.
      if (listenerObject === null || listenerObject === undefined) {
        continue;
      }

      let source;
      try {
        source = listener.toSource();
      } catch {
        refuseUnsafeHandler(operation, "a registered handler");
      }

      if (
        typeof source !== "string" ||
        source.length === 0 ||
        UNSAFE_HANDLER_SOURCE.test(source)
      ) {
        refuseUnsafeHandler(operation, "a registered handler");
      }
    }
  }
}

function staticBackgroundUrl(element) {
  if (
    !["a", "area"].includes(element.localName) ||
    element.getAttribute("target")?.toLowerCase() !== "_blank" ||
    element.hasAttribute("download")
  ) {
    return undefined;
  }

  try {
    const destination = new URL(element.href);
    return ["http:", "https:"].includes(destination.protocol)
      ? destination.href
      : undefined;
  } catch {
    return undefined;
  }
}

function explicitRole(element) {
  const value = element.getAttribute("role");
  return value?.trim().split(/\s+/u)[0] ?? null;
}

function implicitRole(element) {
  const tag = element.localName;

  if (tag === "a" && element.hasAttribute("href")) {
    return "link";
  }

  if (tag === "button") {
    return "button";
  }

  if (tag === "textarea") {
    return "textbox";
  }

  if (tag === "select") {
    return element.multiple ? "listbox" : "combobox";
  }

  if (tag === "option") {
    return "option";
  }

  if (tag === "summary") {
    return "button";
  }

  if (/^h[1-6]$/u.test(tag)) {
    return "heading";
  }

  if (tag === "img") {
    return "img";
  }

  if (tag === "input") {
    switch (element.type) {
      case "button":
      case "reset":
      case "submit":
        return "button";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "number":
        return "spinbutton";
      case "search":
        return "searchbox";
      case "hidden":
        return null;
      default:
        return "textbox";
    }
  }

  return null;
}

function roleOf(element) {
  return explicitRole(element) ?? implicitRole(element);
}

function labelsOf(element) {
  if (!element.labels) {
    return "";
  }

  return Array.from(element.labels)
    .map((label) => {
      const clone = label.cloneNode(true);

      for (const control of clone.querySelectorAll(
        "button, input, select, textarea",
      )) {
        control.remove();
      }

      return normalized(clone.textContent, MAX_NODE_TEXT_CHARS);
    })
    .filter(Boolean)
    .join(" ");
}

function nameOf(element) {
  const ariaLabel = element.getAttribute("aria-label");

  if (ariaLabel) {
    return normalized(ariaLabel, MAX_NODE_TEXT_CHARS);
  }

  const labelledBy = element.getAttribute("aria-labelledby");

  if (labelledBy) {
    const pieces = labelledBy
      .trim()
      .split(/\s+/u)
      .slice(0, 128)
      .map((id) => element.ownerDocument.getElementById(id))
      .filter(Boolean)
      .map((label) => normalized(label.textContent, MAX_NODE_TEXT_CHARS))
      .filter(Boolean);

    if (pieces.length > 0) {
      return bounded(pieces.join(" "), MAX_NODE_TEXT_CHARS);
    }
  }

  const labels = labelsOf(element);

  if (labels) {
    return bounded(labels, MAX_NODE_TEXT_CHARS);
  }

  for (const attribute of ["alt", "title", "placeholder"]) {
    const value = element.getAttribute(attribute);

    if (value) {
      return normalized(value, MAX_NODE_TEXT_CHARS);
    }
  }

  if (
    element.localName === "button" ||
    element.localName === "a" ||
    element.localName === "option" ||
    element.localName === "summary" ||
    /^h[1-6]$/u.test(element.localName)
  ) {
    return normalized(element.textContent, MAX_NODE_TEXT_CHARS);
  }

  if (
    element.localName === "input" &&
    ["button", "reset", "submit"].includes(element.type)
  ) {
    return normalized(element.value, MAX_NODE_TEXT_CHARS);
  }

  return "";
}

function booleanAttribute(element, ariaName, propertyName) {
  const aria = element.getAttribute(ariaName);

  if (aria === "true") {
    return true;
  }

  if (aria === "false") {
    return false;
  }

  return propertyName in element ? Boolean(element[propertyName]) : null;
}

function actionHints(element, role) {
  const hints = [];
  const interactive = INTERACTIVE_ROLES.has(role);

  if (
    interactive ||
    typeof element.onclick === "function" ||
    element.hasAttribute("onclick")
  ) {
    try {
      assertStaticInteractionSafety(element, "Click");
      hints.push("click");
    } catch {
      // The snapshot reports the node, but never advertises an unsafe action.
    }
  }

  if (staticBackgroundUrl(element) !== undefined) {
    hints.push("open-background");
  }

  if (
    role === "textbox" ||
    role === "searchbox" ||
    role === "spinbutton" ||
    element.isContentEditable
  ) {
    hints.push("fill", "type");
  }

  if (role === "combobox" || role === "listbox") {
    hints.push("select");
  }

  if (role === "checkbox" || role === "radio" || role === "switch") {
    hints.push("check");
  }

  if (element.form || element.localName === "form") {
    try {
      assertStaticInteractionSafety(element, "Submit");
      hints.push("submit");
    } catch {
      // See the click preflight above.
    }
  }

  if (element.localName === "input" && element.type === "file") {
    hints.push("upload");
  }

  if (interactive || element.isContentEditable || element.tabIndex >= 0) {
    hints.push("press");
  }

  return [...new Set(hints)];
}

function shouldInclude(element, role, name, text) {
  return (
    role !== null ||
    name.length > 0 ||
    (text.length > 0 &&
      ["p", "li", "dt", "dd", "blockquote", "pre"].includes(element.localName))
  );
}

function childElements(element) {
  const children = Array.from(element.children);
  const shadowRoot = openOrClosedShadowRoot(element);

  if (shadowRoot?.mode === "open") {
    children.push(...Array.from(shadowRoot.children));
  }

  return children;
}

function querySelectorAllOpenRoots(document, selector) {
  const matches = Array.from(document.querySelectorAll(selector));
  const roots = [document.documentElement];

  while (roots.length > 0) {
    const element = roots.pop();

    if (!element) {
      continue;
    }

    const shadowRoot = openOrClosedShadowRoot(element);

    if (shadowRoot?.mode === "open") {
      matches.push(...Array.from(shadowRoot.querySelectorAll(selector)));
    }

    roots.push(...Array.from(element.children));

    if (shadowRoot?.mode === "open") {
      roots.push(...Array.from(shadowRoot.children));
    }
  }

  return [...new Set(matches)];
}

function semanticState(element, role) {
  const state = {
    disabled: booleanAttribute(element, "aria-disabled", "disabled"),
    editable:
      role === "textbox" ||
      role === "searchbox" ||
      role === "spinbutton" ||
      element.isContentEditable,
    checked:
      role === "checkbox" || role === "radio" || role === "switch"
        ? booleanAttribute(element, "aria-checked", "checked")
        : null,
    selected:
      role === "option" || role === "tab"
        ? booleanAttribute(element, "aria-selected", "selected")
        : null,
    expanded: booleanAttribute(element, "aria-expanded", "open"),
    pressed: booleanAttribute(element, "aria-pressed", "pressed"),
    required: booleanAttribute(element, "aria-required", "required"),
    readonly: booleanAttribute(element, "aria-readonly", "readOnly"),
    invalid:
      element.getAttribute("aria-invalid") === "true" ||
      ("willValidate" in element &&
        element.willValidate &&
        !element.validity.valid),
    level: null,
    orientation: element.getAttribute("aria-orientation"),
  };

  if (role === "heading") {
    state.level =
      Number(element.getAttribute("aria-level")) ||
      Number(element.localName[1]);
  }

  return state;
}

function describeElement(element, elementRef, parentElementRef) {
  const role = roleOf(element);
  const name = nameOf(element);
  const visible = isVisible(element);
  const carriesText = ["p", "li", "dt", "dd", "blockquote", "pre"].includes(
    element.localName,
  );
  const text = !visible
    ? ""
    : carriesText
      ? normalized(
          element.innerText ?? element.textContent,
          MAX_NODE_TEXT_CHARS,
        )
      : name;
  const backgroundUrl = staticBackgroundUrl(element);

  return {
    elementRef,
    parentElementRef,
    role,
    name,
    visibleText: text,
    visible,
    geometry: geometryOf(element),
    shadowRoot: shadowBoundaryOf(element),
    ...(backgroundUrl === undefined ? {} : { backgroundUrl }),
    state: semanticState(element, role),
    actionHints: actionHints(element, role),
  };
}

function elementStringWasTruncated(element, description) {
  return (
    ["aria-label", "alt", "title", "placeholder"].some(
      (attribute) =>
        (element.getAttribute(attribute)?.length ?? 0) > MAX_NODE_TEXT_CHARS,
    ) ||
    description.name.length >= MAX_NODE_TEXT_CHARS ||
    description.visibleText.length >= MAX_NODE_TEXT_CHARS
  );
}

function matchesLocator(element, description, locator) {
  switch (locator.kind) {
    case "role":
      return (
        description.role === locator.role &&
        (locator.name === undefined || description.name === locator.name)
      );
    case "label":
      return labelsOf(element) === locator.label;
    case "text":
      return description.visibleText.includes(locator.text);
    case "placeholder":
      return element.getAttribute("placeholder") === locator.placeholder;
    case "element":
      return description.elementRef === locator.elementRef;
    default:
      return false;
  }
}

function editableKind(element) {
  if (element.localName === "textarea") {
    return "control";
  }

  if (element.localName === "input") {
    const unsupported = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ]);
    return unsupported.has(element.type) ? null : "control";
  }

  return element.isContentEditable ? "contenteditable" : null;
}

function setControlValue(element, value) {
  const prototype =
    element.localName === "textarea"
      ? ownerWindow(element).HTMLTextAreaElement.prototype
      : ownerWindow(element).HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (typeof setter !== "function") {
    throw Object.assign(new Error("That text control cannot be edited."), {
      code: "unsupported-capability",
    });
  }

  setter.call(element, value);
}

function emitInput(element, inputType, data) {
  const win = ownerWindow(element);
  element.dispatchEvent(
    new win.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType,
      data,
    }),
  );
}

export class ZenAgentPageChild extends JSWindowActorChild {
  #documentId = uuid();
  #snapshots = new Map();

  async receiveMessage({ name, data }) {
    try {
      let value;

      switch (name) {
        case "ZenAgentPage:Inspect":
          value = this.#inspect(data);
          break;
        case "ZenAgentPage:Snapshot":
          value = this.#snapshot(data);
          break;
        case "ZenAgentPage:Query":
          value = this.#query(data);
          break;
        case "ZenAgentPage:Mutate":
          value = await this.#mutate(data);
          break;
        case "ZenAgentPage:Media":
          value = this.#media(data);
          break;
        case "ZenAgentPage:Resource":
          value = await this.#resource(data);
          break;
        case "ZenAgentPage:MediaResource":
          value = await this.#mediaResource(data);
          break;
        case "ZenAgentPage:ScreenshotRect":
          value = this.#screenshotRect(data);
          break;
        case "ZenAgentPage:Document":
          value = this.#documentInfo();
          break;
        default:
          throw Object.assign(
            new Error("Unknown Zen Agent page actor message."),
            { code: "invalid-request" },
          );
      }

      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error && typeof error.code === "string" ? error.code : "internal",
          message: String(error?.message ?? "Page actor failure."),
        },
      };
    }
  }

  #assertHttpDocument() {
    const document = this.document;
    const uri = Services.io.newURI(document.URL);

    if (!HTTP_SCHEMES.has(`${uri.scheme}:`)) {
      throw Object.assign(
        new Error("Zen Agent page interaction only supports HTTP(S)."),
        { code: "unsupported-capability" },
      );
    }

    return document;
  }

  #documentInfo() {
    const document = this.#assertHttpDocument();
    return {
      documentId: this.#documentId,
      url: bounded(document.URL),
      loadState: document.readyState,
    };
  }

  #inspect(data) {
    const document = this.#assertHttpDocument();
    const root = document.body;
    const maxChars = data.maxChars;
    let text = "";
    let visitedTextNodes = 0;
    let truncated = false;

    if (root !== null) {
      const walker = document.createTreeWalker(
        root,
        document.defaultView.NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();

      while (node !== null && visitedTextNodes < 10_000) {
        visitedTextNodes += 1;
        const parent = node.parentElement;
        const value = normalized(node.nodeValue);

        if (parent !== null && value && isVisible(parent)) {
          const addition = `${text ? " " : ""}${value}`;

          if (text.length + addition.length > maxChars) {
            text += addition.slice(0, maxChars - text.length);
            truncated = true;
            break;
          }

          text += addition;
        }

        node = walker.nextNode();
      }

      if (node !== null) {
        truncated = true;
      }
    }

    return {
      url: bounded(document.URL, 16_384),
      title: bounded(document.title, 1_024),
      loadState: document.readyState,
      visibleText: text,
      truncated,
      visitedTextNodes,
    };
  }

  #pruneSnapshots() {
    const expiresBefore = Date.now() - REFERENCE_TTL_MS;

    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.createdAt < expiresBefore) {
        this.#snapshots.delete(id);
      }
    }

    while (this.#snapshots.size > MAX_LIVE_SNAPSHOTS) {
      const oldest = this.#snapshots.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      this.#snapshots.delete(oldest);
    }
  }

  #newElementRef(snapshot, element) {
    const elementRef = uuid();
    snapshot.refs.set(elementRef, new WeakRef(element));
    return elementRef;
  }

  #elementRefFor(snapshot, element) {
    for (const [elementRef, reference] of snapshot.refs) {
      const existing = reference.deref();

      if (existing === undefined) {
        snapshot.refs.delete(elementRef);
      } else if (existing === element) {
        return elementRef;
      }
    }

    return this.#newElementRef(snapshot, element);
  }

  #walk(snapshot, maxNodes, matcher = null) {
    const document = this.#assertHttpDocument();
    const root = document.documentElement;
    const nodes = [];
    let visited = 0;
    let truncated = false;
    let stringsTruncated = false;

    if (root === null) {
      return { nodes, visited, truncated, stringsTruncated };
    }

    const stack = [{ element: root, depth: 0, parentElementRef: null }];

    while (stack.length > 0) {
      const entry = stack.pop();

      if (entry === undefined) {
        break;
      }

      visited += 1;

      if (entry.depth > MAX_TREE_DEPTH || visited > MAX_NODES_PER_FRAME) {
        truncated = true;
        continue;
      }

      const provisionalRef = uuid();
      const description = describeElement(
        entry.element,
        provisionalRef,
        entry.parentElementRef,
      );
      const include = shouldInclude(
        entry.element,
        description.role,
        description.name,
        description.visibleText,
      );
      const matches = matcher?.(entry.element, description) ?? include;
      let semanticParent = entry.parentElementRef;
      stringsTruncated ||= elementStringWasTruncated(
        entry.element,
        description,
      );

      if (include || matcher !== null) {
        if (matches) {
          const elementRef = this.#newElementRef(snapshot, entry.element);
          nodes.push({
            ...description,
            elementRef,
            ...(matcher === null ? {} : { parentElementRef: null }),
          });
          semanticParent = include ? elementRef : entry.parentElementRef;
        } else if (include) {
          semanticParent = provisionalRef;
        }
      }

      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }

      const children = childElements(entry.element);

      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];

        if (child !== undefined) {
          stack.push({
            element: child,
            depth: entry.depth + 1,
            parentElementRef: semanticParent,
          });
        }
      }
    }

    return { nodes, visited, truncated, stringsTruncated };
  }

  #snapshot(data) {
    const document = this.#assertHttpDocument();
    this.#pruneSnapshots();
    const snapshot = {
      documentId: this.#documentId,
      createdAt: Date.now(),
      refs: new Map(),
    };
    this.#snapshots.set(data.snapshotId, snapshot);
    this.#pruneSnapshots();
    const walked = this.#walk(
      snapshot,
      Math.min(data.maxNodes, MAX_NODES_PER_FRAME),
    );

    return {
      documentId: this.#documentId,
      url: bounded(document.URL),
      title: bounded(document.title, 1_024),
      loadState: document.readyState,
      nodes: walked.nodes,
      visitedElements: walked.visited,
      truncated: walked.truncated,
      stringsTruncated:
        walked.stringsTruncated ||
        document.URL.length > MAX_STRING_CHARS ||
        document.title.length > 1_024,
    };
  }

  #snapshotFor(data) {
    if (data.documentId !== this.#documentId) {
      throw Object.assign(new Error("The document reference is stale."), {
        code: "stale-document",
      });
    }

    this.#pruneSnapshots();
    const snapshot = this.#snapshots.get(data.snapshotId);

    if (snapshot === undefined) {
      throw Object.assign(new Error("The page snapshot has expired."), {
        code: "stale-element",
      });
    }

    return snapshot;
  }

  #query(data) {
    const snapshot = this.#snapshotFor(data);
    const locator = data.locator;

    if (locator.kind === "element") {
      const element = this.#elementFor({
        snapshotId: data.snapshotId,
        documentId: data.documentId,
        elementRef: locator.elementRef,
      });
      return {
        nodes: [describeElement(element, locator.elementRef, null)],
        truncated: false,
      };
    }

    if (locator.kind === "css") {
      let elements;

      try {
        elements = querySelectorAllOpenRoots(
          this.#assertHttpDocument(),
          locator.selector,
        );
      } catch {
        throw Object.assign(new Error("The CSS selector is invalid."), {
          code: "invalid-request",
        });
      }

      const nodes = elements.slice(0, data.maxResults).map((element) => {
        const elementRef = this.#newElementRef(snapshot, element);
        return describeElement(element, elementRef, null);
      });
      return {
        nodes,
        truncated: elements.length > nodes.length,
      };
    }

    const walked = this.#walk(
      snapshot,
      Math.min(data.maxResults, MAX_QUERY_RESULTS),
      (element, description) => matchesLocator(element, description, locator),
    );
    return { nodes: walked.nodes, truncated: walked.truncated };
  }

  #elementFor(data) {
    const snapshot = this.#snapshotFor(data);
    const element = snapshot.refs.get(data.elementRef)?.deref();

    if (
      !isElement(element) ||
      !element.isConnected ||
      element.ownerDocument !== this.document
    ) {
      snapshot.refs.delete(data.elementRef);
      throw Object.assign(new Error("The element reference is stale."), {
        code: "stale-element",
      });
    }

    return element;
  }

  #screenshotRect(data) {
    this.#snapshotFor(data);
    const document = this.#assertHttpDocument();

    if (data.elementRef === undefined) {
      return {
        x: 0,
        y: 0,
        width: finiteNumber(document.defaultView.innerWidth),
        height: finiteNumber(document.defaultView.innerHeight),
      };
    }

    const rect = geometryOf(this.#elementFor(data));

    if (rect.viewportWidth <= 0 || rect.viewportHeight <= 0) {
      throw Object.assign(
        new Error("The screenshot target is outside the frame viewport."),
        { code: "policy-rejection" },
      );
    }

    return {
      x: rect.viewportX,
      y: rect.viewportY,
      width: rect.viewportWidth,
      height: rect.viewportHeight,
    };
  }

  #media(data) {
    const snapshot = this.#snapshotFor(data);
    const elements = Array.from(
      this.#assertHttpDocument().querySelectorAll("audio, video"),
    );
    const media = elements.slice(0, MAX_MEDIA).map((element) => {
      const elementRef = this.#elementRefFor(snapshot, element);
      const captions = Array.from(element.textTracks ?? []).map((track) => {
        let cues = [];
        let cuesAvailable = true;
        let truncated = false;

        try {
          const allCues = Array.from(track.cues ?? []);
          truncated = allCues.length > MAX_CAPTION_CUES;
          cues = allCues.slice(0, MAX_CAPTION_CUES).map((cue) => ({
            startTime: finiteNumber(cue.startTime),
            endTime: finiteNumber(cue.endTime),
            text: bounded(cue.text, 4_096),
          }));
        } catch {
          cuesAvailable = false;
        }

        return {
          kind: bounded(track.kind, 64),
          label: bounded(track.label, 512),
          language: bounded(track.language, 128),
          mode: ["disabled", "hidden", "showing"].includes(track.mode)
            ? track.mode
            : "disabled",
          cues,
          cuesAvailable,
          truncated,
        };
      });

      return {
        elementRef,
        kind: element.localName,
        sourceUrl: bounded(element.currentSrc || element.src),
        duration: Number.isFinite(element.duration) ? element.duration : null,
        currentTime: finiteNumber(element.currentTime),
        paused: Boolean(element.paused),
        muted: Boolean(element.muted),
        volume: finiteNumber(element.volume),
        readyState: Number.isInteger(element.readyState)
          ? element.readyState
          : 0,
        drm: element.mediaKeys !== null,
        captions,
      };
    });

    return { media, truncated: elements.length > media.length };
  }

  async #mediaResource(data) {
    const element = this.#elementFor(data);

    if (!["audio", "video"].includes(element.localName)) {
      throw Object.assign(new Error("That element is not media."), {
        code: "invalid-request",
      });
    }

    if (element.mediaKeys !== null) {
      throw Object.assign(
        new Error("Protected media bytes are not accessible."),
        { code: "unsupported-capability" },
      );
    }

    return this.#resource({
      ...data,
      url: element.currentSrc || element.src,
      media: true,
    });
  }

  async #resource(data) {
    const document = this.#assertHttpDocument();

    if (data.documentId !== this.#documentId) {
      throw Object.assign(new Error("The document reference is stale."), {
        code: "stale-document",
      });
    }

    const maxBytes = data.maxBytes;
    const maxAllowedBytes = data.media
      ? MAX_MEDIA_RESOURCE_BYTES
      : MAX_RESOURCE_BYTES;

    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > maxAllowedBytes
    ) {
      throw Object.assign(new Error("The resource byte limit is invalid."), {
        code: "invalid-request",
      });
    }

    let url;

    try {
      url = new URL(data.url, document.baseURI);
    } catch {
      throw Object.assign(new Error("The resource URL is invalid."), {
        code: "invalid-request",
      });
    }

    if (
      !HTTP_SCHEMES.has(url.protocol) ||
      url.origin !== new URL(document.URL).origin ||
      url.username ||
      url.password
    ) {
      throw Object.assign(
        new Error(
          "Credentialed resource fetch is limited to same-origin HTTP(S) URLs without embedded credentials.",
        ),
        { code: "policy-rejection" },
      );
    }

    let response;

    try {
      response = await this.contentWindow.fetch(url.href, {
        cache: "no-store",
        credentials: "include",
        mode: "same-origin",
        redirect: "error",
      });
    } catch {
      throw Object.assign(
        new Error(
          "The same-origin resource request failed or attempted a redirect.",
        ),
        { code: "unsupported-capability" },
      );
    }

    if (!response.ok || response.body === null) {
      throw Object.assign(
        new Error("The resource did not return an accessible success body."),
        { code: "unsupported-capability" },
      );
    }

    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel();
      throw Object.assign(new Error("The resource exceeds the byte limit."), {
        code: "payload-too-large",
      });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;

    while (true) {
      const part = await reader.read();

      if (part.done) {
        break;
      }

      // Fetch runs in the content window compartment. Copy each chunk into
      // this privileged actor before reading it; Gecko deliberately rejects
      // byte-by-byte TypedArray access through an Xray wrapper.
      const chunk = Cu.cloneInto(part.value, globalThis);
      bytes += chunk.byteLength;

      if (bytes > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error("The resource exceeds the byte limit."), {
          code: "payload-too-large",
        });
      }

      chunks.push(chunk);
    }

    let binary = "";

    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += 32_768) {
        binary += String.fromCharCode(
          ...chunk.subarray(offset, offset + 32_768),
        );
      }
    }

    return {
      mimeType: bounded(
        response.headers.get("content-type") ?? "application/octet-stream",
        512,
      ),
      bytes,
      dataBase64: this.contentWindow.btoa(binary),
    };
  }

  async #mutate(data) {
    const element = this.#elementFor(data);
    let fileCount;

    if (!isVisible(element)) {
      throw Object.assign(new Error("The target element is not visible."), {
        code: "policy-rejection",
      });
    }

    if (
      Boolean(element.disabled) ||
      element.getAttribute("aria-disabled") === "true"
    ) {
      throw Object.assign(new Error("The target element is disabled."), {
        code: "policy-rejection",
      });
    }

    switch (data.operation) {
      case "click":
        assertStaticInteractionSafety(element, "Click");
        assertEventInteractionSafety(element, "Click", ["click", "submit"]);
        element.click();
        break;
      case "upload": {
        if (
          element.localName !== "input" ||
          element.type !== "file" ||
          typeof element.mozSetFileArray !== "function"
        ) {
          throw Object.assign(
            new Error(
              "That element does not support explicit staged-file assignment.",
            ),
            { code: "unsupported-capability" },
          );
        }

        if (
          !Array.isArray(data.files) ||
          data.files.length < 1 ||
          data.files.length > MAX_UPLOAD_FILES
        ) {
          throw Object.assign(
            new Error("Upload requires a bounded list of staged files."),
            { code: "invalid-request" },
          );
        }

        if (!element.multiple && data.files.length > 1) {
          throw Object.assign(
            new Error("That file input accepts only one file."),
            { code: "invalid-request" },
          );
        }

        assertEventInteractionSafety(element, "Upload", ["input", "change"]);
        const win = ownerWindow(element);
        element.mozSetFileArray(data.files);

        for (const type of ["input", "change"]) {
          element.dispatchEvent(
            new win.Event(type, { bubbles: true, composed: true }),
          );
        }

        fileCount = data.files.length;
        break;
      }
      case "fill":
      case "type": {
        const kind = editableKind(element);

        if (kind === null) {
          throw Object.assign(new Error("That element is not editable."), {
            code: "unsupported-capability",
          });
        }

        const value = bounded(data.value);
        assertEventInteractionSafety(
          element,
          data.operation === "fill" ? "Fill" : "Type",
          data.operation === "fill" ? ["input", "change"] : ["input"],
        );

        if (kind === "control") {
          const next =
            data.operation === "fill" ? value : element.value + value;
          setControlValue(element, next);
        } else {
          element.textContent =
            data.operation === "fill"
              ? value
              : `${element.textContent ?? ""}${value}`;
        }

        emitInput(
          element,
          data.operation === "fill" ? "insertReplacementText" : "insertText",
          value,
        );

        if (data.operation === "fill") {
          element.dispatchEvent(
            new (ownerWindow(element).Event)("change", {
              bubbles: true,
              composed: true,
            }),
          );
        }
        break;
      }
      case "press": {
        assertEventInteractionSafety(element, "Press", [
          "keydown",
          "keyup",
          "submit",
        ]);
        const win = ownerWindow(element);
        const options = {
          key: data.key,
          code: data.code ?? "",
          altKey: Boolean(data.altKey),
          ctrlKey: Boolean(data.ctrlKey),
          metaKey: Boolean(data.metaKey),
          shiftKey: Boolean(data.shiftKey),
          bubbles: true,
          composed: true,
          cancelable: true,
        };
        const accepted = element.dispatchEvent(
          new win.KeyboardEvent("keydown", options),
        );

        if (
          accepted &&
          data.key === "Enter" &&
          !options.altKey &&
          !options.ctrlKey &&
          !options.metaKey &&
          !options.shiftKey
        ) {
          const form = element.form ?? element.closest("form");
          if (form) {
            assertStaticInteractionSafety(form, "Submit");
            assertStaticInteractionSafety(element, "Submit");
          }
          form?.requestSubmit();
        }

        element.dispatchEvent(new win.KeyboardEvent("keyup", options));
        break;
      }
      case "select": {
        if (element.localName !== "select") {
          throw Object.assign(new Error("That element is not a select."), {
            code: "unsupported-capability",
          });
        }

        if (!element.multiple && data.values.length > 1) {
          throw Object.assign(
            new Error("A single-select element accepts exactly one value."),
            { code: "invalid-request" },
          );
        }

        const requested = new Set(data.values.map(String));
        const available = new Set(
          Array.from(element.options, (option) => option.value),
        );

        if ([...requested].some((value) => !available.has(value))) {
          throw Object.assign(
            new Error("One or more select values do not exist."),
            { code: "invalid-request" },
          );
        }

        assertEventInteractionSafety(element, "Select", ["input", "change"]);
        for (const option of element.options) {
          option.selected = requested.has(option.value);
        }

        element.dispatchEvent(
          new (ownerWindow(element).Event)("input", { bubbles: true }),
        );
        element.dispatchEvent(
          new (ownerWindow(element).Event)("change", { bubbles: true }),
        );
        break;
      }
      case "check":
      case "uncheck": {
        if (
          element.localName !== "input" ||
          !["checkbox", "radio"].includes(element.type)
        ) {
          throw Object.assign(
            new Error("That element is not a checkbox or radio."),
            { code: "unsupported-capability" },
          );
        }

        const checked = data.operation === "check";

        if (!checked && element.type === "radio") {
          throw Object.assign(new Error("A radio cannot be unchecked."), {
            code: "unsupported-capability",
          });
        }

        if (element.checked !== checked) {
          assertStaticInteractionSafety(element, "Check");
          assertEventInteractionSafety(element, "Check", [
            "click",
            "input",
            "change",
          ]);
          element.click();
        }
        break;
      }
      case "submit": {
        const form =
          element.localName === "form" ? element : (element.form ?? null);

        if (form === null || typeof form.requestSubmit !== "function") {
          throw Object.assign(
            new Error("That element is not associated with a form."),
            { code: "unsupported-capability" },
          );
        }

        assertStaticInteractionSafety(form, "Submit");
        assertStaticInteractionSafety(element, "Submit");
        assertEventInteractionSafety(element, "Submit", ["submit"]);
        form.requestSubmit(
          element.localName === "button" ||
            (element.localName === "input" &&
              ["submit", "image"].includes(element.type))
            ? element
            : undefined,
        );
        break;
      }
      default:
        throw Object.assign(new Error("Unknown page mutation."), {
          code: "invalid-request",
        });
    }

    return {
      performed: true,
      documentId: this.#documentId,
      ...(fileCount === undefined ? {} : { fileCount }),
    };
  }
}
