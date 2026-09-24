/**
 * Identify a file by its leading bytes rather than by the name or the
 * Content-Type the client sent, both of which are attacker-controlled.
 *
 * Only the formats the application accepts are recognised; anything else
 * (HTML, SVG, scripts, executables, archives) returns null and is rejected.
 */
const SIGNATURES = [
  {
    mime: "image/png",
    ext: ".png",
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    ext: ".jpg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    ext: ".gif",
    test: (b) => {
      const head = b.subarray(0, 6).toString("latin1");
      return head === "GIF87a" || head === "GIF89a";
    },
  },
  {
    mime: "image/webp",
    ext: ".webp",
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    mime: "application/pdf",
    ext: ".pdf",
    test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  },
];

/**
 * @param {Buffer} buffer
 * @param {string[]} allowedMimes
 * @returns {{mime: string, ext: string} | null}
 */
const detectFileType = (buffer, allowedMimes) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const match = SIGNATURES.find((s) => allowedMimes.includes(s.mime) && s.test(buffer));
  return match ? { mime: match.mime, ext: match.ext } : null;
};

/** A display-safe version of a client-supplied filename (never used on disk). */
const safeDisplayName = (name) =>
  String(name || "file")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .slice(0, 120);

module.exports = { detectFileType, safeDisplayName };
