const {firebase} = require('../lib/firebase');
const {createService} = require('../lib/service');
const {createHandler} = require('../lib/http');
module.exports = createHandler(firebase, createService);
