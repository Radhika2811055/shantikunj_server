const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const dotenv = require('dotenv')
const path = require('path')
const cron = require('node-cron')
const sendFollowUps = require('./jobs/followUpJob')
const session = require('express-session')

dotenv.config({ path: path.join(__dirname, '.env') })

const { protect, authorise } = require('./middleware/authMiddleware')
const { uploadAudioFile: uploadAudioFileMiddleware } = require('./middleware/uploadMiddleware')
const { uploadAudioFile } = require('./controllers/bookController')

const passport = require('./config/passport')

const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '')
const FRONTEND_URL = normalizeOrigin(process.env.FRONTEND_URL || 'http://localhost:5173')
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || FRONTEND_URL)
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean)
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const PORT = Number(process.env.PORT) || 5000

const app = express()

if (IS_PRODUCTION) {
  // Needed when running behind reverse proxy/load balancer for secure cookies.
  app.set('trust proxy', 1)
}

app.use(session({
  secret: process.env.SESSION_SECRET || process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}))

app.use(passport.initialize())
app.use(passport.session())


// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }

    const normalizedOrigin = normalizeOrigin(origin)
    callback(null, CORS_ORIGINS.includes(normalizedOrigin))
  },
  credentials: true
}))
app.use(express.json())
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Routes

// for normal user login and registration
const authRoutes = require('./routes/authRoutes')
app.use('/api/auth', authRoutes)

// for admin actions like approving/rejecting users
const adminRoutes = require('./routes/adminRoutes')
app.use('/api/admin', adminRoutes)

const bookRoutes = require('./routes/bookRoutes')
app.use('/api/books', bookRoutes)

// Fallback upload route to ensure recorder audio uploads are always reachable.
app.post('/api/books/upload-audio-file', protect, authorise('recorder'), uploadAudioFileMiddleware.any(), uploadAudioFile)

const claimRoutes = require('./routes/claimRoutes')
app.use('/api/claims', claimRoutes)

const supportRoutes = require('./routes/supportRoutes')
app.use('/api/support', supportRoutes)

const feedbackRoutes = require('./routes/feedbackRoutes')
app.use('/api/feedback', feedbackRoutes)

const notificationRoutes = require('./routes/notificationRoutes')
app.use('/api/notifications', notificationRoutes)

const auditRoutes = require('./routes/auditRoutes')
app.use('/api/audit', auditRoutes)

// Test route
app.get('/', (req, res) => {
  res.send('Shantikunj server is running!')
})

let followUpJobScheduled = false

const scheduleFollowUpJob = () => {
  if (followUpJobScheduled) return

  // Scheduled job — runs every day at 9:00 AM
  cron.schedule('0 9 * * *', () => {
    console.log('Running scheduled follow-up job...')
    sendFollowUps()
  })

  followUpJobScheduled = true
}

const startServer = async () => {
  await mongoose.connect(process.env.MONGO_URI)
  console.log('MongoDB connected!')

  scheduleFollowUpJob()

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
  })
}

if (require.main === module) {
  startServer().catch((err) => {
    console.log('Connection error:', err)
    process.exit(1)
  })
}

module.exports = {
  app,
  startServer
}