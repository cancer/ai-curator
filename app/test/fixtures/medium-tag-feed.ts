/**
 * Medium タグ feed (https://medium.com/feed/tag/{tag}) を模した合成 RSS（すべて架空）。
 *
 * タグ feed は <description> のスニペットのみで <content:encoded> を持たない。
 * 文章・URL・著者名はすべて架空。
 */
export const mediumTagFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Imaginary tag feed</title>
    <link>https://medium.com/tag/madeuptag</link>
    <item>
      <title>Five Fictional Lessons From a Fake Outage</title>
      <link>https://medium.com/@someone/fake-outage-aabbccdd?source=rss-tag----madeuptag</link>
      <guid isPermaLink="false">https://medium.com/p/aabbccdd</guid>
      <pubDate>Sun, 06 Jul 2025 18:45:00 GMT</pubDate>
      <description><![CDATA[<p>A fabricated snippet describing lessons from an outage that never happened.</p>]]></description>
    </item>
  </channel>
</rss>`;
