const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Employee Voice attachments live under /uploads/voice (served statically by server.js).
const voiceDir = path.join(__dirname, "../uploads/voice");
if (!fs.existsSync(voiceDir)) {
  fs.mkdirSync(voiceDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, voiceDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9-_]/g, "_")
      .slice(0, 40);
    const unique = `${base}-${Date.now()}-${Math.round(
      Math.random() * 1e6
    )}${ext.toLowerCase()}`;
    cb(null, unique);
  },
});

// Allow images and common document types.
const ALLOWED = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only images and PDF files are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5,
  },
});

// Maps multer's saved files to the attachment subdoc shape used by the model.
const mapUploadedFiles = (files = []) =>
  files.map((f) => ({
    filename: f.filename,
    originalName: f.originalname,
    mimetype: f.mimetype,
    size: f.size,
    path: `/uploads/voice/${f.filename}`,
  }));

module.exports = {
  uploadVoiceAttachments: upload.array("attachments", 5),
  mapUploadedFiles,
};
