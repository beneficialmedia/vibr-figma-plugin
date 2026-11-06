const LIMITS = {
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
const post = (message) => figma.ui.postMessage(message);
const hex2 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
const colorHex = (c, opacity = 1) => {
    var _a;
    const a = ((_a = c.a) !== null && _a !== void 0 ? _a : 1) * opacity;
    return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`;
};
const round = (n) => Math.round(n * 100) / 100;
const isAlias = (v) => Boolean(v) && typeof v === "object" && v.type === "VARIABLE_ALIAS";
const isRgb = (v) => Boolean(v) && typeof v === "object" && "r" in v && "g" in v;
const variableNames = new Map();
async function variableName(id) {
    const known = variableNames.get(id);
    if (known)
        return known;
    const v = await figma.variables.getVariableByIdAsync(id);
    const name = v ? v.name : "unknown";
    variableNames.set(id, name);
    return name;
}
async function readCollections() {
    var _a;
    const out = [];
    let count = 0;
    for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
        const modes = collection.modes.map((m) => m.name);
        const modeName = new Map(collection.modes.map((m) => [m.modeId, m.name]));
        const variables = [];
        for (const id of collection.variableIds) {
            if (count >= LIMITS.variables)
                break;
            const v = await figma.variables.getVariableByIdAsync(id);
            if (!v)
                continue;
            variableNames.set(v.id, v.name);
            const values = {};
            for (const [modeId, value] of Object.entries(v.valuesByMode)) {
                const mode = (_a = modeName.get(modeId)) !== null && _a !== void 0 ? _a : modeId;
                if (isAlias(value))
                    values[mode] = { alias: await variableName(value.id) };
                else if (isRgb(value))
                    values[mode] = colorHex(value);
                else if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
                    values[mode] = value;
            }
            const type = v.resolvedType === "COLOR" ? "color" : v.resolvedType === "FLOAT" ? "number" : v.resolvedType === "BOOLEAN" ? "boolean" : "string";
            variables.push({ name: v.name, type, values, scopes: v.scopes.filter((s) => s !== "ALL_SCOPES") });
            count++;
        }
        out.push({ name: collection.name, modes, variables });
    }
    return out;
}
const WEIGHTS = [
    [/thin|hairline/i, 100],
    [/extra ?light|ultra ?light/i, 200],
    [/light/i, 300],
    [/medium/i, 500],
    [/semi ?bold|demi ?bold/i, 600],
    [/extra ?bold|ultra ?bold/i, 800],
    [/black|heavy/i, 900],
    [/bold/i, 700],
];
const weightOf = (style) => { var _a, _b; return (_b = (_a = WEIGHTS.find(([re]) => re.test(style))) === null || _a === void 0 ? void 0 : _a[1]) !== null && _b !== void 0 ? _b : 400; };
async function readTextStyles() {
    const styles = (await figma.getLocalTextStylesAsync()).slice(0, LIMITS.textStyles);
    return styles.map((s) => {
        const lh = s.lineHeight;
        const ls = s.letterSpacing;
        const textCase = s.textCase === "UPPER" ? "upper" : s.textCase === "LOWER" ? "lower" : s.textCase === "TITLE" ? "title" : undefined;
        return Object.assign({ name: s.name, fontFamily: s.fontName.family, fontStyle: s.fontName.style, fontWeight: weightOf(s.fontName.style), italic: /italic|oblique/i.test(s.fontName.style), fontSize: round(s.fontSize), lineHeight: lh.unit === "AUTO" ? null : lh.unit === "PIXELS" ? round(lh.value) : round((lh.value / 100) * s.fontSize), letterSpacing: ls.unit === "PIXELS" ? round(ls.value) : round((ls.value / 100) * s.fontSize) }, (textCase ? { textCase } : {}));
    });
}
function shadowCss(effects) {
    return effects
        .filter((e) => (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible)
        .map((e) => { var _a; return `${e.type === "INNER_SHADOW" ? "inset " : ""}${round(e.offset.x)}px ${round(e.offset.y)}px ${round(e.radius)}px ${round((_a = e.spread) !== null && _a !== void 0 ? _a : 0)}px ${colorHex(e.color)}`; })
        .join(", ");
}
async function readEffectStyles() {
    return (await figma.getLocalEffectStylesAsync())
        .slice(0, LIMITS.effectStyles)
        .map((s) => ({ name: s.name, boxShadow: shadowCss(s.effects) }))
        .filter((s) => s.boxShadow);
}
async function snapshot(node, edge) {
    const long = Math.max(node.width, node.height);
    if (!long)
        return undefined;
    try {
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.min(2, edge / long) } });
        return figma.base64Encode(bytes);
    }
    catch (_a) {
        return undefined;
    }
}
function variantsOf(node) {
    try {
        const defs = node.componentPropertyDefinitions;
        const out = {};
        for (const [key, def] of Object.entries(defs))
            if (def.type === "VARIANT" && def.variantOptions)
                out[key] = def.variantOptions;
        return Object.keys(out).length ? out : undefined;
    }
    catch (_a) {
        return undefined;
    }
}
async function readComponents(used, withImages) {
    const seen = new Set();
    const nodes = [];
    const add = (n) => {
        if (seen.has(n.id) || nodes.length >= LIMITS.components)
            return;
        seen.add(n.id);
        nodes.push(n);
    };
    for (const n of used.values())
        add(n);
    post({ type: "progress", text: "Reading components…" });
    await figma.loadAllPagesAsync();
    const local = figma.root
        .findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })
        .filter((n) => { var _a; return !(n.type === "COMPONENT" && ((_a = n.parent) === null || _a === void 0 ? void 0 : _a.type) === "COMPONENT_SET") && !/^[_.]/.test(n.name); });
    const rank = (n) => (n.type === "COMPONENT_SET" ? 0 : Math.max(n.width, n.height) > 48 ? 1 : 2);
    for (const n of local.sort((a, b) => rank(a) - rank(b)))
        add(n);
    const out = [];
    for (const n of nodes) {
        out.push(Object.assign(Object.assign(Object.assign(Object.assign({ name: n.name }, (n.description ? { description: n.description.slice(0, 400) } : {})), (variantsOf(n) ? { variants: variantsOf(n) } : {})), { width: Math.round(n.width), height: Math.round(n.height) }), (withImages ? { image: await snapshot(n, LIMITS.componentEdge) } : {})));
    }
    return out;
}
const TRIGGERS = { ON_CLICK: "click", ON_HOVER: "hover", ON_PRESS: "press", ON_DRAG: "drag", ON_KEY_DOWN: "key", MOUSE_ENTER: "hover", MOUSE_UP: "click", MOUSE_DOWN: "press" };
function linksOf(node) {
    var _a, _b;
    if (!("reactions" in node))
        return [];
    const out = [];
    for (const r of node.reactions) {
        if (!r.trigger)
            continue;
        const trigger = r.trigger.type === "AFTER_TIMEOUT" ? `after ${Math.round(r.trigger.timeout * 1000)}ms` : ((_a = TRIGGERS[r.trigger.type]) !== null && _a !== void 0 ? _a : r.trigger.type.toLowerCase());
        for (const a of (_b = r.actions) !== null && _b !== void 0 ? _b : []) {
            if (a.type === "BACK")
                out.push({ trigger, kind: "back" });
            else if (a.type === "CLOSE")
                out.push({ trigger, kind: "close" });
            else if (a.type === "URL")
                out.push({ trigger, kind: "url", url: a.url });
            else if (a.type === "NODE" && a.destinationId) {
                const kind = a.navigation === "OVERLAY" ? "overlay" : a.navigation === "SWAP" ? "swap" : a.navigation === "SCROLL_TO" ? "scroll" : a.navigation === "CHANGE_TO" ? null : "navigate";
                if (kind)
                    out.push({ trigger, kind, to: a.destinationId });
            }
        }
    }
    return out;
}
async function topFrame(id) {
    let node = (await figma.getNodeByIdAsync(id));
    while (node && node.parent && node.parent.type !== "PAGE" && node.parent.type !== "SECTION")
        node = node.parent;
    return node && (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") ? node : null;
}
const at = (node, origin) => {
    const box = node.absoluteBoundingBox;
    if (!box)
        return null;
    const align = node.type === "TEXT" && node.textAlignHorizontal !== "LEFT" && node.textAlignHorizontal !== "JUSTIFIED" ? ` ${node.textAlignHorizontal.toLowerCase()}` : "";
    return `at ${Math.round(box.x - origin.x)},${Math.round(box.y - origin.y)} w${Math.round(box.width)} h${Math.round(box.height)}${align}`;
};
async function boundName(node, field) {
    var _a;
    const bound = (_a = node.boundVariables) === null || _a === void 0 ? void 0 : _a[field];
    const alias = Array.isArray(bound) ? bound[0] : bound;
    return alias ? `{${await variableName(alias.id)}}` : null;
}
async function paintText(node, key) {
    var _a, _b;
    if (!(key in node))
        return null;
    const paints = node[key];
    if (!Array.isArray(paints))
        return null;
    const paint = paints.find((p) => p.visible !== false);
    if (!paint)
        return null;
    if (paint.type === "SOLID") {
        const alias = (_a = paint.boundVariables) === null || _a === void 0 ? void 0 : _a.color;
        return alias ? `{${await variableName(alias.id)}}` : colorHex(paint.color, (_b = paint.opacity) !== null && _b !== void 0 ? _b : 1);
    }
    if (paint.type === "IMAGE")
        return "image";
    if (paint.type.startsWith("GRADIENT"))
        return "gradient";
    return null;
}
const photos = new Map();
const slug = (s) => s
    .replace(/^\s*(photo|image|img)\s*[:/-]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "photo";
async function photoOf(node) {
    if (!("fills" in node) || !Array.isArray(node.fills))
        return null;
    const paint = node.fills.find((p) => p.type === "IMAGE" && p.visible !== false && Boolean(p.imageHash));
    if (!(paint === null || paint === void 0 ? void 0 : paint.imageHash))
        return null;
    const known = photos.get(paint.imageHash);
    if (known)
        return known.name;
    if (photos.size >= LIMITS.images)
        return null;
    try {
        const width = Math.max(1, Math.min(LIMITS.imageWidth, Math.round(node.width * 2)));
        const bytes = await node.exportAsync({ format: "JPG", constraint: { type: "WIDTH", value: width } });
        const data = figma.base64Encode(bytes);
        if (data.length > LIMITS.imageChars)
            return null;
        let name = slug(node.name);
        const taken = new Set([...photos.values()].map((p) => p.name));
        for (let n = 2; taken.has(name); n++)
            name = `${slug(node.name)}-${n}`;
        const alt = node.name.replace(/^\s*(photo|image|img)\s*[:/-]\s*/i, "").trim().slice(0, 200);
        photos.set(paint.imageHash, { name, alt, data, width, height: Math.round((node.height / node.width) * width) });
        return name;
    }
    catch (_a) {
        return null;
    }
}
async function styleName(id) {
    if (typeof id !== "string" || !id)
        return null;
    const style = await figma.getStyleByIdAsync(id);
    return style ? style.name : null;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ").trim();
async function textLinesIn(node, max, origin) {
    if (!("findAll" in node))
        return [];
    const texts = node.findAll((n) => n.type === "TEXT" && n.visible).slice(0, max);
    const out = [];
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
async function describe(node, depth, state, frameIds) {
    var _a, _b, _c, _d, _e;
    if (!node.visible)
        return;
    if (state.nodes >= LIMITS.outlineNodes) {
        state.skipped++;
        return;
    }
    state.nodes++;
    const parts = [];
    const w = Math.round(node.width);
    const h = Math.round(node.height);
    let recurse = "children" in node;
    let instanceTexts = [];
    if (node.type === "TEXT") {
        const style = await styleName(node.textStyleId);
        const size = typeof node.fontSize === "number" ? `${round(node.fontSize)}px` : "mixed size";
        const font = typeof node.fontName === "object" && "style" in node.fontName ? ` ${node.fontName.style}` : "";
        parts.push(`Text "${clip(node.characters, LIMITS.textChars)}"`, style ? `style ${style}` : `${size}${font}`);
        const fill = await paintText(node, "fills");
        if (fill)
            parts.push(`color ${fill}`);
        const where = at(node, state.origin);
        if (where)
            parts.push(where);
    }
    else if (node.type === "INSTANCE") {
        const main = await node.getMainComponentAsync();
        const set = ((_a = main === null || main === void 0 ? void 0 : main.parent) === null || _a === void 0 ? void 0 : _a.type) === "COMPONENT_SET" ? main.parent : null;
        if (main)
            state.used.set((set !== null && set !== void 0 ? set : main).id, set !== null && set !== void 0 ? set : main);
        const props = Object.entries(node.componentProperties)
            .filter(([, p]) => p.type === "VARIANT" || p.type === "BOOLEAN" || p.type === "TEXT")
            .map(([k, p]) => `${k.replace(/#.*$/, "")}=${String(p.value)}`);
        parts.push(`${(_c = (_b = set === null || set === void 0 ? void 0 : set.name) !== null && _b !== void 0 ? _b : main === null || main === void 0 ? void 0 : main.name) !== null && _c !== void 0 ? _c : node.name}${props.length ? ` (${props.join(", ")})` : ""}`, `${w}×${h}`);
        if (depth > 0)
            instanceTexts = await textLinesIn(node, 8, state.origin);
        recurse = depth === 0;
    }
    else {
        const kind = node.type === "FRAME" ? "Frame" : node.type === "GROUP" ? "Group" : node.type === "COMPONENT" ? "Component" : node.type === "RECTANGLE" ? "Rectangle" : node.type === "ELLIPSE" ? "Ellipse" : node.type === "LINE" ? "Line" : "Graphic";
        parts.push(`${kind} "${clip(node.name, 60)}"`, `${w}×${h}`);
        if ("children" in node && node.children.length && node.children.every((c) => ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE", "LINE"].includes(c.type))) {
            parts[0] = `Graphic "${clip(node.name, 60)}"`;
            recurse = false;
        }
        if ("layoutMode" in node && node.layoutMode !== "NONE") {
            const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(Math.round);
            const gap = (_d = (await boundName(node, "itemSpacing"))) !== null && _d !== void 0 ? _d : String(Math.round(node.itemSpacing));
            parts.push(`${node.layoutMode === "HORIZONTAL" ? "row" : node.layoutMode === "VERTICAL" ? "column" : "grid"}${node.layoutWrap === "WRAP" ? " wrap" : ""}, gap ${gap}, padding ${pad.every((p) => p === pad[0]) ? pad[0] : pad.join(" ")}, align ${node.primaryAxisAlignItems.toLowerCase()}/${node.counterAxisAlignItems.toLowerCase()}`);
        }
        const fill = await paintText(node, "fills");
        const photo = fill === "image" ? await photoOf(node) : null;
        if (photo)
            parts.push(`image "${photo}"`);
        else if (fill)
            parts.push(`fill ${fill}`);
        const stroke = await paintText(node, "strokes");
        if (stroke && "strokeWeight" in node && typeof node.strokeWeight === "number" && node.strokeWeight > 0)
            parts.push(`border ${node.strokeWeight}px ${stroke}`);
        if ("cornerRadius" in node && typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
            parts.push(`radius ${(_e = (await boundName(node, "topLeftRadius"))) !== null && _e !== void 0 ? _e : Math.round(node.cornerRadius)}`);
        }
        if ("effects" in node && node.effects.length) {
            const effect = await styleName(node.effectStyleId);
            const css = shadowCss(node.effects);
            if (effect || css)
                parts.push(`shadow ${effect !== null && effect !== void 0 ? effect : css}`);
        }
    }
    if ("layoutSizingHorizontal" in node && depth > 0) {
        const sx = node.layoutSizingHorizontal;
        const sy = node.layoutSizingVertical;
        if (sx !== "FIXED" || sy !== "FIXED")
            parts.push(`size ${sx.toLowerCase()}/${sy.toLowerCase()}`);
    }
    for (const link of linksOf(node)) {
        const dest = link.to ? await topFrame(link.to) : null;
        const to = dest === null || dest === void 0 ? void 0 : dest.id;
        if (to)
            frameIds.set(to, dest.name);
        state.links.push(Object.assign(Object.assign({ from: clip(node.name, 80), trigger: link.trigger, kind: link.kind }, (to ? { to } : {})), (link.url ? { url: link.url } : {})));
        parts.push(`on ${link.trigger} → ${link.kind}${dest ? ` "${dest.name}"` : link.url ? ` ${link.url}` : ""}`);
    }
    state.lines.push(`${"  ".repeat(depth)}${parts.join(" · ")}`);
    for (const t of instanceTexts)
        state.lines.push(`${"  ".repeat(depth + 1)}${t}`);
    if (recurse && "children" in node)
        for (const child of node.children)
            await describe(child, depth + 1, state, frameIds);
}
async function readFrame(node, kind, used, found) {
    var _a, _b, _c;
    const box = node.absoluteBoundingBox;
    const state = { lines: [], nodes: 0, skipped: 0, links: [], used, origin: { x: (_a = box === null || box === void 0 ? void 0 : box.x) !== null && _a !== void 0 ? _a : 0, y: (_b = box === null || box === void 0 ? void 0 : box.y) !== null && _b !== void 0 ? _b : 0 } };
    await describe(node, 0, state, found);
    if (state.skipped)
        state.lines.push(`… ${state.skipped} more layers not listed`);
    const image = (_c = (await snapshot(node, LIMITS.frameEdge))) !== null && _c !== void 0 ? _c : "";
    return Object.assign(Object.assign({ id: node.id, name: node.name }, (kind === "element" ? { kind } : {})), { width: Math.round(node.width), height: Math.round(node.height), image, outline: state.lines.join("\n"), links: state.links });
}
const isFrameLike = (n) => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE";
const asNode = (n) => { var _a; return (n.type === "COMPONENT_SET" ? ((_a = n.defaultVariant) !== null && _a !== void 0 ? _a : n) : n); };
const isTop = (n) => { var _a, _b; return ((_a = n.parent) === null || _a === void 0 ? void 0 : _a.type) === "PAGE" || ((_b = n.parent) === null || _b === void 0 ? void 0 : _b.type) === "SECTION"; };
function pageScreens(page) {
    const tops = page.children.flatMap((n) => (n.type === "SECTION" ? [...n.children] : [n]));
    const screens = tops.filter((n) => {
        if (/^[_.]/.test(n.name))
            return false;
        if (n.type === "FRAME")
            return n.width >= 200 && n.height >= 200;
        if (n.type === "COMPONENT" || n.type === "COMPONENT_SET")
            return asNode(n).width >= 600 && asNode(n).height >= 400;
        return false;
    });
    const score = (n) => (/example|template|screen|page|landing|home|dashboard|checkout|flow/i.test(n.name) ? 0 : 1) + (n.height >= 600 ? 0 : 1);
    return screens.sort((a, b) => score(a) - score(b) || a.absoluteBoundingBox.y - b.absoluteBoundingBox.y || a.absoluteBoundingBox.x - b.absoluteBoundingBox.x);
}
async function pagePicks(page, useSelection) {
    const picks = [];
    const selected = useSelection && page.selection.length > 0;
    if (selected) {
        for (const n of page.selection) {
            if (n.type === "SECTION")
                picks.push(...n.children.filter((c) => c.type === "FRAME").map((c) => ({ node: c, kind: "screen" })));
            else if (n.type === "FRAME" && isTop(n))
                picks.push({ node: n, kind: "screen" });
            else
                picks.push({ node: n, kind: "element" });
        }
    }
    const flows = [];
    for (const f of page.flowStartingPoints) {
        const node = await figma.getNodeByIdAsync(f.nodeId);
        if (node && isFrameLike(node)) {
            flows.push({ name: f.name, start: node.id });
            if (!selected)
                picks.push({ node, kind: "screen" });
        }
    }
    let source = selected ? "selection" : "flows";
    if (!selected && !picks.length) {
        source = "page";
        picks.push(...pageScreens(page).map((node) => ({ node, kind: "screen" })));
    }
    const unique = [...new Map(picks.map((p) => [p.node.id, p])).values()];
    return { picks: unique, flows: flows.filter((f) => !selected || unique.some((u) => u.node.id === f.start)), source };
}
async function startingPicks(scope) {
    if (scope === "page")
        return pagePicks(figma.currentPage, true);
    const picks = [];
    const flows = [];
    for (const page of figma.root.children) {
        if (/^\s*(cover|thumbnail|[-–—_*=\s]+$)/i.test(page.name))
            continue;
        if (picks.length >= LIMITS.frames)
            break;
        await page.loadAsync();
        const found = await pagePicks(page, false);
        picks.push(...found.picks.slice(0, LIMITS.frames - picks.length).map((p) => (Object.assign(Object.assign({}, p), { page: page.name }))));
        flows.push(...found.flows.filter((fl) => picks.some((p) => p.node.id === fl.start)));
    }
    return { picks, flows, source: "file" };
}
let scope = "page";
async function selectionSummary() {
    const { picks, flows, source } = await startingPicks(scope);
    post({
        type: "selection",
        items: picks.slice(0, LIMITS.frames).map((p) => ({ name: p.page ? `${p.page} / ${p.node.name}` : p.node.name, kind: p.kind })),
        total: picks.length,
        flows: flows.length,
        source,
    });
}
async function exportBundle(options) {
    var _a, _b;
    const used = new Map();
    const bundle = {
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
        const queue = [...picks];
        const done = new Set();
        while (queue.length && bundle.frames.length < LIMITS.frames) {
            const pick = queue.shift();
            const node = asNode(pick.node);
            if (done.has(pick.node.id))
                continue;
            done.add(pick.node.id);
            post({ type: "progress", text: `Reading ${pick.kind} ${bundle.frames.length + 1}: ${pick.node.name}` });
            const found = new Map();
            const frame = await readFrame(node, pick.kind, used, found);
            bundle.frames.push(node === pick.node ? frame : Object.assign(Object.assign({}, frame), { id: pick.node.id, name: pick.node.name, outline: `Component set "${pick.node.name}", its default variant:\n${frame.outline}` }));
            if (options.followLinks) {
                for (const id of found.keys()) {
                    if (done.has(id))
                        continue;
                    const dest = await figma.getNodeByIdAsync(id);
                    if (dest && isFrameLike(dest))
                        queue.push({ node: dest, kind: "screen" });
                }
            }
        }
        const ids = new Set(bundle.frames.map((f) => f.id));
        for (const f of bundle.frames)
            f.links = f.links.filter((l) => !l.to || ids.has(l.to));
        bundle.flows = flows.filter((f) => ids.has(f.start));
        bundle.images = [...photos.values()];
    }
    if (options.tokens) {
        post({ type: "progress", text: "Reading variables and styles…" });
        bundle.collections = await readCollections();
        bundle.textStyles = await readTextStyles();
        bundle.effectStyles = await readEffectStyles();
    }
    if (options.components)
        bundle.components = await readComponents(used, true);
    const slug = (figma.root.name || "figma").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "figma";
    const vars = bundle.collections.reduce((n, c) => n + c.variables.length, 0);
    const summary = [
        `${bundle.frames.length} frame${bundle.frames.length === 1 ? "" : "s"}`,
        `${bundle.frames.reduce((n, f) => n + f.links.length, 0)} links`,
        `${vars} variables`,
        `${bundle.textStyles.length} text styles`,
        `${(_b = (_a = bundle.images) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0} photos`,
        `${bundle.components.length} components`,
    ].join(" · ");
    post({ type: "done", json: JSON.stringify(bundle), fileName: `${slug}.vibr-figma.json`, summary });
}
if (figma.command === "sample" && typeof createKilnSample === "function") {
    createKilnSample().then((message) => figma.closePlugin(message), (error) => {
        console.error("Create Kiln cafe sample failed at", kilnStage, error);
        figma.closePlugin(`Couldn't create the sample (${kilnStage}): ${error instanceof Error ? error.message : String(error)}`);
    });
}
else {
    figma.showUI(__html__, { width: 340, height: 470, themeColors: true, title: "Send to Vibr" });
    figma.on("selectionchange", () => void (scope === "page" && selectionSummary()));
    figma.on("currentpagechange", () => void selectionSummary());
    figma.ui.onmessage = async (message) => {
        if (message.type === "ready")
            await selectionSummary();
        if (message.type === "scope") {
            scope = message.scope === "file" ? "file" : "page";
            post({ type: "progress", text: scope === "file" ? "Reading the file's pages…" : "" });
            await selectionSummary();
            post({ type: "progress", text: "" });
        }
        if (message.type === "export" && message.options) {
            try {
                await exportBundle(message.options);
            }
            catch (error) {
                console.error("Send to Vibr failed", error);
                post({ type: "error", text: "Send to Vibr couldn't finish. Try sending fewer frames, or a page or selection instead of the whole file." });
            }
        }
        if (message.type === "docs")
            figma.openExternal("https://vibr.art/docs/import-from-figma");
        if (message.type === "close")
            figma.closePlugin();
    };
}
