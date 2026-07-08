import type { X2jOptions } from "fast-xml-parser";

/**
 * Parser options for fast-xml-parser optimized for feed parsing.
 *
 * Key customizations:
 * - Caps maxTotalExpansions at 100,000. The library default is Infinity
 *   (unlimited), so this is a bound we impose — high enough for legitimate
 *   feeds (full-content feeds can carry 3000+ entities) yet finite, which is
 *   the actual billion-laughs guard together with maxExpandedLength (EntityDecoder)
 *   and the DocType entity registration limits (maxEntityCount / maxEntitySize).
 * - Enables entity processing to handle HTML entities in feed content.
 *
 * Note: maxExpansionDepth is set to 10, but in this version (fast-xml-parser 5.9.x)
 * that option is not consumed — OrderedObjParser passes only maxTotalExpansions and
 * maxExpandedLength to the EntityDecoder's limit, so the depth value has no runtime
 * effect. It is left in place (no behavior change) pending an upstream fix.
 *
 * Used for parsing Medium author feeds, Fowler Atom feeds, and other sources.
 */
export const feedParserOptions: X2jOptions = {
  // Enable entity processing with a finite total-expansion cap.
  processEntities: {
    enabled: true,
    // Bound total entity expansions (default is Infinity) — billion-laughs guard.
    maxTotalExpansions: 100_000,
    // Set but currently unused by fast-xml-parser 5.9.x (see block comment above).
    maxExpansionDepth: 10,
  },

  // Standard parsing options for RSS/Atom feeds
  trimValues: true,
  ignoreAttributes: false,
  removeNSPrefix: false,
  parseTagValue: true,
  ignoreDeclaration: true,
};
