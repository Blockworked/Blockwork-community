import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notifications.ts";
import { sendMail } from "../src/support-mail.ts";
import { formImages, imageType, mailImages, validateImages } from "../src/support-attachments.ts";

const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
test("images require matching raster signatures, bounded counts and sizes", async () => {
  const image = { name: "../test\n.png", type: "image/png", bytes: png };
  validateImages([image]);
  assert.equal(image.name, ".._test_.png");
  assert.equal(imageType(new TextEncoder().encode('<svg></svg>')), null);
  assert.throws(() => validateImages([{ ...image, type: "image/jpeg" }]));
  assert.throws(() => validateImages(Array(5).fill(image)));
  assert.throws(() => validateImages([{ ...image, bytes: new Uint8Array(3 * 1024 * 1024 + 1) }]));
  assert.throws(() => validateImages(Array(3).fill({ ...image, bytes: new Uint8Array(3 * 1024 * 1024) })));
  const form = new FormData();
  form.append("images", new Blob([png], { type: "image/png" }), "shot.png");
  const images = await formImages(form);
  assert.equal(images.length, 1);
  assert.equal(mailImages(images)[0].fileblob, Buffer.from(png).toString("base64"));
});

test("all notification channels run independently and Discord cannot ping mentions", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: any; headers: Headers }[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)), headers: new Headers(options?.headers) });
    return new Response("", { status: String(url).includes("ntfy") ? 500 : 200 });
  };
  try {
    await notify({ SUPPORT_NOTIFY: "a@example.com,b@example.com", SMTP2GO_API_KEY: "test", NTFY_TOPIC: "private", NTFY_TOKEN: "token", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test" }, { title: "@everyone new ticket", text: "Details", url: "https://support.example/tickets/1" });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0].body.to, ["a@example.com", "b@example.com"]);
    assert.equal(requests[1].body.topic, "private");
    assert.equal(requests[1].headers.get("Authorization"), "Bearer token");
    assert.deepEqual(requests[2].body.allowed_mentions, { parse: [] });
    requests.length = 0;
    await notify({}, { title: "Disabled", text: "", url: "https://example.com" });
    assert.equal(requests.length, 0);
    const attachments = mailImages([{ name: "shot.png", type: "image/png", bytes: png }]);
    await sendMail({ SMTP2GO_API_KEY: "test" }, { to: ["a@example.com"], subject: "Reply", text: "Screenshot", attachments });
    assert.deepEqual(requests[0].body.attachments, attachments);
  } finally { globalThis.fetch = original; }
});
