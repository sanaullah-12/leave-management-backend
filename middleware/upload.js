const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { detectFileType } = require('../utils/fileSignature');

// Profile pictures are public (they are shown in <img> tags, which cannot send
// an Authorization header) and are therefore always re-encoded server-side:
// whatever was uploaded, only a freshly generated WebP ever reaches disk.
const uploadsDir = path.join(__dirname, '../uploads/profiles');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    // A first, cheap filter on the declared type. The real check is on the
    // bytes in processProfilePicture.
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, WebP or GIF images are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1,
    fields: 5,
  },
});

/** Multer errors (size, type) become 400s instead of generic 500s. */
const uploadSingle = (req, res, next) =>
  upload.single('profilePicture')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5MB or smaller' : err.message;
    return res.status(400).json({ message });
  });

const processProfilePicture = async (req, res, next) => {
  try {
    if (!req.file) {
      return next();
    }

    if (!detectFileType(req.file.buffer, ALLOWED_IMAGE_TYPES)) {
      return res.status(400).json({ message: 'File is not a valid image' });
    }

    // Random, server-generated name: not guessable from the user id, and
    // nothing from the client ever reaches the filesystem path.
    const filename = `${crypto.randomUUID()}.webp`;
    const filepath = path.join(uploadsDir, filename);

    await sharp(req.file.buffer, {
      // Rejects decompression bombs (a tiny file that decodes to gigapixels).
      limitInputPixels: 40 * 1000 * 1000,
      failOn: 'error',
    })
      .rotate()
      .resize(300, 300, { fit: 'cover', position: 'center' })
      .webp({ quality: 85 })
      .toFile(filepath);

    req.profilePicturePath = `/uploads/profiles/${filename}`;
    next();
  } catch (error) {
    console.error('Profile picture processing error:', error.message);
    res.status(400).json({ message: 'Failed to process profile picture' });
  }
};

module.exports = {
  uploadSingle,
  processProfilePicture,
};
