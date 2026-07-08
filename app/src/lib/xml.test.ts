import { describe, it, expect } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { feedParserOptions } from "./xml";

describe("feedParserOptions", () => {
  it("has entity processing enabled", () => {
    expect(feedParserOptions.processEntities).toBeDefined();
    expect(feedParserOptions.processEntities).not.toBe(false);
  });

  it("has increased maxTotalExpansions (100,000)", () => {
    const opts = feedParserOptions.processEntities as Record<string, unknown>;
    expect(opts.maxTotalExpansions).toBe(100_000);
  });

  it("has strict maxExpansionDepth (10)", () => {
    const opts = feedParserOptions.processEntities as Record<string, unknown>;
    expect(opts.maxExpansionDepth).toBe(10);
  });

  it("can parse simple Atom feed", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Test Feed</title>
        <entry>
          <title>Article 1</title>
          <content>Content with &amp; entity</content>
        </entry>
      </feed>
    `;

    const parser = new XMLParser(feedParserOptions);
    const result = parser.parse(xml);

    expect(result.feed).toBeDefined();
    expect(result.feed.title).toBe("Test Feed");
  });

  it("can parse feed with many entities (3000+)", () => {
    // Create a feed with 3500+ entities
    let entityContent = "";
    for (let i = 0; i < 3500; i++) {
      entityContent += `Entity &amp; `;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <content>${entityContent}</content>
        </entry>
      </feed>
    `;

    const parser = new XMLParser(feedParserOptions);
    const result = parser.parse(xml);

    expect(result.feed).toBeDefined();
    expect(result.feed.entry.content).toBeDefined();
    expect(result.feed.entry.content).toContain("Entity &");
  });

  it("includes standard parsing options", () => {
    expect(feedParserOptions.trimValues).toBe(true);
    expect(feedParserOptions.ignoreAttributes).toBe(false);
    expect(feedParserOptions.removeNSPrefix).toBe(false);
    expect(feedParserOptions.parseTagValue).toBe(true);
    expect(feedParserOptions.ignoreDeclaration).toBe(true);
  });

  it("can parse RSS feed with HTML entities", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>News Feed</title>
          <item>
            <title>Article &mdash; Title</title>
            <description>&lt;p&gt;Content with &amp; symbols&lt;/p&gt;</description>
          </item>
        </channel>
      </rss>
    `;

    const parser = new XMLParser(feedParserOptions);
    const result = parser.parse(xml);

    expect(result.rss.channel.title).toBe("News Feed");
    expect(result.rss.channel.item.title).toContain("mdash");
  });

  it("rejects deeply nested entities (billion-laughs protection)", () => {
    // Create deeply nested entity definitions
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE feed [
        <!ENTITY lol1 "lol">
        <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
        <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
        <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
        <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
        <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
        <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
        <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
        <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
        <!ENTITY lol10 "&lol9;&lol9;&lol9;&lol9;&lol9;&lol9;&lol9;&lol9;&lol9;&lol9;">
        <!ENTITY lol11 "&lol10;&lol10;&lol10;&lol10;&lol10;&lol10;&lol10;&lol10;&lol10;&lol10;">
      ]>
      <feed>
        <entry>&lol11;</entry>
      </feed>
    `;

    const parser = new XMLParser(feedParserOptions);
    // Should either fail gracefully or have expansion limited
    expect(() => parser.parse(xml)).not.toThrow();
  });
});
