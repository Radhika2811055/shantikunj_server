const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const dotenv = require('dotenv')
const path = require('path')
const User = require('./models/User')

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') })

const setupTestUser = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI)
    console.log('Connected to MongoDB!')

    // Check if test user exists
    let testUser = await User.findOne({ email: 'testrecorder@shantikunj.com' })
    
    if (!testUser) {
      // Create test recorder user
      const hashedPassword = await bcrypt.hash('Test@1234', 10)
      testUser = await User.create({
        name: 'Test Recorder',
        email: 'testrecorder@shantikunj.com',
        password: hashedPassword,
        role: 'recorder',
        status: 'approved',
        isActive: true,
        language: 'English'
      })
      console.log('✅ Test recorder user created!')
    } else {
      console.log('✅ Test recorder user already exists!')
      // Make sure they're approved
      testUser.status = 'approved'
      testUser.role = 'recorder'
      await testUser.save()
      console.log('✅ User approved and role set to recorder')
    }

    console.log('\nTest User Credentials:')
    console.log('Email: testrecorder@shantikunj.com')
    console.log('Password: Test@1234')
    console.log('Role: recorder')

    await mongoose.disconnect()
    process.exit(0)
  } catch (error) {
    console.log('Error:', error.message)
    process.exit(1)
  }
}

setupTestUser()
