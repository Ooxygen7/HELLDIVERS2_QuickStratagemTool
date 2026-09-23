import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { normalizeItem, normalizeItems } from "../lib/catalog.mjs";
import { normalizeUploadedIcon } from "../lib/icons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("seed catalog contains valid normalized items", async () => {
  const seed = JSON.parse(await readFile(path.join(root, "data", "seed-catalog.json"), "utf8"));
  const items = normalizeItems(seed.items);
  assert.equal(items.length, 101);
  assert.equal(items.some((item) => item.aliases.some((alias) => typeof alias !== "string")), false);
});

test("uploaded SVG is rasterized into the fixed safe wrapper", async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>alert(1)</script><rect width="32" height="32" fill="#fff"/></svg>');
  const icon = await normalizeUploadedIcon({ mediaType: "image/svg+xml", base64: source.toString("base64") });
  const output = Buffer.from(icon.base64, "base64").toString("utf8");
  assert.match(output, /data-hd2-normalized-icon="1"/);
  assert.match(output, /data:image\/png;base64,/);
  assert.doesNotMatch(output, /<script|alert\(/i);
});

test("catalog rejects reserved IDs and invalid sequences", () => {
  const item = {
    id: "custom_forbidden",
    grp: "support",
    name: { zh: "测试", en: "Test" },
    aliases: [],
    ocr: [],
    seq: ["W", "X"],
    icon: { kind: "bundled", value: "Test.svg" },
    enabled: true,
    order: 1,
  };
  assert.throws(() => normalizeItem(item), /custom_/);
  assert.throws(() => normalizeItem({ ...item, id: "valid_id" }), /W, A, S, and D/);
});

test("uploaded icons retain transparency and artwork without an added frame or inset", async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect y="96" width="256" height="64" fill="#fff"/></svg>');
  for (const mediaType of ["image/svg+xml", "image/png"]) {
    const upload = mediaType === "image/png" ? await sharp(source).png().toBuffer() : source;
    const icon = await normalizeUploadedIcon({ mediaType, base64: upload.toString("base64") });
    const output = Buffer.from(icon.base64, "base64");
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 256);
    assert.equal(info.height, 256);
    const pixel = (x, y) => [...data.subarray((y * 256 + x) * 4, (y * 256 + x + 1) * 4)];
    assert.equal(pixel(0, 0)[3], 0, "transparent corners must not gain a frame");
    assert.equal(pixel(32, 32)[3], 0, "transparent artwork must not gain a backplate");
    assert.deepEqual(pixel(0, 128), [255, 255, 255, 255], "artwork must reach the original edge without an inset");
    assert.deepEqual(pixel(255, 128), [255, 255, 255, 255]);
  }
});

test("borders already present in the uploaded artwork are preserved", async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path fill="#ff0000" fill-rule="evenodd" d="M0 0h256v256H0zM16 16v224h224V16H16z"/></svg>');
  const icon = await normalizeUploadedIcon({ mediaType: "image/svg+xml", base64: source.toString("base64") });
  const output = await sharp(Buffer.from(icon.base64, "base64")).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...output.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(output[(128 * 256 + 128) * 4 + 3], 0);
});
