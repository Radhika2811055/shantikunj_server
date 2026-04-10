const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const dotenv = require('dotenv')
const path = require('path')
const User = require('./models/User')

dotenv.config({ path: path.join(__dirname, '.env') })

const setupTranslator = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI)
    console.log('Connected to MongoDB!')

    let testUser = await User.findOne({ email: 'testtranslator@shantikunj.com' })
    if (!testUser) {
      const hashedPassword = await bcrypt.hash('Test@1234', 10)
      testUser = await User.create({
        name: 'Test Translator',
        email: 'testtranslator@shantikunj.com',
        password: hashedPassword,
        role: 'translator',
        status: 'approved',
        isActive: true,
        language: 'English'
      })
      console.log('✅ Test translator created!')
    } else {
      testUser.status = 'approved'
      testUser.role = 'translator'
      await testUser.save()
      console.log('✅ Test translator already exists and is approved')
    }

    console.log('\nTest User Credentials:')
    console.log('Email: testtranslator@shantikunj.com')
    console.log('Password: Test@1234')
    console.log('Role: translator')

    await mongoose.disconnect()
    process.exit(0)
  } catch (error) {
    console.log('Error:', error.message)
    process.exit(1)
  }
}

setupTranslator()
