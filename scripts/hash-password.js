// Usage: npm run hash-password -- "your password"
// Prints a line to paste into .env as ADMIN_PASSWORD_HASH.
const { hashPassword } = require("../src/auth");
const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error('Give a password of 10+ characters:  npm run hash-password -- "my long password"');
  process.exit(1);
}
console.log("ADMIN_PASSWORD_HASH=" + hashPassword(pw));
