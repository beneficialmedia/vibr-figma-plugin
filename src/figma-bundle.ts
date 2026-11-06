// The file the Send to Vibr plugin saves and Vibr imports.
// Figma's REST API gives variables only on Enterprise plans and its MCP
// server only to listed apps, so the plugin reads the file in Figma (any
// plan) and the designer carries the result to Vibr as one JSON file.
//
// Types only: the plugin (code.ts) writes this shape and Vibr reads it,
// checking every field, because a file can say anything.

export const FIGMA_BUNDLE_FORMAT = "vibr-figma";
export const FIGMA_BUNDLE_VERSION = 1;

/** A variable's value in one mode: a color as #rrggbb or #rrggbbaa, a
 *  number, a string, a boolean, or another variable by name. */
export type FigmaTokenValue = string | number | boolean | { alias: string };

export interface FigmaVariable {
  /** "color/brand/500", as Figma names it with slashes. */
  name: string;
  type: "color" | "number" | "string" | "boolean";
  /** By mode name ("Light", "Dark"). */
  values: Record<string, FigmaTokenValue>;
  /** Figma's scopes ("CORNER_RADIUS", "GAP", "FONT_SIZE"…), which say what
   *  a number is for. */
  scopes?: string[];
}

export interface FigmaCollection {
  name: string;
  modes: string[];
  variables: FigmaVariable[];
}

export interface FigmaTextStyle {
  /** "Heading/H1" */
  name: string;
  fontFamily: string;
  /** "Semi Bold Italic", as Figma names the font's style. */
  fontStyle: string;
  fontWeight: number;
  italic: boolean;
  /** Pixels. */
  fontSize: number;
  /** Pixels, or null for auto. */
  lineHeight: number | null;
  /** Pixels. */
  letterSpacing: number;
  textCase?: "upper" | "lower" | "title";
}

export interface FigmaEffectStyle {
  name: string;
  /** CSS box-shadow, from the style's drop and inner shadows. */
  boxShadow: string;
}

export interface FigmaComponent {
  name: string;
  description?: string;
  /** Variant properties and their options: { Size: ["Small", "Large"] }. */
  variants?: Record<string, string[]>;
  width: number;
  height: number;
  /** A small PNG, base64 without the data: prefix. */
  image?: string;
}

export interface FigmaLink {
  /** The layer that starts it, by name ("Button / Pay now"). */
  from: string;
  /** "click", "hover", "press", "drag", "after 800ms", "key". */
  trigger: string;
  kind: "navigate" | "overlay" | "swap" | "scroll" | "back" | "close" | "url";
  /** For navigate, overlay and swap: the frame's id in this bundle. */
  to?: string;
  /** For url. */
  url?: string;
}

export interface FigmaFrame {
  /** Figma's node id. */
  id: string;
  name: string;
  /** A screen (a top-level frame, the default) or an element: a component
   *  or a layer inside a frame, built on its own. */
  kind?: "screen" | "element";
  width: number;
  height: number;
  /** PNG, base64 without the data: prefix, scaled so its long edge fits
   *  what the models read. */
  image: string;
  /** The layer tree as indented text: layout, text, components and the
   *  tokens each layer uses. */
  outline: string;
  links: FigmaLink[];
}

/** A photo (an image fill) from the frames, so Vibr can use the real
 *  picture: the outline names it as image "<name>". */
export interface FigmaImage {
  /** A slug from its layer's name: "latte-pour". */
  name: string;
  /** Its layer's name, for alt text. */
  alt: string;
  /** JPEG, base64 without the data: prefix. */
  data: string;
  width: number;
  height: number;
}

export interface FigmaFlow {
  name: string;
  /** The frame it starts on. */
  start: string;
}

export interface FigmaBundle {
  format: typeof FIGMA_BUNDLE_FORMAT;
  version: typeof FIGMA_BUNDLE_VERSION;
  file: { name: string; page: string };
  exportedAt: string;
  collections: FigmaCollection[];
  textStyles: FigmaTextStyle[];
  effectStyles: FigmaEffectStyle[];
  components: FigmaComponent[];
  frames: FigmaFrame[];
  flows: FigmaFlow[];
  /** Photos used in the frames (files from older plugin builds have none). */
  images?: FigmaImage[];
}

/** What the plugin takes, at most. Vibr checks the same limits. */
export const FIGMA_LIMITS = {
  frames: 12,
  /** Photos, and the base64 size of one. */
  images: 12,
  imageChars: 2 * 1024 * 1024,
  /** A photo's width in pixels. */
  imageWidth: 1200,
  components: 80,
  variables: 1500,
  textStyles: 120,
  effectStyles: 60,
  /** Layers per frame outline; the rest are summarized. */
  outlineNodes: 400,
  /** Characters of one text layer kept in the outline. */
  textChars: 240,
  /** A frame image's long edge in pixels (what Claude reads). */
  frameEdge: 1568,
  /** A component snapshot's long edge. */
  componentEdge: 256,
} as const;
