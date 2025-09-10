const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide company name'],
    trim: true,
    unique: true,
    maxlength: [100, 'Company name cannot exceed 100 characters']
  },
  email: {
    type: String,
    required: [true, 'Please provide company email'],
    unique: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please provide valid email'
    ]
  },
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  phone: {
    type: String,
    trim: true
  },
  website: {
    type: String,
    trim: true
  },
  leavePolicy: {
    annualLeave: {
      type: Number,
      default: 21
    },
    sickLeave: {
      type: Number,
      default: 10
    },
    casualLeave: {
      type: Number,
      default: 7
    },
    maternityLeave: {
      type: Number,
      default: 90
    },
    paternityLeave: {
      type: Number,
      default: 15
    },
    preventOverlappingLeaves: {
      type: Boolean,
      default: false // Allow multiple employees to take leave on same dates by default
    },
    maxConcurrentLeaves: {
      type: Number,
      default: null // No limit by default, set number to limit concurrent leaves
    }
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Company', companySchema);