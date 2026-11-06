// Send to Vibr. It reads the open file in Figma, where variables, styles,
// components and prototype links are available on every plan, and saves one
// file for Vibr to import (figma-bundle.ts). It has no network access
// (manifest.json): nothing leaves Figma except the file the designer saves.
//
// Build: npm run build. Run: Figma desktop → Plugins → Development →
// Import plugin from manifest → manifest.json.

import type {
  FigmaBundle,
  FigmaCollection,
  FigmaComponent,
  FigmaEffectStyle,
  FigmaFlow,
  FigmaFrame,
  FigmaImage,
  FigmaLink,
  FigmaTextStyle,
  FigmaTokenValue,
  FIGMA_LIMITS,
} from "./figma-bundle";

// The same limits Vibr checks on import (typed against them, so they can't
// drift; the plugin can't import values without a bundler).
const LIMITS: typeof FIGMA_LIMITS = {
  frames: 12,
  images: 12,
  imageChars: 2 * 1024 * 1024,
  imageWidth: 1200,
  components: 80,
  variables: 1500,
  textStyles: 120,
  effectStyles: 60,
  outlineNodes: 400,
  textChars: 240,
  frameEdge: 1568,
  componentEdge: 256,
};

type Options = { tokens: boolean; components: boolean; frames: boolean; followLinks: boolean; scope: "page" | "file" };

type ToUi =
  | { type: "selection"; items: { name: string; kind: "screen" | "element" }[]; total: number; flows: number; source: "selection" | "flows" | "page" | "file" }
  | { type: "progress"; text: string }
  | { type: "done"; json: string; fileName: string; summary: string }
  | { type: "error"; text: string };

const post = (message: ToUi): void => figma.ui.postMessage(message);

