/**
 * martinfowler.com 記事ページを模した合成 HTML（すべて架空）。
 *
 * <main> に本文と、除外対象（h1 / .date / .author-list / .author / .tags /
 * .contents）を混在させ、本文だけが残ることを検証するために使う。
 * <main> を持たないページ（構造変更検知用）は fowlerArticleWithoutMain。
 * 文章・著者名はすべて架空。
 */
export const fowlerArticleHtml = `<!DOCTYPE html>
<html lang="en">
  <head><title>The Made-Up Pattern Catalogue</title></head>
  <body>
    <header class="site-header"><nav>fake nav</nav></header>
    <main>
      <h1>The Made-Up Pattern Catalogue</h1>
      <p class="date">07 July 2025</p>
      <ul class="author-list"><li class="author">A Fictional Author</li></ul>
      <ul class="tags"><li>invented</li><li>pretend</li></ul>
      <div class="contents"><a href="#one">Made-up section one</a></div>
      <p>This is the first fabricated body paragraph of the article.</p>
      <p>This is the second fabricated body paragraph of the article.</p>
    </main>
    <footer>fake footer</footer>
  </body>
</html>`;

export const fowlerArticleWithoutMain = `<!DOCTYPE html>
<html lang="en">
  <head><title>Broken layout</title></head>
  <body>
    <article>
      <p>This page has no main element, simulating a site structure change.</p>
    </article>
  </body>
</html>`;
