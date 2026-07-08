/**
 * martinfowler.com Atom feed (https://martinfowler.com/feed.atom) を模した
 * 合成データ（すべて架空）。
 *
 * 形式のみ本物を模す:
 * - Atom entry / <link href>（rel 違いの複数 link と、単一 link の両方）
 * - <updated>（ISO）/ <content type="html"> にエスケープ済み HTML
 * 文章・URL・著者名はすべて架空。
 */
export const fowlerFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Imaginary Fowler-style feed</title>
  <link rel="self" type="application/atom+xml" href="https://martinfowler.com/feed.atom"/>
  <updated>2025-07-07T10:00:00Z</updated>
  <entry>
    <title>The Made-Up Pattern Catalogue</title>
    <link rel="related" type="text/html" href="https://martinfowler.com/tags/madeup.html"/>
    <link rel="alternate" type="text/html" href="https://martinfowler.com/articles/made-up-pattern.html?utm_medium=feed"/>
    <updated>2025-07-07T10:00:00Z</updated>
    <content type="html">&lt;p&gt;A fictional introduction to a pattern that does not exist.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Notes on an Invented Refactoring</title>
    <link href="https://martinfowler.com/articles/invented-refactoring.html"/>
    <updated>2025-06-28T14:30:00Z</updated>
    <content type="html">&lt;p&gt;Second fabricated summary paragraph.&lt;/p&gt;</content>
  </entry>
</feed>`;
