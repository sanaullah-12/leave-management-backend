const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { detectFileType, safeDisplayName } = require("../utils/fileSignature");

/**
 * Employee Voice attachments are confidential (complaints, HR matters), so
 * they are stored OUTSIDE every statically served directory and are only ever
 * returned by GET /api/employee-voice/:id/attachments/:index, after the same
 * owner-or-admin check as the voice itself.
 *
 * Files are accepted by their content, not their name or declared type, and
 * are written under a random server-generated name whose extension comes from
 * the detected type - an uploaded .html/.svg/.js can never be stored as such.
 */
const voiceDir = path.join(__dirname, "../storage/voice");
if (!fs.existsSync(voiceDir)) {
  fs.mkdirSync(voiceDir, { recursive: true });
}

// Attachments saved before storage moved out of the public uploads folder.
const legacyVoiceDir = path.join(__dirname, "../uploads/voice");

const ALLOWED = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const declared = file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype;
    if (ALLOWED.includes(declared)) {
      cb(null, true);
    } else {
      cb(new Error("Only images and PDF files are allowed"), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5,
    fields: 20,
    fieldSize: 16 * 1024,
  },
});

/** Parse the multipart body, then verify and persist each file. */
const uploadVoiceAttachments = (req, res, next) =>
  upload.array("attachments", 5)(req, res, async (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Each attachment must be 10MB or smaller"
          : err.code === "LIMIT_FILE_COUNT"
          ? "At most 5 attachments are allowed"
          : err.message;
      return res.status(400).json({ message });
    }

    try {
      const saved = [];
      for (const file of req.files || []) {
        const detected = detectFileType(file.buffer, ALLOWED);
        if (!detected) {
          return res
            .status(400)
            .json({ message: `"${safeDisplayName(file.originalname)}" is not a valid image or PDF` });
        }
        const filename = `${crypto.randomUUID()}${detected.ext}`;
        await fs.promises.writeFile(path.join(voiceDir, filename), file.buffer, {
          flag: "wx",
          mode: 0o600,
        });
        saved.push({
          filename,
          originalName: safeDisplayName(file.originalname),
          mimetype: detected.mime,
          size: file.size,
        });
      }
      req.voiceAttachments = saved;
      next();
    } catch (writeError) {
      console.error("Voice attachment save failed:", writeError.message);
      res.status(500).json({ message: "Failed to save attachments" });
    }
  });

/** Attachment subdocuments for the model. `path` is resolved per request. */
const mapUploadedFiles = (files = []) =>
  files.map((f) => ({
    filename: f.filename,
    originalName: f.originalName,
    mimetype: f.mimetype,
    size: f.size,
  }));

/**
 * Absolute path of a stored attachment, or null. The name comes from the
 * database, never the request, and is still confined to the two directories.
 */
const resolveAttachmentPath = (filename) => {
  if (typeof filename !== "string" || !/^[\w.-]+$/.test(filename)) return null;
  for (const dir of [voiceDir, legacyVoiceDir]) {
    const candidate = path.join(dir, filename);
    if (path.dirname(candidate) === dir && fs.existsSync(candidate)) return candidate;
  }
  return null;
};

module.exports = {
  uploadVoiceAttachments,
  mapUploadedFiles,
  resolveAttachmentPath,
};
