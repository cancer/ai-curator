/**
 * Medium 著者 feed (https://medium.com/feed/@author) を模した合成 RSS（すべて架空）。
 *
 * 形式のみ本物を模す:
 * - content 名前空間宣言と <content:encoded> に本文全文（CDATA + HTML）
 * - <description> に CDATA の HTML スニペット
 * - <link> に Medium 特有の ?source=rss---... トラッキングパラメータ
 * - pubDate は RFC 2822
 * 文章・URL・著者名はすべて架空。
 */
export const mediumAuthorFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Fictional Author on Imaginary Topics</title>
    <link>https://medium.com/@madeup</link>
    <item>
      <title>Why My Pretend Cache Never Warms Up</title>
      <link>https://medium.com/@madeup/pretend-cache-9f8e7d6c5b4a?source=rss-1a2b3c4d----imagination</link>
      <guid isPermaLink="false">https://medium.com/p/9f8e7d6c5b4a</guid>
      <pubDate>Mon, 07 Jul 2025 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>A short made-up summary about a cache that refuses to cooperate.</p>]]></description>
      <content:encoded><![CDATA[<h1>Why My Pretend Cache Never Warms Up</h1><p>First fictional paragraph about warming strategies.</p><p>Second fictional paragraph with a &amp; ampersand and a &lt;tag&gt;.</p>]]></content:encoded>
    </item>
    <item>
      <title>Refactoring the Nonexistent Scheduler</title>
      <link>https://medium.com/@madeup/nonexistent-scheduler-1122334455?source=rss-1a2b3c4d----imagination</link>
      <guid isPermaLink="false">https://medium.com/p/1122334455</guid>
      <pubDate>Wed, 02 Jul 2025 08:15:00 GMT</pubDate>
      <description><![CDATA[<p>Another invented teaser paragraph.</p>]]></description>
      <content:encoded><![CDATA[<p>Only paragraph of the invented article body.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
