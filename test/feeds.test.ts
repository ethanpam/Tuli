import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchFeed } from "../src/features/feeds/index.js";
import { FeedError, htmlToText, parseFeed } from "../src/features/feeds/parse.js";
import { addFeed, keywordList, markSeen, matchesKeywords, removeFeed, unseen } from "../src/features/feeds/store.js";

// Shaped like https://www.news.iastate.edu/rss.xml and a WordPress feed.
const rss = `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">
<channel>
  <title>News Service</title>
  <item>
    <title>How AI is changing business</title>
    <link>https://www.news.iastate.edu/news/how-ai-changing-business</link>
    <description>A 2015 Iowa State graduate will share lessons he&#039;s learned &amp; more.</description>
    <pubDate>Mon, 21 Sep 2026 12:00:00 +0000</pubDate>
    <guid isPermaLink="false">2fa84e61-524e-4297-82b3-bce22790ba5a</guid>
  </item>
  <item>
    <title>Summer internship fair</title>
    <link>https://example.edu/fair</link>
    <description><![CDATA[<p>Meet <b>50 employers</b>.</p><p>Bring your résumé&hellip;</p>The post Summer internship fair appeared first on Career Services.]]></description>
    <content:encoded><![CDATA[<img src="https://example.edu/fair.jpg"> Full story]]></content:encoded>
    <pubDate>Tue, 22 Sep 2026 15:30:00 +0000</pubDate>
  </item>
  <item>
    <title>With an enclosure image</title>
    <link>https://example.edu/photo</link>
    <enclosure url="https://example.edu/photo.png" type="image/png" length="1"/>
  </item>
</channel>
</rss>`;

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes</title>
  <entry>
    <id>tag:github.com,2008:1</id>
    <title>v2.0</title>
    <link rel="related" href="https://example.com/related"/>
    <link rel="alternate" type="text/html" href="https://example.com/v2"/>
    <updated>2026-07-19T15:59:47Z</updated>
    <content type="html">&lt;h2&gt;Bug fixes&lt;/h2&gt;&lt;p&gt;Faster&lt;/p&gt;</content>
  </entry>
</feed>`;

const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Old school</title></channel>
  <item><title>Hello</title><link>https://example.org/hello</link><dc:date>2026-01-02T03:04:05Z</dc:date></item>
</rdf:RDF>`;

test("parses RSS 2.0 like ISU News and WordPress feeds", () => {
  const feed = parseFeed(rss);
  assert.equal(feed.title, "News Service");
  const [news, fair, photo] = feed.items;
  assert.deepEqual(news, {
    key: "2fa84e61-524e-4297-82b3-bce22790ba5a",
    title: "How AI is changing business",
    link: "https://www.news.iastate.edu/news/how-ai-changing-business",
    summary: "A 2015 Iowa State graduate will share lessons he's learned & more.",
    publishedAt: Date.parse("2026-09-21T12:00:00Z"),
    imageUrl: null,
  });
  assert.equal(fair?.key, "https://example.edu/fair", "falls back to the link when there's no guid");
  assert.equal(fair?.summary, "Meet 50 employers.\nBring your résumé…", "HTML stripped, WordPress footer removed");
  assert.equal(fair?.imageUrl, "https://example.edu/fair.jpg");
  assert.equal(photo?.imageUrl, "https://example.edu/photo.png");
  assert.equal(photo?.publishedAt, null);
});

test("parses Atom and RSS 1.0", () => {
  const [release] = parseFeed(atom).items;
  assert.equal(release?.link, "https://example.com/v2", "uses the alternate link");
  assert.equal(release?.summary, "Bug fixes\nFaster");
  assert.equal(release?.publishedAt, Date.parse("2026-07-19T15:59:47Z"));
  const old = parseFeed(rdf);
  assert.deepEqual([old.title, old.items[0]?.title, old.items[0]?.publishedAt], ["Old school", "Hello", Date.parse("2026-01-02T03:04:05Z")]);
});

test("rejects things that aren't feeds", () => {
  assert.throws(() => parseFeed("<!DOCTYPE html><html><body>Hi</body></html>"), FeedError);
  assert.throws(() => parseFeed("not xml at all <<<"), FeedError);
});

test("htmlToText decodes entities", () => {
  assert.equal(htmlToText("Tom &amp; Jerry&#8217;s &#x1F600; &nbsp;<br>line"), "Tom & Jerry’s 😀 \nline");
});

test("only public http(s) feeds are allowed", async () => {
  for (const url of ["http://localhost/feed", "http://127.0.0.1/rss", "http://192.168.1.5/rss", "http://169.254.169.254/latest", "ftp://example.com/feed", "not a url"]) {
    await assert.rejects(fetchFeed(url), FeedError, url);
  }
});

test("remembers which posts were shared, per feed", () => {
  const feed = addFeed("f1", { channelId: "c", url: "https://example.com/rss", title: "Example", keywords: "" });
  assert.throws(() => addFeed("f1", { channelId: "c", url: "https://example.com/rss", title: "Again", keywords: "" }), FeedError);
  markSeen(feed.id, ["a", "b"]);
  assert.deepEqual(unseen(feed.id, ["a", "b", "c"]), ["c"]);
  removeFeed("f1", feed.id);
  const again = addFeed("f1", { channelId: "c", url: "https://example.com/rss", title: "Example", keywords: "" });
  assert.deepEqual(unseen(again.id, ["a"]), ["a"], "a removed feed's history is gone");
});

test("old seen posts are forgotten after 90 days", () => {
  const feed = addFeed("f2", { channelId: "c", url: "https://example.com/old", title: "Old", keywords: "" });
  const longAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;
  markSeen(feed.id, ["ancient"], longAgo);
  markSeen(feed.id, ["recent"]);
  assert.deepEqual(unseen(feed.id, ["ancient", "recent"]), ["ancient"]);
});

test("keyword filters", () => {
  assert.deepEqual(keywordList({ keywords: " Internship, ,SCHOLARSHIP " }), ["internship", "scholarship"]);
  const feed = { keywords: "internship, scholarship" };
  assert.ok(matchesKeywords(feed, "Summer INTERNSHIP fair", ""));
  assert.ok(matchesKeywords(feed, "News", "New scholarship for sophomores"));
  assert.ok(!matchesKeywords(feed, "Football recap", "We won"));
  assert.ok(matchesKeywords({ keywords: "" }, "Anything", ""), "no keywords = everything");
});
