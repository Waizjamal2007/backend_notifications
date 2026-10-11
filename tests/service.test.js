const {test, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let state, users, sent, calls;
const clone = (x) => x == null ? null : structuredClone(x);
const read = (path) => path.split('/').filter(Boolean).reduce((x, k) => x?.[k], state);
function write(path, value) {
  const keys = path.split('/').filter(Boolean);
  if (!keys.length) {state = clone(value); return;}
  let node = state;
  for (const k of keys.slice(0, -1)) node = node[k] ||= {};
  if (value === null) delete node[keys.at(-1)]; else node[keys.at(-1)] = clone(value);
}
function snapshot(value) {return {val: () => clone(value), exists: () => value != null, child: (path) => snapshot(path.split('/').reduce((x,k)=>x?.[k], value))};}
const db = {ref(path = '') {return {
  key: path.split('/').at(-1),
  orderByChild() {return this;}, equalTo() {return this;}, limitToFirst() {return this;},
  push() {return db.ref(`${path}/id${++calls}`);},
  async get() {return snapshot(read(path));},
  async set(v) {write(path, v);},
  async remove() {write(path, null);},
  async update(values) {for (const [k, v] of Object.entries(values)) write(path ? `${path}/${k}` : k, v);},
  async transaction(fn) {
    const result = fn(clone(read(path)));
    if (result !== undefined) write(path, result);
    return {committed: result !== undefined, snapshot: snapshot(read(path))};
  },
};}};
class HttpsError extends Error {constructor(code, message) {super(message); this.code = code;}}
const auth = {
  async getUser(uid) {if (!users[uid]) {const e = Error('Not found'); e.code = 'auth/user-not-found'; throw e;} return clone(users[uid]);},
  async updateUser(uid, data) {Object.assign(users[uid], data);},
  async revokeRefreshTokens(uid) {users[uid].revoked = true;},
  async deleteUser(uid) {delete users[uid];},
};
const {createService} = require('../lib/service');
let api;
beforeEach(() => {
  calls = 0; sent = [];
  users = {reader: {uid: 'reader', emailVerified: true, disabled: false},
    admin: {uid: 'admin', emailVerified: true, customClaims: {admin: true}}};
  api = createService({db, auth, messaging: {async send(m) {sent.push(m);}, async sendEachForMulticast(m) {sent.push(m); return {responses:m.tokens.map(()=>({success:true}))};}}});
  state = {books: {book: {title: 'Book', author: 'Author', price: 19.99, stock: 5}},
    users: {reader: {name: 'Reader'}}, carts: {reader: {book: 2}}};
});

const call = (action, uid, data) => api.execute(action, users[uid], data);
test('checkout computes trusted price/tax, reserves stock, sends owner push', async () => {
  state.deviceTokens = {reader: {own: {}}, another: {other: {}}};
  const result = await call('createOrder', 'reader', {requestId: 'request1', total: 1, userId: 'attacker', items: [{bookId:'book',qty:2,price:0.01}]});
  const order = state.orders[result.orderId];
  assert.equal(order.userId,'reader'); assert.equal(order.total,43.18);
  assert.equal(state.books.book.stock,3); assert.equal(state.carts.reader,undefined);
  assert.deepEqual(sent[0].tokens,['own']); assert.equal(sent[0].data.userId,'reader');
});
test('checkout retry with same request ID does not double reserve stock/order/push', async () => {
  const data = {requestId:'request1',items:[{bookId:'book',qty:2}]};
  const a = await call('createOrder','reader',data); const b = await call('createOrder','reader',data);
  assert.equal(a.orderId,b.orderId); assert.equal(state.books.book.stock,3); assert.equal(Object.keys(state.orders).length,1);
});
test('checkout rejects reuse of ID with changed items', async () => {
  await call('createOrder','reader',{requestId:'request1',items:[{bookId:'book',qty:2}]});
  await assert.rejects(call('createOrder','reader',{requestId:'request1',items:[{bookId:'book',qty:1}]}),{status:409});
});
test('invalid quantities and stock reject atomically', async () => {
  const original=clone(state);
  await assert.rejects(call('createOrder','reader',{requestId:'r',items:[{bookId:'book',qty:6}]}),{status:409});
  assert.deepEqual(state,original);
  await assert.rejects(call('createOrder','reader',{requestId:'r',items:[{bookId:'book',qty:-1}]}),{status:400});
});
test('non-admin cannot edit users, broadcast or change book/status', async () => {
  for (const action of ['manageUser','sendAnnouncement','saveBook','deleteBook','updateOrderStatus','retryNotifications']) {
    await assert.rejects(call(action,'reader',{}),{status:403});
  }
});
test('admin disables Auth account and database access, protects self', async () => {
  await call('manageUser','admin',{uid:'reader',action:'disable'});
  assert.equal(users.reader.disabled,true); assert.equal(users.reader.revoked,true); assert.equal(state.users.reader.disabled,true);
  await assert.rejects(call('manageUser','admin',{uid:'admin',action:'disable'}),{status:403});
});
test('admin profile edits sync Auth and database', async () => {
  await call('manageUser','admin',{uid:'reader',action:'edit',name:'New Name',shippingAddress:'Karachi',paymentMethod:'COD'});
  assert.equal(users.reader.displayName,'New Name'); assert.equal(state.users.reader.name,'New Name');
});
test('delete removes account and private data, keeps order history', async () => {
  state.orders={old:{userId:'reader'}};
  await call('manageUser','admin',{uid:'reader',action:'delete'});
  assert.equal(users.reader,undefined); assert.equal(state.users.reader,undefined); assert.ok(state.orders.old);
});
test('book API saves author and sends public topic; rejects duplicate IDs', async () => {
  const book={title:'New',author:'Author',genre:'Fiction',description:'',imageUrl:'',price:10,rating:4,stock:2,year:2026};
  await call('saveBook','admin',{id:'new',mode:'add',book});
  assert.equal(state.books.new.author,'Author'); assert.equal(sent[0].topic,'athenaeum_readers'); assert.ok(state.announcements);
  await assert.rejects(call('saveBook','admin',{id:'new',mode:'add',book}),{status:409});
});
test('delete book writes an inbox entry and push', async () => {
  await call('deleteBook','admin',{id:'book'});
  assert.equal(state.books.book,undefined); assert.equal(sent[0].topic,'athenaeum_readers');
});
test('order status update targets owner only; unchanged status does not send again', async () => {
  state.orders={o:{userId:'reader',status:'Placed'}}; state.deviceTokens={reader:{own:{}},another:{other:{}}};
  await call('updateOrderStatus','admin',{orderId:'o',status:'Delivered'});
  assert.equal(state.orders.o.status,'Delivered'); assert.deepEqual(sent[0].tokens,['own']);
  await call('updateOrderStatus','admin',{orderId:'o',status:'Delivered'}); assert.equal(sent.length,1);
});
test('push failure preserves successful mutation and queues retry', async () => {
  api=createService({db,auth,messaging:{async send(){throw Error('offline');}}});
  const result=await call('sendAnnouncement','admin',{title:'News',body:'Hello'});
  assert.equal(result.push,'pending'); assert.ok(state.announcements[result.id]); assert.ok(state.pushQueue[result.id]);
});
test('review likes are deduplicated', async () => {
  state.reviews={book:{r:{likes:0}}};
  await call('likeReview','reader',{bookId:'book',reviewId:'r'});
  await call('likeReview','reader',{bookId:'book',reviewId:'r'}); assert.equal(state.reviews.book.r.likes,1);
});
const {createHandler}=require('../lib/http');
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.code=s;return this;},json(j){this.body=j;return this;},end(){return this;}};}
test('HTTP rejects missing Bearer token and invalid method', async () => {
  const handler=createHandler(()=>({auth,db}),createService);
  const res=response(); await handler({method:'POST',headers:{'content-type':'application/json'},body:{}},res); assert.equal(res.code,401);
  const res2=response();await handler({method:'GET',headers:{}},res2);assert.equal(res2.code,405);
});
test('HTTP verifies revoked tokens and blocks disabled or unverified users', async () => {
  let checked=false;auth.verifyIdToken=async(_,check)=>{checked=check;return {uid:'reader'};};
  const handler=createHandler(()=>({auth,db}),createService);
  users.reader.emailVerified=false;
  const res=response();await handler({method:'POST',headers:{'content-type':'application/json',authorization:'Bearer token'},body:{action:'likeReview'}},res);
  assert.equal(checked,true);assert.equal(res.code,403);
  users.reader.emailVerified=true;state.users.reader.disabled=true;
  const res2=response();await handler({method:'POST',headers:{'content-type':'application/json',authorization:'Bearer token'},body:{action:'likeReview'}},res2);assert.equal(res2.code,403);
});
