import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "@/components/MessageBubble";

const NUL = String.fromCharCode(0);

test("a standalone fenced code block is restored to a <pre> block with escaped content", () => {
  const html = renderMarkdown("Intro line.\n\n```js\nconst a = 1 < 2 && 3 > 2;\n```\n\nOutro line.");
  assert.match(html, /<pre class="code-block"><code>const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;<\/code><\/pre>/);
  assert.match(html, /<p>Intro line\.<\/p>/);
  assert.match(html, /<p>Outro line\.<\/p>/);
  assert.ok(!html.includes("CODE_BLOCK"), "placeholder token must not leak into output");
});

test("multiple fenced blocks keep their correct order and indices", () => {
  const html = renderMarkdown("```\nFIRST\n```\n\ntext between\n\n```\nSECOND\n```");
  const firstAt = html.indexOf("FIRST");
  const secondAt = html.indexOf("SECOND");
  assert.ok(firstAt > -1 && secondAt > firstAt, "both blocks present and in order");
  assert.match(html, /<p>text between<\/p>/);
  assert.ok(!html.includes("CODE_BLOCK"));
});

test("message text cannot spoof the code-block placeholder", () => {
  // A user / document writing the literal token must be escaped, never treated as a real block.
  const html = renderMarkdown("<<<CODE_BLOCK_0>>>");
  assert.ok(!html.includes("<pre"), "no code block should be produced");
  assert.match(html, /&lt;&lt;&lt;CODE_BLOCK_0&gt;&gt;&gt;/);
});

test("renderMarkdown output contains no NUL byte", () => {
  const html = renderMarkdown("plain\n\n```\ncode\n```\n\n- item\n\n> quote\n\n<<<CODE_BLOCK_9>>>");
  assert.equal(html.includes(NUL), false);
});

test("headings, lists and inline formatting still render", () => {
  const html = renderMarkdown("## Title\n\n- one\n- two\n\n**bold** and `code`");
  assert.match(html, /<h2 class="msg-h2">Title<\/h2>/);
  assert.match(html, /<li class="msg-li bulleted">one<\/li>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="inline-code">code<\/code>/);
});
