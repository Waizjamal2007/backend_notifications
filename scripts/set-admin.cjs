const fs = require('node:fs');
const {initializeApp, cert} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getDatabase} = require('firebase-admin/database');
(async () => {
  const [email, keyPath] = process.argv.slice(2);
  if (!email || !keyPath) throw new Error('Usage: npm run set-admin -- ADMIN_EMAIL C:\\private\\service-account.json');
  const credential = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  initializeApp({credential: cert(credential), databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://athenaeum-8845d-default-rtdb.firebaseio.com'});
  const user = await getAuth().getUserByEmail(email);
  if (!user.emailVerified || user.disabled) throw new Error('Verify and enable the admin account first.');
  await getAuth().setCustomUserClaims(user.uid, {...user.customClaims, admin: true});
  await getDatabase().ref(`users/${user.uid}`).update({name: user.displayName || 'Administrator', email: user.email, disabled: false});
  console.log('Admin assigned. Sign out and sign in again.');
})().catch((error) => {console.error(error.message); process.exitCode = 1;});
