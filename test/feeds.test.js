import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { canonUrl, titleKey, detectLang, parseFeed, isPrivateIp } = await import('../src/feeds.js');

test('canonUrl strips tracking, www, fragment, trailing slash', () => {
  assert.equal(canonUrl('https://www.x.com/a/b/?utm_source=f&id=2#top'), 'https://x.com/a/b?id=2');
});
test('detectLang', () => { assert.equal(detectLang('नेपालको समाचार'), 'ne'); assert.equal(detectLang('Nepal news today'), 'en'); });
test('titleKey normalises punctuation/case', () => assert.equal(titleKey('Hello,  WORLD!'), titleKey('hello world')));
test('isPrivateIp', () => { for (const ip of ['127.0.0.1', '10.1.1.1', '192.168.0.5', '169.254.169.254', '::1']) assert.ok(isPrivateIp(ip), ip); assert.ok(!isPrivateIp('8.8.8.8')); });
test('parseFeed RSS with image and Nepali', () => {
  const [e] = parseFeed(`<rss version="2.0"><channel><item><title>शीर्षक</title><link>https://a.com/1</link><pubDate>Mon, 19 Oct 2026 10:00:00 +0545</pubDate><description>सारांश</description><enclosure url="https://a.com/i.jpg" type="image/jpeg"/></item></channel></rss>`);
  assert.equal(e.title, 'शीर्षक'); assert.equal(e.image, 'https://a.com/i.jpg'); assert.equal(e.published, '2026-10-19T04:15:00.000Z');
});
test('parseFeed rejects HTML', () => assert.throws(() => parseFeed('<html><body>404</body></html>'), /not an RSS/));
test('parseFeed decodes numeric/named entities but keeps escaped markup as text', () => {
  const [e] = parseFeed(`<rss version="2.0"><channel><item><title>A &amp;#8211; B</title><link>https://a.com/2</link><description><![CDATA[<p>More &#8230; &amp; &lt;b&gt;x&lt;/b&gt; [&#8230;]</p>]]></description></item></channel></rss>`);
  assert.equal(e.summary, 'More … & <b>x</b> […]');
});
const { extractImage, robotsAllows } = await import('../src/images.js');
test('extractImage prefers og:image, resolves relative, rejects non-http', () => {
  assert.equal(extractImage('<meta property="og:image" content="/i/a.jpg"><meta name="twitter:image" content="https://x/b.jpg">', 'https://s.com/p'), 'https://s.com/i/a.jpg');
  assert.equal(extractImage('<meta name="twitter:image" content="https://x/b.jpg">', 'https://s.com'), 'https://x/b.jpg');
  assert.equal(extractImage('<meta property="og:image" content="javascript:alert(1)">', 'https://s.com'), null);
  assert.equal(extractImage('<html></html>', 'https://s.com'), null);
});
test('robotsAllows: longest match wins, own UA group preferred', () => {
  const t = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: EverestNepalBot\nDisallow: /blocked';
  assert.equal(robotsAllows(t, '/private/x'), true, 'own group has no /private rule'); assert.equal(robotsAllows(t, '/blocked/a'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/ok', '/private/ok/1'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/ok', '/private/zz'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow:', '/anything'), true);
});
