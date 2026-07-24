const path = require('path');
const fs = require('fs');

// Database configuration
const config = {
  development: {
    // SQLite for local development (no setup required)
    dialect: 'sqlite',
    storage: path.join(__dirname, '..', 'database', 'leave_management.sqlite'),
    logging: console.log,
    define: {
      timestamps: true,
      underscored: true,
    },
  },
  
  // Alternative: Local PostgreSQL
  postgres: {
    dialect: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'leave_management_db',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    logging: console.log,
    define: {
      timestamps: true,
      underscored: true,
    },
  },
  
  // Alternative: Local MySQL
  mysql: {
    dialect: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || 'leave_management_db',
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'password',
    logging: console.log,
    define: {
      timestamps: true,
      underscored: true,
    },
  }
};

// Ensure database directory exists for SQLite
if (config.development.dialect === 'sqlite') {
  const dbDir = path.dirname(config.development.storage);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log('📁 Created database directory:', dbDir);
  }
}

// Use environment variable to switch database type
const dbType = process.env.DB_TYPE || 'development';
const dbConfig = config[dbType] || config.development;

console.log(`🗄️ Database configured: ${dbConfig.dialect.toUpperCase()}`);
if (dbConfig.dialect === 'sqlite') {
  console.log(`📍 Database file: ${dbConfig.storage}`);
} else {
  console.log(`📍 Database host: ${dbConfig.host}:${dbConfig.port}`);
  console.log(`📍 Database name: ${dbConfig.database}`);
}

module.exports = {
  ...dbConfig,
  config,
  currentType: dbType
};
