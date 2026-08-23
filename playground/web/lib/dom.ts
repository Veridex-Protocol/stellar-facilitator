/**
 * Small DOM helpers.
 * License: Apache-2.0
 *
 * The playground has no framework. Everything it renders is derived from a
 * trace or a fetch result, so a handful of builders is enough, and it keeps the
 * bundle honest: the only large dependency is the Stellar SDK the payments
 * actually need.
 */

type Attrs = Record<string, string | boolean | number | undefined | EventListener>;

/**
 * Builds an element.
 *
 * Text is always set through `textContent`, so nothing rendered from a network
 * response can inject markup.
 *
 * @param tag - Tag name
 * @param attrs - Attributes, `class`, or `on*` event listeners
 * @param children - Child nodes or text
 * @returns The element
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | undefined | false> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Replaces an element's children.
 *
 * @param target - The element to clear
 * @param children - New children
 */
export function replace(target: Element, ...children: Array<Node | string | undefined | false>): void {
  target.replaceChildren();
  for (const child of children) {
    if (child === undefined || child === false) continue;
    target.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/**
 * Renders a value as a pretty-printed, scrollable JSON block.
 *
 * @param value - Any JSON-serializable value
 * @param label - Optional caption
 * @returns The rendered block
 */
export function json(value: unknown, label?: string): HTMLElement {
  const body = el("pre", { class: "code" }, [safeStringify(value)]);
  if (!label) return body;
  return el("div", { class: "code-block" }, [el("div", { class: "code-label" }, [label]), body]);
}

/**
 * Stringifies for display, surviving values JSON.stringify cannot handle.
 *
 * @param value - Any value
 * @returns A printable string
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A copy-to-clipboard button.
 *
 * @param text - What to copy, or a function returning it
 * @param label - Button label
 * @returns The button
 */
export function copyButton(text: string | (() => string), label = "Copy"): HTMLElement {
  const button = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, [label]);
  button.addEventListener("click", async () => {
    const value = typeof text === "function" ? text() : text;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Press Ctrl+C";
    }
    setTimeout(() => { button.textContent = label; }, 1_400);
  });
  return button;
}

/**
 * Shortens a long identifier for display, keeping both ends.
 *
 * @param value - The identifier
 * @param head - Leading characters to keep
 * @param tail - Trailing characters to keep
 * @returns The shortened form
 */
export function ellipsize(value: string, head = 10, tail = 6): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * A labelled key/value row.
 *
 * @param label - The key
 * @param value - The value, as a node or string
 * @returns The row
 */
export function field(label: string, value: Node | string): HTMLElement {
  return el("div", { class: "field" }, [
    el("span", { class: "field-label" }, [label]),
    el("span", { class: "field-value" }, [value]),
  ]);
}

/**
 * A status pill.
 *
 * @param kind - Visual state
 * @param label - Text
 * @returns The pill
 */
export function pill(kind: "ok" | "fail" | "warn" | "idle" | "run", label: string): HTMLElement {
  return el("span", { class: `pill pill-${kind}` }, [label]);
}
