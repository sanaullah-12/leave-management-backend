const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads/profiles');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for memory storage
const storage = multer.memoryStorage();

// File filter for images only
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

// Multer configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  }
});

// Middleware to process and save profile pictures
const processProfilePicture = async (req, res, next) => {
  try {
    if (!req.file) {
      return next();
    }

    // Generate unique filename
    const filename = `profile-${req.user._id}-${Date.now()}.webp`;
    const filepath = path.join(uploadsDir, filename);

    // Process image with Sharp
    await sharp(req.file.buffer)
      .resize(300, 300, {
        fit: 'cover',
        position: 'center'
      })
      .webp({ quality: 85 })
      .toFile(filepath);

    // Store the relative path for the database
    req.profilePicturePath = `/uploads/profiles/${filename}`;
    next();
  } catch (error) {
    console.error('Profile picture processing error:', error);
    res.status(400).json({ message: 'Failed to process profile picture' });
  }
};

module.exports = {
  uploadSingle: upload.single('profilePicture'),
  processProfilePicture
};