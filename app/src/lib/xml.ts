import type { X2jOptions } from "fast-xml-parser";

/**
 * Parser options for fast-xml-parser optimized for feed parsing.
 *
 * Key customizations:
 * - Increases maxTotalExpansions from 1000 to 100,000 to handle feeds with
 *   many entities (feeds with full article content can have 3000+ entities)
 * - Keeps maxExpansionDepth at strict default (10) for billion-laughs protection
 * - Enables entity processing to handle HTML entities in feed content
 *
 * Used for parsing Medium author feeds, Fowler Atom feeds, and other sources.
 */
export const feedParserOptions: X2jOptions = {
  // Enable entity processing with relaxed expansion limits but strict depth limits
  processEntities: {
    enabled: true,
    // Increase flat expansion count for feeds with many entities
    maxTotalExpansions: 100_000,
    // Keep strict depth limit for billion-laughs attack protection
    maxExpansionDepth: 10,
  },

  // Standard parsing options for RSS/Atom feeds
  trimValues: true,
  ignoreAttributes: false,
  removeNSPrefix: false,
  parseTagValue: true,
  ignoreDeclaration: true,
};