// --- Values ------------------------------------------------------------------

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
const colorHex = (c: { r: number; g: number; b: number; a?: number }, opacity = 1): string => {
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`;
};
const round = (n: number): number => Math.round(n * 100) / 100;
const isAlias = (v: unknown): v is VariableAlias => Boolean(v) && typeof v === "object" && (v as VariableAlias).type === "VARIABLE_ALIAS";
const isRgb = (v: unknown): v is RGBA => Boolean(v) && typeof v === "object" && "r" in (v as object) && "g" in (v as object);

const variableNames = new Map<string, string>();
async function variableName(id: string): Promise<string> {
  const known = variableNames.get(id);
  if (known) return known;
  const v = await figma.variables.getVariableByIdAsync(id);
  const name = v ? v.name : "unknown";
  variableNames.set(id, name);
  return name;
}

// --- Tokens and styles ---------------------------------------------------------

async function readCollections(): Promise<FigmaCollection[]> {
  const out: FigmaCollection[] = [];
  let count = 0;
  for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
    const modes = collection.modes.map((m) => m.name);
    const modeName = new Map(collection.modes.map((m) => [m.modeId, m.name]));
    const variables: FigmaCollection["variables"] = [];
    for (const id of collection.variableIds) {
      if (count >= LIMITS.variables) break;
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) continue;
      variableNames.set(v.id, v.name);
      const values: Record<string, FigmaTokenValue> = {};
      for (const [modeId, value] of Object.entries(v.valuesByMode)) {
        const mode = modeName.get(modeId) ?? modeId;
        if (isAlias(value)) values[mode] = { alias: await variableName(value.id) };
        else if (isRgb(value)) values[mode] = colorHex(value);
        else if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") values[mode] = value;
      }
      const type = v.resolvedType === "COLOR" ? "color" : v.resolvedType === "FLOAT" ? "number" : v.resolvedType === "BOOLEAN" ? "boolean" : "string";
      variables.push({ name: v.name, type, values, scopes: v.scopes.filter((s) => s !== "ALL_SCOPES") });
      count++;
    }
    out.push({ name: collection.name, modes, variables });
  }
  return out;
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];
const weightOf = (style: string): number => WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;

async function readTextStyles(): Promise<FigmaTextStyle[]> {
  const styles = (await figma.getLocalTextStylesAsync()).slice(0, LIMITS.textStyles);
  return styles.map((s) => {
    const lh = s.lineHeight;
    const ls = s.letterSpacing;
    const textCase = s.textCase === "UPPER" ? "upper" : s.textCase === "LOWER" ? "lower" : s.textCase === "TITLE" ? "title" : undefined;
    return {
      name: s.name,
      fontFamily: s.fontName.family,
      fontStyle: s.fontName.style,
      fontWeight: weightOf(s.fontName.style),
      italic: /italic|oblique/i.test(s.fontName.style),
      fontSize: round(s.fontSize),
      lineHeight: lh.unit === "AUTO" ? null : lh.unit === "PIXELS" ? round(lh.value) : round((lh.value / 100) * s.fontSize),
      letterSpacing: ls.unit === "PIXELS" ? round(ls.value) : round((ls.value / 100) * s.fontSize),
      ...(textCase ? { textCase } : {}),
    };
  });
}

function shadowCss(effects: ReadonlyArray<Effect>): string {
  return effects
    .filter((e): e is DropShadowEffect | InnerShadowEffect => (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible)
    .map((e) => `${e.type === "INNER_SHADOW" ? "inset " : ""}${round(e.offset.x)}px ${round(e.offset.y)}px ${round(e.radius)}px ${round(e.spread ?? 0)}px ${colorHex(e.color)}`)
    .join(", ");
}

async function readEffectStyles(): Promise<FigmaEffectStyle[]> {
  return (await figma.getLocalEffectStylesAsync())
    .slice(0, LIMITS.effectStyles)
    .map((s) => ({ name: s.name, boxShadow: shadowCss(s.effects) }))
    .filter((s) => s.boxShadow);
}

// --- Components ------------------------------------------------------------------

async function snapshot(node: SceneNode, edge: number): Promise<string | undefined> {
  const long = Math.max(node.width, node.height);
  if (!long) return undefined;
  try {
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.min(2, edge / long) } });
    return figma.base64Encode(bytes);
  } catch {
    return undefined;
  }
}

function variantsOf(node: ComponentSetNode | ComponentNode): Record<string, string[]> | undefined {
  try {
    const defs = node.componentPropertyDefinitions;
    const out: Record<string, string[]> = {};
    for (const [key, def] of Object.entries(defs)) if (def.type === "VARIANT" && def.variantOptions) out[key] = def.variantOptions;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Components used in the exported frames first, then the file's own. */
async function readComponents(used: Map<string, ComponentNode | ComponentSetNode>, withImages: boolean): Promise<FigmaComponent[]> {
  const seen = new Set<string>();
  const nodes: (ComponentNode | ComponentSetNode)[] = [];
  const add = (n: ComponentNode | ComponentSetNode): void => {
    if (seen.has(n.id) || nodes.length >= LIMITS.components) return;
    seen.add(n.id);
    nodes.push(n);
  };
  for (const n of used.values()) add(n);
  post({ type: "progress", text: "Reading components…" });
  await figma.loadAllPagesAsync();
  // Then the file's own: sets with variants first, then larger components,
  // so a system's buttons and cards come before its hundreds of icons.
  // Names starting with _ or . are a file's private helpers.
  const local = figma.root
    .findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })
    .filter((n) => !(n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET") && !/^[_.]/.test(n.name));
  const rank = (n: ComponentNode | ComponentSetNode) => (n.type === "COMPONENT_SET" ? 0 : Math.max(n.width, n.height) > 48 ? 1 : 2);
  for (const n of local.sort((a, b) => rank(a) - rank(b))) add(n);
  const out: FigmaComponent[] = [];
  for (const n of nodes) {
    out.push({
      name: n.name,
      ...(n.description ? { description: n.description.slice(0, 400) } : {}),
      ...(variantsOf(n) ? { variants: variantsOf(n) } : {}),
      width: Math.round(n.width),
      height: Math.round(n.height),
      ...(withImages ? { image: await snapshot(n, LIMITS.componentEdge) } : {}),
    });
  }
  return out;
}

// --- Frames, outlines and links ------------------------------------------------------

const TRIGGERS: Record<string, string> = { ON_CLICK: "click", ON_HOVER: "hover", ON_PRESS: "press", ON_DRAG: "drag", ON_KEY_DOWN: "key", MOUSE_ENTER: "hover", MOUSE_UP: "click", MOUSE_DOWN: "press" };

function linksOf(node: SceneNode): { trigger: string; kind: FigmaLink["kind"]; to?: string; url?: string }[] {
  if (!("reactions" in node)) return [];
  const out: { trigger: string; kind: FigmaLink["kind"]; to?: string; url?: string }[] = [];
  for (const r of node.reactions) {
    if (!r.trigger) continue;
    const trigger = r.trigger.type === "AFTER_TIMEOUT" ? `after ${Math.round(r.trigger.timeout * 1000)}ms` : (TRIGGERS[r.trigger.type] ?? r.trigger.type.toLowerCase());
    for (const a of r.actions ?? []) {
      if (a.type === "BACK") out.push({ trigger, kind: "back" });
      else if (a.type === "CLOSE") out.push({ trigger, kind: "close" });
      else if (a.type === "URL") out.push({ trigger, kind: "url", url: a.url });
      else if (a.type === "NODE" && a.destinationId) {
        const kind = a.navigation === "OVERLAY" ? "overlay" : a.navigation === "SWAP" ? "swap" : a.navigation === "SCROLL_TO" ? "scroll" : a.navigation === "CHANGE_TO" ? null : "navigate";
        if (kind) out.push({ trigger, kind, to: a.destinationId });
      }
    }
  }
  return out;
}

/** The top-level frame a node sits in (a link's destination may be a
 *  layer inside one). */
async function topFrame(id: string): Promise<FrameNode | ComponentNode | InstanceNode | null> {
  let node = (await figma.getNodeByIdAsync(id)) as BaseNode | null;
  while (node && node.parent && node.parent.type !== "PAGE" && node.parent.type !== "SECTION") node = node.parent;
  return node && (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") ? node : null;
}

interface OutlineState {
  lines: string[];
  nodes: number;
  skipped: number;
  links: FigmaLink[];
  used: Map<string, ComponentNode | ComponentSetNode>;
  /** The frame's top left, so each text can say where it sits in it. */
  origin: { x: number; y: number };
}

/** "at 24,180": a layer's top left within the frame, for the fidelity check. */
const at = (node: SceneNode, origin: { x: number; y: number }): string | null => {
  const box = node.absoluteBoundingBox;
  if (!box) return null;
  // A text says its width, height and alignment too: centered text in a
  // wide box is checked by its center, not its box's left edge, and its
  // height with its line height says how many lines Figma wrapped it to.
  const align = node.type === "TEXT" && node.textAlignHorizontal !== "LEFT" && node.textAlignHorizontal !== "JUSTIFIED" ? ` ${node.textAlignHorizontal.toLowerCase()}` : "";
  return `at ${Math.round(box.x - origin.x)},${Math.round(box.y - origin.y)} w${Math.round(box.width)} h${Math.round(box.height)}${align}`;
};

async function boundName(node: SceneNode, field: string): Promise<string | null> {
  const bound = (node as SceneNode & { boundVariables?: Record<string, VariableAlias | VariableAlias[]> }).boundVariables?.[field];
  const alias = Array.isArray(bound) ? bound[0] : bound;
  return alias ? `{${await variableName(alias.id)}}` : null;
}

async function paintText(node: SceneNode, key: "fills" | "strokes"): Promise<string | null> {
  if (!(key in node)) return null;
  const paints = (node as SceneNode & { fills?: unknown; strokes?: unknown })[key];
  if (!Array.isArray(paints)) return null;
  const paint = (paints as Paint[]).find((p) => p.visible !== false);
  if (!paint) return null;
  if (paint.type === "SOLID") {
    const alias = paint.boundVariables?.color;
    return alias ? `{${await variableName(alias.id)}}` : colorHex(paint.color, paint.opacity ?? 1);
  }
  if (paint.type === "IMAGE") return "image";
  if (paint.type.startsWith("GRADIENT")) return "gradient";
  return null;
}

// Photos in the frames being sent, by image hash (reset per export).
const photos = new Map<string, FigmaImage>();
const slug = (s: string): string =>
  s
    .replace(/^\s*(photo|image|img)\s*[:/-]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "photo";

/** A layer filled with an image, once per image: exported as the layer
 *  shows it (cropped and scaled as in the design), as a JPEG. */
async function photoOf(node: SceneNode): Promise<string | null> {
  if (!("fills" in node) || !Array.isArray(node.fills)) return null;
  const paint = (node.fills as Paint[]).find((p): p is ImagePaint => p.type === "IMAGE" && p.visible !== false && Boolean(p.imageHash));
  if (!paint?.imageHash) return null;
  const known = photos.get(paint.imageHash);
  if (known) return known.name;
  if (photos.size >= LIMITS.images) return null;
  try {
    const width = Math.max(1, Math.min(LIMITS.imageWidth, Math.round(node.width * 2)));
    const bytes = await node.exportAsync({ format: "JPG", constraint: { type: "WIDTH", value: width } });
    const data = figma.base64Encode(bytes);
    if (data.length > LIMITS.imageChars) return null;
    let name = slug(node.name);
    const taken = new Set([...photos.values()].map((p) => p.name));
    for (let n = 2; taken.has(name); n++) name = `${slug(node.name)}-${n}`;
    const alt = node.name.replace(/^\s*(photo|image|img)\s*[:/-]\s*/i, "").trim().slice(0, 200);
    photos.set(paint.imageHash, { name, alt, data, width, height: Math.round((node.height / node.width) * width) });
    return name;
  } catch {
    return null;
  }
}

async function styleName(id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !id) return null;
  const style = await figma.getStyleByIdAsync(id);
  return style ? style.name : null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ").trim();

/** An instance's visible texts as outline lines: text, style, color. */
async function textLinesIn(node: SceneNode, max: number, origin: { x: number; y: number }): Promise<string[]> {
  if (!("findAll" in node)) return [];
  const texts = (node as FrameNode).findAll((n) => n.type === "TEXT" && n.visible).slice(0, max) as TextNode[];
  const out: string[] = [];
  for (const t of texts) {
    const style = await styleName(t.textStyleId);
    const size = typeof t.fontSize === "number" ? `${round(t.fontSize)}px` : "mixed size";
    const font = typeof t.fontName === "object" && "style" in t.fontName ? ` ${t.fontName.style}` : "";
    const fill = await paintText(t, "fills");
    const where = at(t, origin);
    out.push([`Text "${clip(t.characters, LIMITS.textChars)}"`, style ? `style ${style}` : `${size}${font}`, ...(fill ? [`color ${fill}`] : []), ...(where ? [where] : [])].join(" · "));
  }
  return out;
}

async function describe(node: SceneNode, depth: number, state: OutlineState, frameIds: Map<string, string>): Promise<void> {
  if (!node.visible) return;
  if (state.nodes >= LIMITS.outlineNodes) {
    state.skipped++;
    return;
  }
  state.nodes++;
  const parts: string[] = [];
  const w = Math.round(node.width);
  const h = Math.round(node.height);
  let recurse = "children" in node;
  let instanceTexts: string[] = [];

  if (node.type === "TEXT") {
    const style = await styleName(node.textStyleId);
    const size = typeof node.fontSize === "number" ? `${round(node.fontSize)}px` : "mixed size";
    const font = typeof node.fontName === "object" && "style" in node.fontName ? ` ${node.fontName.style}` : "";
    parts.push(`Text "${clip(node.characters, LIMITS.textChars)}"`, style ? `style ${style}` : `${size}${font}`);
    const fill = await paintText(node, "fills");
    if (fill) parts.push(`color ${fill}`);
    const where = at(node, state.origin);
    if (where) parts.push(where);
  } else if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    const set = main?.parent?.type === "COMPONENT_SET" ? main.parent : null;
    if (main) state.used.set((set ?? main).id, set ?? main);
    const props = Object.entries(node.componentProperties)
      .filter(([, p]) => p.type === "VARIANT" || p.type === "BOOLEAN" || p.type === "TEXT")
      .map(([k, p]) => `${k.replace(/#.*$/, "")}=${String(p.value)}`);
    parts.push(`${set?.name ?? main?.name ?? node.name}${props.length ? ` (${props.join(", ")})` : ""}`, `${w}×${h}`);
    // An instance is one line in a screen, with its texts under it (their
    // style and color, so Vibr can check the built page matches); sent on
    // its own, all its layers show.
    if (depth > 0) instanceTexts = await textLinesIn(node, 8, state.origin);
    recurse = depth === 0;
  } else {
    const kind = node.type === "FRAME" ? "Frame" : node.type === "GROUP" ? "Group" : node.type === "COMPONENT" ? "Component" : node.type === "RECTANGLE" ? "Rectangle" : node.type === "ELLIPSE" ? "Ellipse" : node.type === "LINE" ? "Line" : "Graphic";
    parts.push(`${kind} "${clip(node.name, 60)}"`, `${w}×${h}`);
    // Vector art (icons, illustrations) is one line, not its paths.
    if ("children" in node && node.children.length && node.children.every((c) => ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE", "LINE"].includes(c.type))) {
      parts[0] = `Graphic "${clip(node.name, 60)}"`;
      recurse = false;
    }
    if ("layoutMode" in node && node.layoutMode !== "NONE") {
      const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(Math.round);
      const gap = (await boundName(node, "itemSpacing")) ?? String(Math.round(node.itemSpacing));
      parts.push(
        `${node.layoutMode === "HORIZONTAL" ? "row" : node.layoutMode === "VERTICAL" ? "column" : "grid"}${node.layoutWrap === "WRAP" ? " wrap" : ""}, gap ${gap}, padding ${pad.every((p) => p === pad[0]) ? pad[0] : pad.join(" ")}, align ${node.primaryAxisAlignItems.toLowerCase()}/${node.counterAxisAlignItems.toLowerCase()}`
      );
    }
    const fill = await paintText(node, "fills");
    const photo = fill === "image" ? await photoOf(node) : null;
    if (photo) parts.push(`image "${photo}"`);
    else if (fill) parts.push(`fill ${fill}`);
    const stroke = await paintText(node, "strokes");
    if (stroke && "strokeWeight" in node && typeof node.strokeWeight === "number" && node.strokeWeight > 0) parts.push(`border ${node.strokeWeight}px ${stroke}`);
    if ("cornerRadius" in node && typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
      parts.push(`radius ${(await boundName(node, "topLeftRadius")) ?? Math.round(node.cornerRadius)}`);
    }
    if ("effects" in node && node.effects.length) {
      const effect = await styleName((node as FrameNode).effectStyleId);
      const css = shadowCss(node.effects);
      if (effect || css) parts.push(`shadow ${effect ?? css}`);
    }
  }
  if ("layoutSizingHorizontal" in node && depth > 0) {
    const sx = node.layoutSizingHorizontal;
    const sy = node.layoutSizingVertical;
    if (sx !== "FIXED" || sy !== "FIXED") parts.push(`size ${sx.toLowerCase()}/${sy.toLowerCase()}`);
  }
  for (const link of linksOf(node)) {
    const dest = link.to ? await topFrame(link.to) : null;
    const to = dest?.id;
    if (to) frameIds.set(to, dest!.name);
    state.links.push({ from: clip(node.name, 80), trigger: link.trigger, kind: link.kind, ...(to ? { to } : {}), ...(link.url ? { url: link.url } : {}) });
    parts.push(`on ${link.trigger} → ${link.kind}${dest ? ` "${dest.name}"` : link.url ? ` ${link.url}` : ""}`);
  }
  state.lines.push(`${"  ".repeat(depth)}${parts.join(" · ")}`);
  for (const t of instanceTexts) state.lines.push(`${"  ".repeat(depth + 1)}${t}`);
  if (recurse && "children" in node) for (const child of node.children) await describe(child, depth + 1, state, frameIds);
}

async function readFrame(node: SceneNode, kind: "screen" | "element", used: OutlineState["used"], found: Map<string, string>): Promise<FigmaFrame> {
  const box = node.absoluteBoundingBox;
  const state: OutlineState = { lines: [], nodes: 0, skipped: 0, links: [], used, origin: { x: box?.x ?? 0, y: box?.y ?? 0 } };
  await describe(node, 0, state, found);
  if (state.skipped) state.lines.push(`… ${state.skipped} more layers not listed`);
  const image = (await snapshot(node, LIMITS.frameEdge)) ?? "";
  return { id: node.id, name: node.name, ...(kind === "element" ? { kind } : {}), width: Math.round(node.width), height: Math.round(node.height), image, outline: state.lines.join("\n"), links: state.links };
}

type FrameLike = FrameNode | ComponentNode | InstanceNode;
const isFrameLike = (n: BaseNode): n is FrameLike => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE";

type Scope = "page" | "file";
type Source = "selection" | "flows" | "page" | "file";
/** What goes to Vibr: a screen (a top-level frame), or an element (a
 *  component, or any layer inside a frame), built on its own. */
type Pick = { node: SceneNode; kind: "screen" | "element"; page?: string };

/** A set stands for its default variant (its picture and layers). */
const asNode = (n: SceneNode): SceneNode => (n.type === "COMPONENT_SET" ? (n.defaultVariant ?? n) : n);
const isTop = (n: BaseNode): boolean => n.parent?.type === "PAGE" || n.parent?.type === "SECTION";

/** Screens on a page when nothing is chosen: plain frames 200px or larger
 *  and large components (a system's page templates, like Examples/Home),
 *  not helpers named with _ or . ; names that sound like screens first. */
function pageScreens(page: PageNode): SceneNode[] {
  const tops = page.children.flatMap((n) => (n.type === "SECTION" ? [...n.children] : [n]));
  const screens = tops.filter((n) => {
    if (/^[_.]/.test(n.name)) return false;
    if (n.type === "FRAME") return n.width >= 200 && n.height >= 200;
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") return asNode(n).width >= 600 && asNode(n).height >= 400;
    return false;
  });
  const score = (n: SceneNode) => (/example|template|screen|page|landing|home|dashboard|checkout|flow/i.test(n.name) ? 0 : 1) + (n.height >= 600 ? 0 : 1);
  return screens.sort((a, b) => score(a) - score(b) || a.absoluteBoundingBox!.y - b.absoluteBoundingBox!.y || a.absoluteBoundingBox!.x - b.absoluteBoundingBox!.x);
}

/** The page's choice: what's selected (a section is its frames, a
 *  top-level frame a screen, anything else an element); with nothing
 *  selected, the starts of its prototype flows, or else its screens. */
async function pagePicks(page: PageNode, useSelection: boolean): Promise<{ picks: Pick[]; flows: FigmaFlow[]; source: Source }> {
  const picks: Pick[] = [];
  const selected = useSelection && page.selection.length > 0;
  if (selected) {
    for (const n of page.selection) {
      if (n.type === "SECTION") picks.push(...n.children.filter((c) => c.type === "FRAME").map((c) => ({ node: c, kind: "screen" as const })));
      else if (n.type === "FRAME" && isTop(n)) picks.push({ node: n, kind: "screen" });
      else picks.push({ node: n, kind: "element" });
    }
  }
  const flows: FigmaFlow[] = [];
  for (const f of page.flowStartingPoints) {
    const node = await figma.getNodeByIdAsync(f.nodeId);
    if (node && isFrameLike(node)) {
      flows.push({ name: f.name, start: node.id });
      if (!selected) picks.push({ node, kind: "screen" });
    }
  }
  let source: Source = selected ? "selection" : "flows";
  if (!selected && !picks.length) {
    source = "page";
    picks.push(...pageScreens(page).map((node) => ({ node, kind: "screen" as const })));
  }
  const unique = [...new Map(picks.map((p) => [p.node.id, p])).values()];
  return { picks: unique, flows: flows.filter((f) => !selected || unique.some((u) => u.node.id === f.start)), source };
}

/** From this page (or its selection), or from the whole file: each page's
 *  flows, or else its screens, page by page, until the limit. Cover,
 *  thumbnail and divider pages are skipped. */
async function startingPicks(scope: Scope): Promise<{ picks: Pick[]; flows: FigmaFlow[]; source: Source }> {
  if (scope === "page") return pagePicks(figma.currentPage, true);
  const picks: Pick[] = [];
  const flows: FigmaFlow[] = [];
  for (const page of figma.root.children) {
    if (/^\s*(cover|thumbnail|[-–—_*=\s]+$)/i.test(page.name)) continue;
    if (picks.length >= LIMITS.frames) break;
    await page.loadAsync();
    const found = await pagePicks(page, false);
    picks.push(...found.picks.slice(0, LIMITS.frames - picks.length).map((p) => ({ ...p, page: page.name })));
    flows.push(...found.flows.filter((fl) => picks.some((p) => p.node.id === fl.start)));
  }
  return { picks, flows, source: "file" };
}

let scope: Scope = "page";

async function selectionSummary(): Promise<void> {
  const { picks, flows, source } = await startingPicks(scope);
  post({
    type: "selection",
    items: picks.slice(0, LIMITS.frames).map((p) => ({ name: p.page ? `${p.page} / ${p.node.name}` : p.node.name, kind: p.kind })),
    total: picks.length,
    flows: flows.length,
    source,
  });
}

// --- Export ------------------------------------------------------------------------

async function exportBundle(options: Options): Promise<void> {
  const used = new Map<string, ComponentNode | ComponentSetNode>();
  const bundle: FigmaBundle = {
    format: "vibr-figma",
    version: 1,
    file: { name: figma.root.name, page: figma.currentPage.name },
    exportedAt: new Date().toISOString(),
    collections: [],
    textStyles: [],
    effectStyles: [],
    components: [],
    frames: [],
    flows: [],
  };

  photos.clear();
  if (options.frames) {
    const { picks, flows } = await startingPicks(options.scope === "file" ? "file" : "page");
    const queue: Pick[] = [...picks];
    const done = new Set<string>();
    while (queue.length && bundle.frames.length < LIMITS.frames) {
      const pick = queue.shift()!;
      const node = asNode(pick.node);
      if (done.has(pick.node.id)) continue;
      done.add(pick.node.id);
      post({ type: "progress", text: `Reading ${pick.kind} ${bundle.frames.length + 1}: ${pick.node.name}` });
      const found = new Map<string, string>();
      const frame = await readFrame(node, pick.kind, used, found);
      // A set's default variant goes under the set's own name and id.
      bundle.frames.push(
        node === pick.node ? frame : { ...frame, id: pick.node.id, name: pick.node.name, outline: `Component set "${pick.node.name}", its default variant:\n${frame.outline}` }
      );
      // Frames this one links to come along, so a flow arrives whole.
      if (options.followLinks) {
        for (const id of found.keys()) {
          if (done.has(id)) continue;
          const dest = await figma.getNodeByIdAsync(id);
          if (dest && isFrameLike(dest)) queue.push({ node: dest, kind: "screen" });
        }
      }
    }
    const ids = new Set(bundle.frames.map((f) => f.id));
    // Links to frames left out (past the limit) are dropped, not dangling.
    for (const f of bundle.frames) f.links = f.links.filter((l) => !l.to || ids.has(l.to));
    bundle.flows = flows.filter((f) => ids.has(f.start));
    bundle.images = [...photos.values()];
  }
  if (options.tokens) {
    post({ type: "progress", text: "Reading variables and styles…" });
    bundle.collections = await readCollections();
    bundle.textStyles = await readTextStyles();
    bundle.effectStyles = await readEffectStyles();
  }
  if (options.components) bundle.components = await readComponents(used, true);

  const slug = (figma.root.name || "figma").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "figma";
  const vars = bundle.collections.reduce((n, c) => n + c.variables.length, 0);
  const summary = [
    `${bundle.frames.length} frame${bundle.frames.length === 1 ? "" : "s"}`,
    `${bundle.frames.reduce((n, f) => n + f.links.length, 0)} links`,
    `${vars} variables`,
    `${bundle.textStyles.length} text styles`,
    `${bundle.images?.length ?? 0} photos`,
    `${bundle.components.length} components`,
  ].join(" · ");
  post({ type: "done", json: JSON.stringify(bundle), fileName: `${slug}.vibr-figma.json`, summary });
}

// The published build leaves the sample out (src/sample.d.ts).
if (figma.command === "sample" && typeof createKilnSample === "function") {
  // sample.ts: draws the cafe example to try this on.
  createKilnSample().then(
    (message) => figma.closePlugin(message),
    (error) => {
      console.error("Create Kiln cafe sample failed at", kilnStage, error);
      figma.closePlugin(`Couldn't create the sample (${kilnStage}): ${error instanceof Error ? error.message : String(error)}`);
    }
  );
} else {
  figma.showUI(__html__, { width: 340, height: 470, themeColors: true, title: "Send to Vibr" });
  // The whole file doesn't change with the selection.
  figma.on("selectionchange", () => void (scope === "page" && selectionSummary()));
  figma.on("currentpagechange", () => void selectionSummary());
  figma.ui.onmessage = async (message: { type: string; options?: Options; scope?: Scope }) => {
    if (message.type === "ready") await selectionSummary();
    if (message.type === "scope") {
      scope = message.scope === "file" ? "file" : "page";
      post({ type: "progress", text: scope === "file" ? "Reading the file's pages…" : "" });
      await selectionSummary();
      post({ type: "progress", text: "" });
    }
    if (message.type === "export" && message.options) {
      try {
        await exportBundle(message.options);
      } catch (error) {
        // People see a plain sentence; the details go to the plugin console.
        console.error("Send to Vibr failed", error);
        post({ type: "error", text: "Send to Vibr couldn't finish. Try sending fewer frames, or a page or selection instead of the whole file." });
      }
    }
    if (message.type === "docs") figma.openExternal("https://vibr.art/docs/import-from-figma");
    if (message.type === "close") figma.closePlugin();
  };
}
