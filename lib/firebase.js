'use strict';
const {initializeApp, getApps, cert} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getDatabase} = require('firebase-admin/database');
const {getMessaging} = require('firebase-admin/messaging');
function firebase() {
  if (!getApps().length) {
    let credential;
    try { credential = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''); }
    catch (_) { throw new Error('Missing/invalid FIREBASE_SERVICE_ACCOUNT_JSON.'); }
    credential.private_key = credential.private_key?.replace(/\\n/g, '\n');
    initializeApp({credential: cert(credential), databaseURL: process.env.FIREBASE_DATABASE_URL ||
      'https://athenaeum-8845d-default-rtdb.firebaseio.com'});
  }
  return {auth: getAuth(), db: getDatabase(), messaging: getMessaging()};
}
module.exports = {firebase};
