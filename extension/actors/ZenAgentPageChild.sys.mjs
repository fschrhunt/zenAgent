/**
 * Content-process half of Zen Agent's bounded page-inspection actor.
 *
 * There are deliberately no page timers here. Non-visible Zen Spaces suspend
 * requestAnimationFrame, which made Firefox's shipped PageExtractor unsuitable
 * for background inspection. Traversal and output both have hard ceilings.
 */

const HTTP_SCHEMES = new Set(["http:", "https:"]);
const MAX_VISITED_TEXT_NODES = 10_000;
const MAX_URL_CHARS = 16_384;
const MAX_TITLE_CHARS = 1_024;

function isVisible(element) {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    });
  }

  const style = element.ownerGlobal.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    style.opacity !== "0"
  );
}

function boundedVisibleText(document, maxChars) {
  const root = document.body;

  if (root === null) {
    return { text: "", truncated: false, visitedTextNodes: 0 };
  }

  const nodeFilter = document.defaultView.NodeFilter;
  const walker = document.createTreeWalker(root, nodeFilter.SHOW_TEXT);
  const pieces = [];
  let length = 0;
  let visitedTextNodes = 0;
  let truncated = false;
  let node = walker.nextNode();

  while (node !== null && visitedTextNodes < MAX_VISITED_TEXT_NODES) {
    visitedTextNodes += 1;

    const parent = node.parentElement;
    const value = node.nodeValue;

    if (parent !== null && value !== null && isVisible(parent)) {
      const normalized = value.replace(/\s+/gu, " ").trim();

      if (normalized.length > 0) {
        const separator = pieces.length === 0 ? "" : " ";
        const remaining = maxChars - length;
        const addition = `${separator}${normalized}`;

        if (addition.length > remaining) {
          pieces.push(addition.slice(0, Math.max(0, remaining)));
          truncated = true;
          break;
        }

        pieces.push(addition);
        length += addition.length;
      }
    }

    node = walker.nextNode();
  }

  if (node !== null) {
    truncated = true;
  }

  return {
    text: pieces.join(""),
    truncated,
    visitedTextNodes,
  };
}

export class ZenAgentPageChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    if (name !== "ZenAgentPage:Inspect") {
      throw new Error("Unknown Zen Agent page actor message.");
    }

    const document = this.document;
    const uri = Services.io.newURI(document.URL);

    if (!HTTP_SCHEMES.has(`${uri.scheme}:`)) {
      throw new Error("Zen Agent page inspection only supports HTTP(S).");
    }

    if (
      document.URL.length > MAX_URL_CHARS ||
      document.title.length > MAX_TITLE_CHARS
    ) {
      throw new Error("Zen Agent page metadata exceeds its result ceiling.");
    }

    const visible = boundedVisibleText(document, data.maxChars);

    return {
      url: document.URL,
      title: document.title,
      loadState: document.readyState,
      visibleText: visible.text,
      truncated: visible.truncated,
      visitedTextNodes: visible.visitedTextNodes,
    };
  }
}
