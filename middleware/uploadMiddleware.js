const multer = require('multer')
const cloudinary = require('cloudinary').v2

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})

const storage = multer.memoryStorage()

const allowedDocMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
])

const allowedAudioMimeTypes = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/x-mpeg',
  'audio/mpeg3',
  'audio/mp4',
  'video/mp4'
])

const uploadTranslationDoc = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const hasAllowedExtension = /\.(pdf|doc|docx|txt)$/i.test(file.originalname || '')
    if (allowedDocMimeTypes.has(file.mimetype) || hasAllowedExtension) {
      cb(null, true)
      return
    }

    cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed'))
  }
})

const uploadAudioFile = multer({
  storage,
  limits: { fileSize: 120 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const hasAllowedExtension = /\.(mp3|mp4)$/i.test(file.originalname || '')
    if (allowedAudioMimeTypes.has(file.mimetype) || hasAllowedExtension) {
      cb(null, true)
      return
    }

    cb(new Error('Only MP3 and MP4 files are allowed'))
  }
})

// Helper to upload buffer to Cloudinary
const uploadToCloudinary = (buffer, fileName, resourceType = 'auto') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id: fileName.replace(/\.[^/.]+$/, ''),
        resource_type: resourceType
      },
      (error, result) => {
        if (error) reject(error)
        else resolve(result)
      }
    )
    uploadStream.end(buffer)
  })
}

module.exports = {
  uploadTranslationDoc,
  uploadAudioFile,
  uploadToCloudinary,
  cloudinary
}
