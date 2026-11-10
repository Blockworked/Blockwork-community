import type { Env } from "./index.ts";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 6 * 1024 * 1024;
export interface ImageAttachment { name: string; type: string; bytes: Uint8Array; }
export interface StoredImage { id: string; message_id: number; name: string; type: string; size: number; }
export const imageField = `<label class="field" for="images">Images (optional)</label><input id="images" type="file" name="images" accept="image/png,image/jpeg,image/gif,image/webp" multiple><p class="muted">PNG, JPEG, GIF or WebP. Up to 4 images, 3 MiB each, 6 MiB total. If the form has an error, choose your images again.</p>`;

export function imageType(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  const text = new TextDecoder("ascii").decode(bytes.slice(0, 12));
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8) === "WEBP") return "image/webp";
  return null;
}
export function validateImages(images: ImageAttachment[]): void {
  if (images.length > MAX_IMAGES) throw new Error("Attach up to 4 images.");
  if (images.reduce((n, i) => n + i.bytes.length, 0) > MAX_IMAGES_BYTES) throw new Error("Images must total at most 6 MiB.");
  for (const image of images) {
    if (!image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES) throw new Error("Each image must be between 1 byte and 3 MiB.");
    if (!imageType(image.bytes) || imageType(image.bytes) !== image.type) throw new Error("Use PNG, JPEG, GIF or WebP images with matching file contents.");
    image.name = image.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 150) || "image";
  }
}
export async function formImages(form: FormData): Promise<ImageAttachment[]> {
  const files = form.getAll("images").filter((f): f is File => typeof f !== "string" && !!f.size);
  if (files.length > MAX_IMAGES || files.some(f => f.size > MAX_IMAGE_BYTES) || files.reduce((n, f) => n + f.size, 0) > MAX_IMAGES_BYTES) throw new Error("Attach up to 4 images, 3 MiB each and 6 MiB total.");
  const images = await Promise.all(files.map(async f => ({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
  validateImages(images);
  return images;
}
export async function storeImages(env: Env, message: number, images: ImageAttachment[]): Promise<void> {
  validateImages(images);
  for (const image of images) {
    const id = crypto.randomUUID();
    await env.PACKS.put(`support/${id}`, image.bytes, { httpMetadata: { contentType: image.type } });
    try {
      await env.DB.prepare("INSERT INTO ticket_attachments (id, message_id, name, type, size) VALUES (?, ?, ?, ?, ?)").bind(id, message, image.name, image.type, image.bytes.length).run();
    } catch (error) { await env.PACKS.delete(`support/${id}`); throw error; }
  }
}
export function mailImages(images: ImageAttachment[]) {
  return images.map(image => {
    let binary = "";
    for (let i = 0; i < image.bytes.length; i += 8192) binary += String.fromCharCode(...image.bytes.subarray(i, i + 8192));
    return { filename: image.name, fileblob: btoa(binary), mimetype: image.type };
  });
}
