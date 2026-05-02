// Usage: node gen-hash.js YourStrongPasswordHere
// Prints the bcrypt hash. Paste it into .env as ADMIN_PASSWORD_HASH.
const bcrypt = require('bcrypt');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node gen-hash.js <password>');
  process.exit(1);
}

bcrypt.hash(password, 10).then(hash => console.log(hash));
